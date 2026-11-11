import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { ConfigManager } from './config.js';
import { Controller } from './controller.js';
import { redact, SecretVault, safeText } from './secrets.js';
import type { RuntimeEvent, Settings, Usage } from './types.js';
import { SandboxExecutor } from '../tools/sandbox.js';
import { VENDORED_SRT_WIN_EXE, resolveSrtWin } from '@anthropic-ai/sandbox-runtime';
import { copyBenchmarkWorkspace, loadBenchmarkTasks, parseGraderResult, syncBenchmarkSubmission, type BenchmarkTask } from '../benchmarks/pack.js';
import { benchmarkProfile, type BenchmarkProfileName } from '../benchmarks/profiles.js';
import { createBenchmarkMatrix, createProviderBenchmarkMatrix, executeBenchmarkMatrix } from '../benchmarks/matrix.js';
import { formatBenchmarkComparison, loadBenchmarkReports } from '../benchmarks/reports.js';

export interface AgentBenchmarkOptions { provider?: string; model?: string; caseId?: string; taskPack?: string; profile?: BenchmarkProfileName }
export interface AgentBenchmarkMatrixOptions { provider?: string; models?: string; targets?: string; profiles?: string; caseId?: string; taskPack?: string }
export interface AgentBenchmarkResult { reportPath: string; status: BenchmarkReport['status'] }
interface BenchmarkCaseResult {
  id: string;
  title: string;
  status: 'passed' | 'failed' | 'error';
  agentStatus: string;
  durationMs: number;
  gradeDurationMs: number;
  checks: string;
  toolCalls: number;
  toolErrors: number;
  tools: string[];
  usage: Usage;
}
interface BenchmarkReport {
  version: 2;
  status: 'running' | 'complete' | 'stopped' | 'error' | 'cleanup-error';
  startedAt: string;
  updatedAt: string;
  provider: string;
  model: string;
  taskPack: string;
  profile: BenchmarkProfileName;
  cortex: number;
  cortexStrategy: 'adaptive' | 'fixed';
  maxAgents: number;
  maxDepth: number;
  sandbox: 'required';
  subagents: 'disabled' | 'enabled';
  cases: BenchmarkCaseResult[];
  error?: string;
  cleanupWarning?: string;
}

const BENCH_KEY_ENV = 'POLONRLM_BENCHMARK_API_KEY';
const SAFE_TOOLS = [
  'discover_tools',
  'project_map', 'delegate', 'agent_message', 'agent_changes', 'agent_apply',
  'read_file', 'list_directory', 'write_file', 'edit_file', 'delete_file', 'apply_patch', 'search_files', 'search_content',
  'inspect_project', 'detect_project_type', 'analyze_dependencies', 'execute_command', 'execute_powershell', 'run_tests', 'inspect_errors', 'execute_python',
  'git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'plan_update', 'plan_status',
  'transaction_begin', 'transaction_status', 'transaction_commit', 'transaction_rollback', 'read_files', 'search_batch',
  'checkpoint_create', 'checkpoint_list', 'checkpoint_diff', 'checkpoint_restore', 'checkpoint_drop',
  'process_start', 'process_list', 'process_output', 'process_wait', 'process_input', 'process_stop',
  'code_diagnostics', 'code_diagnostics_batch', 'symbol_definition', 'symbol_references', 'symbol_hover', 'rename_symbol', 'code_outline', 'ast_search', 'ast_edit', 'lsp_request',
];
const SAFE_TOOL_SET = new Set(SAFE_TOOLS);
const SAFE_APPROVALS = new Set(['write_file', 'edit_file', 'delete_file', 'apply_patch', 'execute_command', 'execute_powershell', 'run_tests', 'inspect_errors', 'execute_python', 'transaction_begin', 'transaction_commit', 'transaction_rollback', 'checkpoint_restore', 'process_start', 'process_input', 'process_stop', 'rename_symbol', 'ast_edit', 'git_commit', 'delegate', 'agent_message', 'agent_changes', 'agent_apply']);
const GRADER_RUNNER = `
import { pathToFileURL } from 'node:url';
const graderPath = process.argv[2];
const submissionPath = process.argv[3];
try {
  const grader = await import(pathToFileURL(graderPath).href);
  if (typeof grader.grade !== 'function') throw new Error('grader.mjs must export async function grade(workspacePath)');
  const result = await grader.grade(submissionPath);
  if (!result || typeof result.passed !== 'boolean' || typeof result.summary !== 'string') throw new Error('grade() must return { passed: boolean, summary: string }');
  console.log(JSON.stringify({ passed: result.passed, summary: result.summary.slice(0, 500) }));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.log(JSON.stringify({ passed: false, summary: 'grader execution failed' }));
  process.exitCode = 2;
}
`;

function packageRoot(): string { return path.resolve(import.meta.dirname, '..', '..'); }
function localModel(provider: { id: string; baseURL: string }): boolean {
  return ['ollama', 'lmstudio', 'vllm'].includes(provider.id) || /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/)/i.test(provider.baseURL);
}
function zeroUsage(): Usage { return { input: 0, output: 0, cached: 0, cost: 0, costKnown: true }; }
function sumUsage(results: BenchmarkCaseResult[]): Usage {
  return results.reduce((total, item) => ({ input: total.input + item.usage.input, output: total.output + item.usage.output,
    cached: total.cached + item.usage.cached, cost: total.cost + item.usage.cost, costKnown: total.costKnown && item.usage.costKnown }), zeroUsage());
}
function shortError(error: unknown): string {
  return safeText(redact(error instanceof Error ? error.message : String(error))).replace(/\s+/g, ' ').slice(0, 500);
}
function isLikelyProviderFailure(message: string): boolean {
  return /(?:missing.{0,20}api key|(?:HTTP\s*)?(?:401|402|403|408|429|5\d\d)\b|rate.?limit|provider.{0,20}(?:failed|error)|fetch failed|ECONN(?:RESET|REFUSED|TIMEDOUT)|network.{0,12}(?:error|failed)|request timed out)/i.test(message);
}
async function runSandboxedCommand(settings: Settings, sandboxRoot: string, command: string, args: string[], timeoutMs: number, onSandboxed?: () => void): Promise<{ stdout: string; stderr: string; exitCode: number | null; durationMs: number; sandboxed: boolean }> {
  const sandbox = new SandboxExecutor(settings, sandboxRoot);
  const signal = AbortSignal.timeout(timeoutMs);
  const started = Date.now();
  let prepared: Awaited<ReturnType<SandboxExecutor['prepare']>> | undefined;
  try {
    prepared = await sandbox.prepare(command, args, sandboxRoot, signal);
    if (!prepared.sandboxed) throw new Error('Required OS isolation was not applied; the benchmark command was not run.');
    onSandboxed?.();
    try {
      const result = await execa(prepared.command, prepared.args, { cwd: sandboxRoot, env: prepared.env, signal, windowsHide: true, maxBuffer: 1024 * 1024 });
      return { stdout: result.stdout, stderr: prepared.annotate(result.stderr), exitCode: result.exitCode ?? 0, durationMs: Date.now() - started, sandboxed: true };
    } catch (error: any) {
      if (signal.aborted) throw new Error(`Sandboxed command timed out after ${timeoutMs}ms.`);
      return { stdout: typeof error.stdout === 'string' ? error.stdout : '', stderr: prepared.annotate(typeof error.stderr === 'string' ? error.stderr : ''), exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null, durationMs: Date.now() - started, sandboxed: true };
    }
  } finally {
    try { await prepared?.cleanup(); }
    finally { await sandbox.close(); }
  }
}

async function runSandboxedNode(settings: Settings, sandboxRoot: string, script: string, args: string[], timeoutMs: number, onSandboxed?: () => void) {
  return runSandboxedCommand(settings, sandboxRoot, process.execPath, [script, ...args], timeoutMs, onSandboxed);
}

async function forgetWindowsGrants(roots: string[]): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const srtWin = resolveSrtWin({ path: VENDORED_SRT_WIN_EXE });
  const failures: string[] = [];
  const grantRoots = new Set<string>();
  for (const root of roots) {
    const tempGrantRoot = path.join(root, '.polonrlm', 'sandbox-tmp');
    try {
      const info = await lstat(tempGrantRoot);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        // Windows keeps every allowWrite root, including this per-sandbox temp.
        grantRoots.add(root);
        grantRoots.add(tempGrantRoot);
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') failures.push(`${tempGrantRoot}: ${shortError(error)}`);
    }
  }
  for (const root of grantRoots) {
    try { await execa(srtWin.exe, [...srtWin.prependArgs, 'acl', 'forget', root], { timeout: 30_000, windowsHide: true }); }
    catch (error) { failures.push(`${root}: ${shortError(error)}`); }
  }
  return failures;
}

export async function runAgentBenchmark(options: AgentBenchmarkOptions = {}): Promise<AgentBenchmarkResult> {
  const profile = benchmarkProfile(options.profile);
  const sourceConfig = new ConfigManager();
  await sourceConfig.load();
  const providerId = options.provider ?? sourceConfig.settings.provider;
  const sourceProvider = sourceConfig.settings.providers[providerId];
  if (!sourceProvider) throw new Error(`Unknown provider ${providerId}. Configure it first with /connect.`);
  const model = options.model?.trim() || sourceProvider.model;
  if (!model) throw new Error(`No model is configured for ${providerId}. Pass --model <id> or select one in PolonRLM.`);

  const tasks = await loadBenchmarkTasks(options.taskPack ?? path.join(packageRoot(), 'benchmarks', 'default'), options.caseId);
  // Keep the private grader inside the user profile. Every benchmark command
  // denies profile reads and re-opens only its own workspace; using os.tmpdir()
  // here would leak the grader on machines whose TEMP points outside the profile.
  const suiteRoot = await import('node:fs/promises').then(fs => fs.mkdtemp(path.join(os.homedir(), '.polonrlm-benchmark-')));
  const reportDirectory = path.join(sourceConfig.home, 'benchmark-reports');
  const reportPath = path.join(reportDirectory, 'agent-benchmark-latest.json');
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[-:.]/g, '');
  const safePart = (value: string): string => value.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'unknown';
  const runReportPath = path.join(reportDirectory, 'runs', `${stamp}-${profile.name}-${safePart(providerId)}-${safePart(model)}-${randomUUID().slice(0, 8)}.json`);
  const report: BenchmarkReport = { version: 2, status: 'running', startedAt, updatedAt: startedAt, provider: providerId, model,
    taskPack: path.basename(path.resolve(options.taskPack ?? path.join(packageRoot(), 'benchmarks', 'default'))), profile: profile.name,
    ...profile.settings, sandbox: 'required', subagents: profile.subagents, cases: [] };
  const touchedSandboxRoots: string[] = [];
  let sandboxMayHavePersistentGrants = false;
  const priorKey = process.env[BENCH_KEY_ENV];
  let keyEnvironmentChanged = false;
  let stopAfterProviderFailure = false;

  const persistReport = async (): Promise<void> => {
    report.updatedAt = new Date().toISOString();
    const fs = await import('node:fs/promises');
    const data = JSON.stringify({ ...report, usage: sumUsage(report.cases) }, null, 2) + '\n';
    for (const target of [reportPath, runReportPath]) {
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, data, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
    }
  };

  try {
    const sourceKey = await new SecretVault(sourceConfig.home).get(providerId, sourceProvider.apiKeyEnv);
    if (!sourceKey && !localModel(sourceProvider)) throw new Error(`No API key is configured for ${providerId}. Set it in PolonRLM before running the benchmark.`);
    if (sourceKey) { process.env[BENCH_KEY_ENV] = sourceKey; keyEnvironmentChanged = true; }

    const isolatedHome = path.join(suiteRoot, 'config');
    const isolatedConfig = new ConfigManager(isolatedHome);
    await isolatedConfig.load();
    const isolatedProvider = { ...structuredClone(sourceProvider), model, ...(sourceKey ? { apiKeyEnv: BENCH_KEY_ENV } : {}) };
    const unsafeToolRules = Object.fromEntries(Object.keys(sourceConfig.settings.toolPermissions)
      .filter(name => !SAFE_TOOL_SET.has(name)).map(name => [name, 'off' as const]));
    const denied = new Set([...sourceConfig.settings.denyTools, ...Object.keys(unsafeToolRules)]);
    const allowed = SAFE_TOOLS.filter(name => !denied.has(name) && (!sourceConfig.settings.allowTools.length || sourceConfig.settings.allowTools.includes(name)));
    const overrides: Partial<Settings> = {
      ...structuredClone(sourceConfig.settings),
      provider: providerId,
      providers: { [providerId]: isolatedProvider },
      fallback: [],
      mode: 'BUILD',
      ...profile.settings,
      permissions: 'workspace',
      allowTools: allowed,
      denyTools: [...denied],
      toolPermissions: { ...sourceConfig.settings.toolPermissions, ...unsafeToolRules },
      // A profile measures one selected model, not saved role-specific routes.
      modelRoutes: {},
      modelRoleBudgets: {},
      mcp: {},
      sandboxMode: 'required',
      sandboxNetworkDomains: [],
    };
    Object.assign(isolatedConfig.settings, overrides);
    await isolatedConfig.save();

    const suites = [] as Array<{ task: BenchmarkTask; workspace: string; graderRoot: string; graderFile: string; runnerFile: string; setupSettings: Settings }>;
    for (const task of tasks) {
      const caseRoot = path.join(suiteRoot, task.id);
      const workspace = path.join(caseRoot, 'agent', 'workspace');
      const graderRoot = path.join(caseRoot, 'private-grader');
      await mkdir(path.dirname(workspace), { recursive: true });
      await mkdir(graderRoot, { recursive: true });
      await copyBenchmarkWorkspace(task.workspace, workspace);
      await copyBenchmarkWorkspace(task.workspace, path.join(graderRoot, 'submission'));
      touchedSandboxRoots.push(workspace, graderRoot);
      const graderFile = path.join(graderRoot, 'grader.mjs');
      const runnerFile = path.join(graderRoot, 'runner.mjs');
      const setupSettings = { ...structuredClone(isolatedConfig.settings), sandboxNetworkDomains: task.setup?.networkDomains ?? [] };
      await writeFile(graderFile, await readFile(task.grader));
      await writeFile(runnerFile, GRADER_RUNNER, 'utf8');

      for (const [root, label] of [[workspace, 'agent'], [graderRoot, 'grader']] as const) {
        const status = await new SandboxExecutor(isolatedConfig.settings, root).status(root);
        if (!status.available) throw new Error(`Required ${label} sandbox is unavailable for ${task.id} (${status.backend}): ${status.reason ?? 'unknown reason'}. No model request was sent.`);
      }
      suites.push({ task, workspace, graderRoot, graderFile, runnerFile, setupSettings });
    }

    // Optional dependency setup is trusted task-pack code. Run it in two fresh
    // copies before the first provider request, with only its declared domains.
    for (const suite of suites) {
      const setup = suite.task.setup;
      if (!setup) continue;
      for (const [root, label] of [[suite.workspace, 'agent'], [path.join(suite.graderRoot, 'submission'), 'grader']] as const) {
        console.log(`Preparing benchmark dependencies for ${suite.task.id} (${label})...`);
        const result = await runSandboxedCommand(suite.setupSettings, root, setup.command[0]!, setup.command.slice(1), setup.timeoutMs, () => { sandboxMayHavePersistentGrants = true; });
        sandboxMayHavePersistentGrants ||= result.sandboxed;
        if (result.exitCode !== 0) {
          const details = safeText(redact(result.stderr || result.stdout)).replace(/\s+/g, ' ').slice(-500);
          throw new Error(`Dependency setup failed for ${suite.task.id} (${label}) with exit code ${result.exitCode ?? 'unknown'}${details ? `: ${details}` : '.'}`);
        }
      }
    }

    for (const suite of suites) {
      const baseline = await runSandboxedNode(isolatedConfig.settings, suite.graderRoot, suite.runnerFile, [suite.graderFile, path.join(suite.graderRoot, 'submission')], 30_000, () => { sandboxMayHavePersistentGrants = true; });
      sandboxMayHavePersistentGrants ||= baseline.sandboxed;
      if (baseline.exitCode === 2 || baseline.exitCode === null) throw new Error(`Hidden grader for ${suite.task.id} failed before the agent run: ${safeText(redact(baseline.stderr)).slice(0, 300)}`);
      const result = parseGraderResult(baseline.stdout, baseline.exitCode);
      if (result.passed) throw new Error(`Benchmark case ${suite.task.id} already passes on its starter files; refusing to count it as an agent success.`);
    }

    const requiredTools = ['read_file', 'write_file', 'edit_file', 'execute_command', 'run_tests', ...(profile.subagents === 'enabled' ? ['delegate', 'agent_changes', 'agent_apply'] : [])];
    const missingTools = requiredTools.filter(name => !allowed.includes(name));
    const explicitlyDisabledTools = requiredTools.filter(name => sourceConfig.settings.toolPermissions[name] === 'off');
    const unavailableTools = [...new Set([...missingTools, ...explicitlyDisabledTools])];
    if (unavailableTools.length) throw new Error(`Your current tool restrictions disable required benchmark tools: ${unavailableTools.join(', ')}. Update /permissions or /settings, then try again.`);

    console.log(`Benchmark · ${providerId}/${model} · ${profile.name} profile · ${tasks.length} task${tasks.length === 1 ? '' : 's'} · required OS sandbox`);
    console.log('This sends real requests to the configured model. Use --case <id> to run one task.');
    for (const suite of suites) {
      const taskStarted = Date.now();
      const toolNames = new Set<string>();
      let toolCalls = 0;
      let toolErrors = 0;
      let controller: Controller | undefined;
      let controllerError = '';
      try {
        touchedSandboxRoots.push(suite.workspace, suite.graderRoot);
        sandboxMayHavePersistentGrants = true;
        controller = await Controller.open(suite.workspace, isolatedHome, overrides);
        controller.setApprover(async request => SAFE_APPROVALS.has(request.tool) && allowed.includes(request.tool));
        controller.onEvent = (event: RuntimeEvent) => {
          if (event.type === 'tool' && event.state && event.state !== 'running') {
            toolCalls++;
            if (event.name) toolNames.add(event.name);
            if (event.state === 'error') toolErrors++;
          }
        };
        const taskTimer = setTimeout(() => controller?.cancel(), suite.task.timeoutMs);
        try { await controller.submit(suite.task.prompt); }
        finally { clearTimeout(taskTimer); }
        const finalState = controller.snapshot();
        if (finalState.status === 'Error' || finalState.status === 'Cancelled') {
          controllerError = finalState.messages.filter(message => message.role === 'error').at(-1)?.text ?? finalState.status;
        }
        await controller.close();
        controller = undefined;

        const submission = path.join(suite.graderRoot, 'submission');
        await syncBenchmarkSubmission(suite.workspace, submission);
        const graded = await runSandboxedNode(isolatedConfig.settings, suite.graderRoot, suite.runnerFile, [suite.graderFile, submission], 60_000, () => { sandboxMayHavePersistentGrants = true; });
        sandboxMayHavePersistentGrants ||= graded.sandboxed;
        if (graded.exitCode === 2 || graded.exitCode === null) throw new Error(`Hidden grader failed for ${suite.task.id}: ${safeText(redact(graded.stderr)).slice(0, 300)}`);
        const grade = parseGraderResult(graded.stdout, graded.exitCode);
        const usage = finalState.usage;
        report.cases.push({ id: suite.task.id, title: suite.task.title, status: grade.passed ? 'passed' : controllerError ? 'error' : 'failed',
          agentStatus: finalState.status, durationMs: Date.now() - taskStarted, gradeDurationMs: graded.durationMs, checks: grade.summary,
          toolCalls, toolErrors, tools: [...toolNames].sort(), usage: { input: usage.input, output: usage.output, cached: usage.cached, cost: usage.cost, costKnown: usage.costKnown } });
        await persistReport();
        const resultLabel = grade.passed ? 'PASS' : controllerError ? 'ERROR' : 'FAIL';
        console.log(`${resultLabel} ${suite.task.id} · ${grade.summary} · ${((Date.now() - taskStarted) / 1000).toFixed(1)}s · ${usage.input + usage.output} tokens`);
        if (controllerError && isLikelyProviderFailure(controllerError)) {
          report.status = 'stopped';
          report.error = 'The provider request failed. Remaining cases were not sent.';
          stopAfterProviderFailure = true;
          break;
        }
      } finally {
        await controller?.close().catch(() => {});
      }
    }
    if (!stopAfterProviderFailure) report.status = 'complete';
  } catch (error) {
    report.status = 'error';
    report.error = shortError(error);
    throw error;
  } finally {
    try {
      const cleanupFailures = sandboxMayHavePersistentGrants ? await forgetWindowsGrants([...new Set(touchedSandboxRoots)]) : [];
      if (cleanupFailures.length) {
        report.status = 'cleanup-error';
        report.cleanupWarning = `Windows sandbox grants could not be removed. Temporary files are preserved at ${suiteRoot}. ${cleanupFailures.join(' | ')}`;
      } else {
        await rm(suiteRoot, { recursive: true, force: true });
      }
      await persistReport().catch(error => { report.error ??= `Could not save the local report: ${shortError(error)}`; });
    } catch (cleanupError) {
      report.status = 'cleanup-error';
      report.cleanupWarning = shortError(cleanupError);
      await persistReport().catch(() => {});
    } finally {
      if (keyEnvironmentChanged) {
        if (priorKey === undefined) delete process.env[BENCH_KEY_ENV];
        else process.env[BENCH_KEY_ENV] = priorKey;
      }
    }
  }

  const total = report.cases.length;
  const passed = report.cases.filter(item => item.status === 'passed').length;
  const usage = sumUsage(report.cases);
  console.log(`Benchmark ${report.status} · ${passed}/${total} passed · ${usage.input + usage.output} tokens · ${usage.costKnown ? `$${usage.cost.toFixed(5)}` : 'cost unknown'}`);
  console.log(`Local report: ${reportPath}`);
  console.log(`Run archive: ${runReportPath}`);
  return { reportPath: runReportPath, status: report.status };
}

export async function runAgentBenchmarkMatrix(options: AgentBenchmarkMatrixOptions): Promise<void> {
  if ((options.models === undefined) === (options.targets === undefined)) throw new Error('Provide exactly one of --models or --targets.');
  if (options.targets !== undefined && options.provider !== undefined) throw new Error('Do not combine --provider with --targets; each target already names its provider.');
  const runs = options.targets !== undefined
    ? createProviderBenchmarkMatrix(options.targets, options.profiles)
    : createBenchmarkMatrix(options.models!, options.profiles);
  console.log(`Benchmark matrix · ${runs.length} sequential real-model runs. Each run sends requests for its selected task pack.`);
  const result = await executeBenchmarkMatrix(runs, async (run, index, total) => {
    console.log(`\nMatrix run ${index + 1}/${total} · ${run.provider ?? options.provider ?? 'default'}/${run.model} · ${run.profile}`);
    return runAgentBenchmark({ provider: run.provider ?? options.provider, model: run.model, caseId: options.caseId, taskPack: options.taskPack, profile: run.profile });
  });
  const reports = result.completed.map(entry => entry.result.reportPath);
  if (reports.length >= 2) {
    console.log('\nMatrix comparison (saved run reports):');
    console.log(formatBenchmarkComparison(await loadBenchmarkReports(reports)));
  }
  if (reports.length) console.log(`\nCompare these runs later with: PolonRLM benchmark compare ${reports.map(report => `"${report}"`).join(' ')}`);
  if ('failure' in result) throw result.failure;
}
