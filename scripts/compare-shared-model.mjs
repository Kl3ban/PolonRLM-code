import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { DatabaseSync } from 'node:sqlite';
import { Controller } from '../dist/core/controller.js';
import { SecretVault, redact } from '../dist/core/secrets.js';
import { copyBenchmarkWorkspace, loadBenchmarkTasks } from '../dist/benchmarks/pack.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const provider = option('--provider', 'openrouter');
const model = option('--model', provider === 'openrouter' ? 'nvidia/nemotron-3.5-lightning:free' : '');
if (!model) throw new Error('Use --model <id>.');
const baseURL = option('--base-url', provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : provider === 'nvidia' ? 'https://integrate.api.nvidia.com/v1' : '');
if (!baseURL) throw new Error('Use --base-url <url> for this provider.');
const keyEnv = option('--key-env', provider === 'openrouter' ? 'OPENROUTER_API_KEY' : provider === 'nvidia' ? 'NVIDIA_API_KEY' : '');
const tasks = option('--tasks', 'retry-status,group-by,merge-intervals').split(',').map(value => value.trim()).filter(Boolean);
const timeoutMs = Math.max(60_000, Math.min(900_000, Number(option('--timeout-ms', '300000'))));
const reportPath = path.resolve(option('--report', 'docs/harness-shared-report.json'));
const opencodeBin = option('--opencode-bin', process.env.OPENCODE_BIN ?? (process.platform === 'win32' ? 'opencode.cmd' : 'opencode'));
const opencodeModel = option('--opencode-model', provider === 'openrouter' ? `openrouter/${model}` : `${provider}/${model}`);
const defaultHome = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '.', '.local', 'share'), 'PolonRLM');

function opencodeCredential(integration) {
  try {
    const file = path.join(process.env.USERPROFILE ?? '', '.local', 'share', 'opencode', 'opencode.db');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare('select value from credential where integration_id = ? and active = 1 order by time_updated desc limit 1').get(integration);
      if (!row?.value) return undefined;
      const parsed = JSON.parse(row.value);
      return typeof parsed?.key === 'string' ? parsed.key : undefined;
    } finally { db.close(); }
  } catch { return undefined; }
}

let key = keyEnv ? process.env[keyEnv] : undefined;
if (!key) key = await new SecretVault(defaultHome).get(provider);
if (!key && provider === 'nvidia') key = opencodeCredential('nvidia');
if (!key) throw new Error(`No key available for ${provider}; set ${keyEnv || 'the provider key in the PolonRLM vault'}.`);

const promptFor = task => `${task.prompt}\n\nWork directly in this workspace now. Use the file tools to inspect and edit the project. Do not print the full solution instead of editing. Run a relevant local command if useful.`;
const grade = async (task, workspace) => (await import(`${pathToFileURL(task.grader).href}?compare=${Date.now()}-${Math.random()}`)).grade(workspace);

const report = { date: new Date().toISOString(), provider, model, opencodeModel, tasks: [], results: [] };
const root = await mkdtemp(path.join(tmpdir(), 'polonrlm-shared-bench-'));
try {
  const pack = path.resolve('benchmarks/default');
  for (const taskId of tasks) {
    const [task] = await loadBenchmarkTasks(pack, taskId);
    if (!task) throw new Error(`Unknown benchmark task: ${taskId}`);
    report.tasks.push({ id: task.id, title: task.title });
    for (const harness of ['polonrlm', 'opencode']) {
      const workspace = path.join(root, `${task.id}-${harness}`);
      const result = { task: task.id, harness, status: 'FAIL' };
      const started = Date.now();
      try {
        await copyBenchmarkWorkspace(task.workspace, workspace);
        if (harness === 'polonrlm') {
          const home = path.join(root, `${task.id}-${harness}-home`);
          await new SecretVault(home).set(provider, key);
          const controller = await Controller.open(workspace, home, {
            provider, providers: { [provider]: { id: provider, kind: 'compatible', baseURL, model } },
            cortex: 0, maxSteps: 40, maxOutputTokens: 8192, timeoutMs, permissions: 'workspace', sandboxMode: 'off', verificationMode: 'manual',
            toolPermissions: { read_file: 'auto', write_file: 'auto', edit_file: 'auto', list_directory: 'auto', search_files: 'auto', search_content: 'auto', execute_command: 'auto', run_tests: 'auto' },
          });
          controller.setApprover(async () => true);
          try { await controller.submit(promptFor(task)); }
          finally { await controller.close(); }
        } else {
          const run = await execa(opencodeBin, ['run', '--standalone', '--model', opencodeModel], { cwd: workspace, env: { ...process.env, ...(keyEnv ? { [keyEnv]: key } : {}) }, input: promptFor(task), timeout: timeoutMs, reject: false, windowsHide: true });
          result.exitCode = run.exitCode; result.timedOut = run.timedOut; result.output = redact(`${run.stdout}\n${run.stderr}`).slice(-1_000);
        }
        const graded = await grade(task, workspace);
        result.passed = graded?.passed === true;
        result.summary = graded?.summary ?? '';
        result.status = result.passed ? 'PASS' : 'FAIL';
      } catch (error) {
        result.error = redact(String(error?.message ?? error)).slice(0, 500);
      }
      result.durationMs = Date.now() - started;
      report.results.push(result);
      console.log(`${harness}/${task.id}: ${result.status} (${result.durationMs} ms)`);
    }
  }
} finally {
  await mkdir(path.dirname(reportPath), { recursive: true }).catch(() => {});
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
console.log(JSON.stringify({ reportPath, results: report.results.map(({ task, harness, status, durationMs }) => ({ task, harness, status, durationMs })) }));
