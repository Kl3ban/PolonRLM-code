import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { ConfigManager, defaultSettings } from '../src/core/config.js';
import { SecretVault, redact } from '../src/core/secrets.js';
import { SessionStore } from '../src/core/store.js';
import { Permissions } from '../src/core/permissions.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { SkillsManager } from '../src/integrations/skills.js';
import { MCPManager } from '../src/integrations/mcp.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltins } from '../src/tools/builtin.js';
import { createProvider } from '../src/providers/provider.js';
import type { RuntimeEvent } from '../src/core/types.js';

if (process.env.POLONRLM_LIVE_WEB !== '1') throw new Error('This test uses model tokens. Set POLONRLM_LIVE_WEB=1 only after explicitly choosing to run it.');

const config = new ConfigManager(); await config.load();
const google = structuredClone(config.settings.providers.google!);
const key = await new SecretVault(config.home).get('google', google.apiKeyEnv);
if (!key) throw new Error('No Google key was found in the local vault or environment.');
const discovery = createProvider(google, key, 700);
const models = await discovery.listModels();
const selected = models.find(model => model.id === google.model && model.toolCalling !== false)
  ?? models.find(model => /flash/.test(model.id) && !/audio|tts|live|image|preview/i.test(model.id) && model.toolCalling !== false);
if (!selected) throw new Error('No Google model with tool support was found.');
google.model = selected.id;

// Probe the cached browser only after API credentials and the model catalog
// are valid. This never calls PolonRLM's installer or downloads an engine.
const browserProbe = await chromium.launch({ headless: true });
await browserProbe.close();

const settings = {
  ...defaultSettings(), provider: 'google', providers: { google }, browserEngine: 'chromium' as const,
  cortex: 0, maxSteps: 10, maxInputTokens: 24000, maxOutputTokens: 700, tokenBudget: 0, timeoutMs: 45000,
  permissions: 'workspace' as const,
  toolPermissions: { download_to_disk: 'ask' as const, browser: 'ask' as const, browser_automation: 'ask' as const },
  allowTools: ['web_search', 'read_webpage', 'fetch_webpage', 'fetch_documentation', 'github_repo_inspector', 'download_to_disk', 'browser', 'browser_sessions', 'browser_automation', 'discover_tools', 'load_skill'],
};
const provider = createProvider(google, key, settings.maxOutputTokens);
let requestQueue = Promise.resolve(), lastModelRequest = 0;
const throttledProvider = { ...provider, async complete(...args: Parameters<typeof provider.complete>) {
  let release!: () => void; const previous = requestQueue; requestQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, lastModelRequest + 5_500 - Date.now());
    if (wait) await delay(wait, undefined, { signal: args[3] });
    lastModelRequest = Date.now();
    return await provider.complete(...args);
  } finally { release(); }
} };
const folder = await mkdtemp(path.join(tmpdir(), 'polon-web-live-'));
const home = path.join(folder, 'home'), project = path.join(folder, 'project'); await mkdir(home); await mkdir(project);
const permissions = new Permissions(settings);
permissions.approve = async request => {
  const preview = request.preview ?? '';
  if (request.tool === 'download_to_disk') return preview.includes('python-license.txt') && preview.includes('raw.githubusercontent.com/python/cpython/main/LICENSE');
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(preview) as Record<string, unknown>; } catch { return false; }
  if (request.tool === 'browser') return ['launch', 'text', 'tabs', 'close'].includes(String(args.action)) && (args.action !== 'launch' || args.url === 'https://example.com');
  if (request.tool === 'browser_automation') return args.action === 'text' && args.url === 'https://example.com';
  return false;
};
const workspace = await Workspace.open(project, permissions);
const store = new SessionStore(home), tools = new ToolRegistry(permissions, settings.toolOutputLimit), mcp = new MCPManager({});
registerBuiltins(tools, workspace, settings, { computer: false });
const events: RuntimeEvent[] = [];
const runtime = new AgentRuntime(settings, store, tools, workspace, new SkillsManager(home, workspace.root), mcp, async () => throttledProvider, event => events.push(event));

type SmokeTask = { testCase: string; name: string; required: string[]; forbidden: string[]; requiredActions?: { tool: string; action: string }[]; prompt: string };
const tasks: SmokeTask[] = [
  { testCase: 'search', name: 'Internet search and source reading', required: ['web_search', 'read_webpage'], forbidden: ['browser', 'browser_sessions', 'browser_automation', 'computer_use', 'execute_command', 'download_to_disk'], prompt: 'Use the ordinary local web tools only. Call web_search once with exactly this query: site:docs.python.org asyncio.run. Choose a docs.python.org result and call read_webpage with focus_query "asyncio.run Added in version". Answer in one short English sentence with the Python version and direct source link. Do not use a browser, shell or download.' },
  { testCase: 'alias', name: 'AI uses the fetch_documentation alias', required: ['fetch_documentation'], forbidden: ['web_search', 'read_webpage', 'browser', 'browser_sessions', 'browser_automation', 'execute_command'], prompt: 'Use exactly the fetch_documentation tool to read https://docs.python.org/3/library/asyncio-runner.html with focus_query "asyncio.run Added in version". Do not search or use any other web tool. In one short English sentence, say which Python version introduced asyncio.run and include the direct link.' },
  { testCase: 'github', name: 'GitHub metadata and raw source', required: ['github_repo_inspector', 'read_webpage'], forbidden: ['web_search', 'browser', 'browser_sessions', 'browser_automation', 'execute_command', 'download_to_disk'], prompt: 'Use github_repo_inspector on https://github.com/python/cpython with subpath Include and report three header filenames. Then use read_webpage on https://github.com/python/cpython/blob/main/README.rst and summarize the repository in one short English sentence. Do not clone it, search, download, or use a browser or shell.' },
  { testCase: 'download', name: 'Bounded file download', required: ['download_to_disk'], forbidden: ['web_search', 'read_webpage', 'fetch_webpage', 'fetch_documentation', 'github_repo_inspector', 'browser', 'browser_sessions', 'browser_automation', 'execute_command'], prompt: 'Download the official Python source license from https://raw.githubusercontent.com/python/cpython/main/LICENSE using download_to_disk only. Set save_filename to python-license.txt. Do not search, read it as a webpage, open a browser, or use a shell. Report the size and SHA256 returned by the tool.' },
  { testCase: 'browser', name: 'Explicit persistent browser request', required: ['browser', 'browser_sessions'], forbidden: ['web_search', 'read_webpage', 'fetch_webpage', 'fetch_documentation', 'github_repo_inspector', 'browser_automation', 'execute_command', 'download_to_disk'], requiredActions: [{ tool: 'browser', action: 'launch' }, { tool: 'browser', action: 'text' }, { tool: 'browser', action: 'close' }], prompt: 'Use the persistent headless browser tool for this explicit browser task. Launch https://example.com, read its visible text with the browser text action, check browser_sessions while it is open, then close the session. Do not use search, webpage-reading tools, browser automation, download or shell. Report the page title and one fact from its visible text.' },
  { testCase: 'automation', name: 'Explicit one-shot browser automation request', required: ['browser_automation'], forbidden: ['web_search', 'read_webpage', 'fetch_webpage', 'fetch_documentation', 'github_repo_inspector', 'browser', 'browser_sessions', 'execute_command', 'download_to_disk'], requiredActions: [{ tool: 'browser_automation', action: 'text' }], prompt: 'Use the one-shot browser automation tool, exactly browser_automation, to visit https://example.com and read its visible page text. Do not use the persistent browser, web search, webpage-reading tools, download or shell. Reply with the page title and one fact from its text.' },
];

const requestedCases = new Set((process.env.POLONRLM_LIVE_WEB_CASE ?? '').split(',').map(value => value.trim()).filter(Boolean));
const reportPath = path.resolve('docs/web-live-check.json');
const resume = process.env.POLONRLM_LIVE_WEB_RESUME === '1';
let priorChecks: any[] = [];
if (resume) {
  try {
    const saved = JSON.parse(await readFile(reportPath, 'utf8')).checks ?? [];
    const latestByCase = new Map<string, any>();
    for (const check of saved) {
      const task = tasks.find(task => task.testCase === check.testCase || task.name === check.name);
      if (!task) continue;
      check.testCase = task.testCase;
      latestByCase.set(task.testCase, check);
    }
    priorChecks = [...latestByCase.values()];
  } catch { priorChecks = []; }
}
const checks: any[] = priorChecks;
const unknownCases = [...requestedCases].filter(name => !tasks.some(task => task.testCase === name));
if (unknownCases.length) throw new Error(`Unknown live web case: ${unknownCases.join(', ')}. Available: ${tasks.map(task => task.testCase).join(', ')}.`);
try {
  for (const task of tasks) {
    if (requestedCases.size && !requestedCases.has(task.testCase)) continue;
    const old = checks.findIndex((check: any) => check.testCase === task.testCase);
    if (resume && old >= 0 && checks[old].passed === true) continue;
    if (old >= 0) checks.splice(old, 1);
    events.length = 0;
    const session = store.create(workspace.root), started = Date.now();
    let answer = '', failure: string | undefined;
    try { answer = await runtime.run(session, task.prompt, AbortSignal.timeout(100_000)); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const operations = events.filter(event => event.type === 'tool' && event.state !== 'running');
    const errors = operations.filter(event => event.state === 'error');
    const used = operations.map(event => event.name!);
    const usageErrors = errors.filter(event => /Invalid arguments|Unknown tool|schema|Invalid JSON|identical call/i.test(event.text ?? ''));
    const modelCalls = store.messages(session).flatMap(message => message.toolCalls ?? []);
    const check: Record<string, unknown> = {
      name: task.name, ms: Date.now() - started, ...(failure ? { failure } : {}), usageErrors: usageErrors.length,
      upstreamErrors: errors.length - usageErrors.length,
      operations: operations.map(event => ({ name: event.name, detail: event.toolDetail, state: event.state, ms: event.durationMs, ...(event.state === 'error' ? { error: event.text } : {}) })),
      usage: store.usage(session), answer: redact(answer),
    };
    check.testCase = task.testCase;
    checks.push(check);
    try {
      if (failure) throw new Error(failure);
      for (const name of task.required) assert.ok(used.includes(name), `Model did not use ${name}`);
      for (const name of task.forbidden) assert.equal(used.includes(name), false, `Model used forbidden tool ${name}`);
      for (const expected of task.requiredActions ?? []) assert.ok(modelCalls.some(call => call.name === expected.tool && call.arguments.action === expected.action), `Model did not call ${expected.tool} action ${expected.action}`);
      assert.equal(errors.length, 0, errors.map(event => `${event.name}: ${event.text}`).join('\n'));
      if (task.testCase === 'search') assert.ok(operations.some(event => event.name === 'read_webpage' && event.state === 'done'));
      if (task.testCase === 'download') {
        const file = path.join(project, 'agent_workspace', 'downloads', 'python-license.txt');
        const bytes = await readFile(file);
        assert.ok(bytes.length > 1000 && bytes.length < 100_000);
        check.download = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
        assert.ok(answer.includes(createHash('sha256').update(bytes).digest('hex')), 'Model answer should report the verified download hash.');
      }
      if (task.testCase === 'browser') {
        const sessions = JSON.parse(await tools.execute('browser_sessions', {}, { mode: 'BUILD', signal: AbortSignal.timeout(5000) }));
        assert.deepEqual(sessions, [], 'Browser session must be closed after the model finishes.');
      }
      check.passed = true;
    } catch (error) {
      check.passed = false;
      check.failure = error instanceof Error ? error.message : String(error);
    }
    await writeFile(reportPath, JSON.stringify({ date: new Date().toISOString(), model: google.model, checks }, null, 2) + '\n');
    if (check.passed !== true) throw new Error(`${task.name}: ${check.failure}`);
  }
  assert.ok(checks.length > 0, 'No live smoke cases were selected.');
  const report = { date: new Date().toISOString(), model: google.model, browserEngine: 'chromium (preflighted; no installer called)', checks };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await tools.close(); await mcp.close(); store.close(); await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
