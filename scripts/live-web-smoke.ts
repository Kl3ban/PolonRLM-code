import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
const discovery = createProvider(google, key, 1200);
const models = await discovery.listModels();
const selected = models.find(model => model.id === google.model && model.toolCalling !== false)
  ?? models.find(model => /flash/.test(model.id) && !/audio|tts|live|image|preview/i.test(model.id) && model.toolCalling !== false);
if (!selected) throw new Error('No Google model with tool support was found.');
google.model = selected.id;
const settings = { ...defaultSettings(), provider: 'google', providers: { google }, cortex: 0, maxSteps: 8, maxInputTokens: 24000, maxOutputTokens: 1200, tokenBudget: 0, timeoutMs: 45000, permissions: 'readonly' as const,
  allowTools: ['web_search', 'read_webpage', 'fetch_webpage', 'fetch_documentation', 'github_repo_inspector', 'discover_tools', 'load_skill'] };
const provider = createProvider(google, key, settings.maxOutputTokens);
const folder = await mkdtemp(path.join(tmpdir(), 'polon-web-live-'));
const home = path.join(folder, 'home'), project = path.join(folder, 'project'); await mkdir(home); await mkdir(project);
const permissions = new Permissions(settings), workspace = await Workspace.open(project, permissions);
const store = new SessionStore(home), tools = new ToolRegistry(permissions, settings.toolOutputLimit), mcp = new MCPManager({});
registerBuiltins(tools, workspace, settings, { computer: false });
const events: RuntimeEvent[] = [];
const runtime = new AgentRuntime(settings, store, tools, workspace, new SkillsManager(home, workspace.root), mcp, async () => provider, event => events.push(event));
const checks: unknown[] = [];
if (process.env.POLONRLM_LIVE_WEB_CASE === 'search') {
  try { const previous = JSON.parse(await readFile('docs/web-live-check.json', 'utf8')); checks.push(...previous.checks.filter((check: any) => check.name !== 'Internet search and source reading')); } catch { /* First run has no earlier report. */ }
}
try {
  for (const task of [
    { name: 'Internet search and source reading', required: ['web_search', 'read_webpage'], prompt: 'Check the official Python documentation to find which Python version introduced asyncio.run. The only allowed search query is: site:docs.python.org asyncio.run. Choose a docs.python.org result, open it with read_webpage using focus_query "asyncio.run Added in version", answer in one English sentence, and include the direct link. This is public web information, not a question about the local project. Do not repeat the search.' },
    { name: 'GitHub metadata and raw source', required: ['github_repo_inspector', 'read_webpage'], prompt: 'Inspect the public repository https://github.com/python/cpython with github_repo_inspector (subpath Include) and list three header filenames. Then use read_webpage to read https://github.com/python/cpython/blob/main/README.rst and describe the repository in one sentence. Do not clone it or use shell or browser tools.' },
  ]) {
    if (process.env.POLONRLM_LIVE_WEB_CASE === 'search' && task.name !== 'Internet search and source reading') continue;
    events.length = 0;
    const session = store.create(workspace.root), started = Date.now();
    let answer = '', failure: string | undefined;
    try { answer = await runtime.run(session, task.prompt, AbortSignal.timeout(100000)); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const operations = events.filter(event => event.type === 'tool' && event.state !== 'running');
    const errors = operations.filter(event => event.state === 'error');
    const used = operations.map(event => event.name!);
    const usageErrors = errors.filter(event => /Invalid arguments|Unknown tool|schema|Invalid JSON|identical call/i.test(event.text ?? ''));
    checks.push({ name: task.name, ms: Date.now() - started, ...(failure ? { failure } : {}), usageErrors: usageErrors.length, upstreamErrors: errors.length - usageErrors.length, operations: operations.map(event => ({ name: event.name, detail: event.toolDetail, state: event.state, ms: event.durationMs, ...(event.state === 'error' ? { error: event.text } : {}) })), usage: store.usage(session), answer: redact(answer) });
    await writeFile(path.resolve('docs/web-live-check.json'), JSON.stringify({ date: new Date().toISOString(), model: google.model, permissions: 'readonly', checks }, null, 2) + '\n');
    if (failure) throw new Error(`${task.name}: ${failure}`);
    for (const name of task.required) assert.ok(used.includes(name), `Model did not use ${name}`);
    assert.equal(usageErrors.length, 0, usageErrors.map(event => `${event.name}: ${event.text}`).join('\n'));
    assert.equal(used.some(name => /browser|execute|computer|download/.test(name)), false);
  }
  const report = { date: new Date().toISOString(), model: google.model, permissions: 'readonly', checks };
  await writeFile(path.resolve('docs/web-live-check.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await tools.close(); await mcp.close(); store.close(); await rm(folder, { recursive: true, force: true }); }
