import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { copyBenchmarkWorkspace, loadBenchmarkTasks } from '../dist/benchmarks/pack.js';
import { Controller } from '../dist/core/controller.js';
import { SecretVault, redact } from '../dist/core/secrets.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const model = option('--model', 'openai/gpt-oss-120b');
const harnesses = option('--harnesses', 'polonrlm,opencode,qwen').split(',').map(value => value.trim()).filter(Boolean);
const taskIds = option('--tasks', 'retry-status,group-by,merge-intervals').split(',').map(value => value.trim()).filter(Boolean);
const timeoutMs = Math.max(60_000, Math.min(900_000, Number(option('--timeout-ms', '600000'))));
const reportPath = path.resolve(option('--report', 'docs/harness-live-report.json'));
const qwenBin = option('--qwen-bin', process.env.QWEN_BIN ?? path.join(tmpdir(), 'qwen-code-audit', 'node_modules', '.bin', 'qwen.cmd'));
const opencodeBin = option('--opencode-bin', process.env.OPENCODE_BIN ?? (process.platform === 'win32' ? 'opencode.cmd' : 'opencode'));
const key = process.env.GROQ_API_KEY;
if (!key) throw new Error('Set GROQ_API_KEY for the live harness comparison.');

const provider = { id: 'groq', kind: 'compatible', baseURL: 'https://api.groq.com/openai/v1', model, apiKeyEnv: 'GROQ_API_KEY', contextWindow: 131072, maxOutputTokens: 1024, reasoning: 'low', reasoningControl: 'effort' };
const taskPrompt = task => `${task.prompt}\n\nWork directly in this workspace now. Use the file tools to inspect and edit the project. Do not print the full solution instead of editing. Run a relevant local command if useful.`;

async function gradeTask(task, workspace) {
  const grader = await import(pathToFileURL(task.grader).href + `?compare=${Date.now()}-${Math.random()}`);
  return grader.grade(workspace);
}

async function runPolonRLM(task, workspace, home) {
  const vault = new SecretVault(home);
  await vault.set('groq', key);
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  let controller;
  try {
    controller = await Controller.open(workspace, home, {
      provider: 'groq', providers: { groq: provider }, cortex: 0, maxSteps: 40, maxOutputTokens: 0,
      timeoutMs, permissions: 'workspace', verificationMode: 'manual',
      toolPermissions: { read_file: 'auto', write_file: 'auto', edit_file: 'auto', delete_file: 'auto', apply_patch: 'auto', execute_command: 'auto', run_tests: 'auto', list_directory: 'auto', search_files: 'auto', search_content: 'auto' },
    });
    controller.setApprover(async () => true);
    const events = [];
    controller.onEvent = event => {
      if (event.type === 'status' || event.type === 'error') events.push(`${event.type}: ${event.text ?? ''}`.slice(0, 500));
    };
    const started = Date.now();
    await controller.submit(taskPrompt(task));
    const snapshot = controller.snapshot();
    const usage = snapshot.taskUsage;
    return { durationMs: Date.now() - started, usage, output: snapshot.messages.filter(message => message.role === 'assistant').at(-1)?.text ?? '', tools: snapshot.messages.filter(message => message.role === 'tool').map(message => ({ name: message.toolName, state: message.toolState, output: (message.toolOutput ?? '').slice(0, 800) })), events: events.slice(-20), messages: snapshot.messages.slice(-20).map(message => ({ role: message.role, toolName: message.toolName, text: (message.text ?? '').slice(0, 500), toolOutput: (message.toolOutput ?? '').slice(0, 500) })) };
  } finally {
    if (controller) await controller.close().catch(() => {});
    if (saved) process.env.GROQ_API_KEY = saved;
  }
}

async function runOpenCode(task, workspace) {
  const started = Date.now();
  const result = await execa(opencodeBin, ['run', '--standalone', '--model', `groq/${model}`], {
    cwd: workspace, env: { ...process.env, GROQ_API_KEY: key }, input: taskPrompt(task), timeout: timeoutMs, reject: false, windowsHide: true,
  });
  return { durationMs: Date.now() - started, exitCode: result.exitCode, timedOut: result.timedOut, output: `${result.stdout}\n${result.stderr}`.trim() };
}

async function runQwen(task, workspace) {
  const exclude = 'read_mcp_resource,zoom_image,cron_list,cron_delete,autofix_pr,tool_search,tool_call,list_agents,task_stop,enter_worktree,exit_worktree,record_artifact,get_goal,update_goal,send_message,report_findings,cron_create,loop_wakeup,manage_memory,search_memory,skill,web_fetch,notebook_edit,agent';
  const started = Date.now();
  const result = await execa(qwenBin, ['--model', model, '--auth-type', 'openai', '--safe-mode', '--output-format', 'json', '--approval-mode', 'auto-edit', '--max-wall-time', `${Math.ceil(timeoutMs / 1000)}s`, '--exclude-tools', exclude], {
    cwd: workspace, env: { ...process.env, OPENAI_API_KEY: key, OPENAI_BASE_URL: 'https://api.groq.com/openai/v1' }, input: taskPrompt(task), timeout: timeoutMs, reject: false, windowsHide: true,
  });
  return { durationMs: Date.now() - started, exitCode: result.exitCode, timedOut: result.timedOut, output: `${result.stdout}\n${result.stderr}`.trim() };
}

const report = { date: new Date().toISOString(), model, tasks: [], results: [] };
const root = await mkdtemp(path.join(tmpdir(), 'polonrlm-harness-compare-'));
try {
  const pack = path.resolve('benchmarks/default');
  for (const taskId of taskIds) {
    const [task] = await loadBenchmarkTasks(pack, taskId);
    if (!task) throw new Error(`Unknown benchmark task: ${taskId}`);
    report.tasks.push({ id: task.id, title: task.title });
    for (const harness of harnesses) {
      const workspace = path.join(root, `${task.id}-${harness}`);
      const result = { task: task.id, harness, status: 'FAIL' };
      try {
        await copyBenchmarkWorkspace(task.workspace, workspace);
        const started = Date.now();
        if (harness === 'polonrlm') {
          const run = await runPolonRLM(task, workspace, path.join(root, `${task.id}-${harness}-home`));
          Object.assign(result, { durationMs: run.durationMs, usage: run.usage, tools: run.tools, events: run.events, messages: run.messages, output: run.output.slice(-2000) });
        } else if (harness === 'opencode') {
          const run = await runOpenCode(task, workspace);
          Object.assign(result, run, { output: run.output.slice(-2000) });
        } else if (harness === 'qwen') {
          const run = await runQwen(task, workspace);
          Object.assign(result, run, { output: run.output.slice(-2000) });
        } else {
          throw new Error(`Unknown harness: ${harness}`);
        }
        const graded = await gradeTask(task, workspace);
        result.passed = graded?.passed === true;
        result.summary = graded?.summary ?? '';
        result.status = result.passed ? 'PASS' : 'FAIL';
        if (result.durationMs === undefined) result.durationMs = Date.now() - started;
      } catch (error) {
        result.error = redact(error instanceof Error ? error.message : String(error));
      }
      report.results.push(result);
      console.log(`${harness}/${task.id}: ${result.status}${result.error ? ` — ${result.error}` : ''}`);
    }
  }
} finally {
  await mkdir(path.dirname(reportPath), { recursive: true }).catch(() => {});
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
}
console.log(JSON.stringify({ reportPath, results: report.results.map(({ task, harness, status, durationMs, passed }) => ({ task, harness, status, durationMs, passed })) }));
if (report.results.some(result => result.status === 'FAIL' && result.harness === 'polonrlm')) process.exitCode = 1;
