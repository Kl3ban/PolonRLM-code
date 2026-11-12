import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import type { UIController, UIState } from '../src/core/types.js';
import { Controller } from '../src/core/controller.js';
import { ConfigManager } from '../src/core/config.js';
import { AgentPanel, AttachmentPanel, BudgetPanel, MessageCopyPanel, SessionPanel } from '../src/ui/panels.js';
import { SettingsPanel } from '../src/ui/settings.js';
import { defaultSettings } from '../src/core/config.js';
import { SETTINGS_FIELDS } from '../src/core/settings-fields.js';

async function until(predicate: () => boolean, message: string, snapshot?: () => string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail('Panel did not ' + message + (snapshot ? `\n${snapshot()}` : ''));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function press(app: ReturnType<typeof render>, input: string): Promise<void> {
  const before = app.frames.length;
  app.stdin.write(input);
  await until(() => app.frames.length > before, `render input ${JSON.stringify(input)}`);
}

async function selectSetting(app: ReturnType<typeof render>, label: string): Promise<void> {
  const selected = () => (app.lastFrame() ?? '').split(/\r?\n/).some(line => line.includes('›') && line.includes(label));
  for (let index = 0; index <= SETTINGS_FIELDS.length; index++) {
    if (selected()) return;
    await press(app, '\u001b[B');
  }
  assert.fail(`Settings row was not selectable: ${label}\n${app.lastFrame() ?? ''}`);
}

test('every persisted setting has a settings panel or a dedicated command surface', () => {
  const visible = new Set(SETTINGS_FIELDS.map(field => field.key));
  const commandManaged = new Set(['provider', 'providers', 'mcp', 'plugins', 'toolPermissions', 'allowTools', 'denyTools']);
  const internalMetadata = new Set(['configVersion']);
  const missing = Object.keys(defaultSettings()).filter(key => !visible.has(key) && !commandManaged.has(key) && !internalMetadata.has(key));
  assert.deepEqual(missing, []);
  assert.equal(visible.size, SETTINGS_FIELDS.length);
});

const state = (overrides: Partial<UIState> = {}): UIState => ({
  workspace: 'C:\\Projects\\demo', sessionId: 'active', provider: 'test', model: 'vision-model', mode: 'BUILD', cortex: 2,
  busy: false, status: 'Ready', messages: [], usage: { input: 0, output: 0, cached: 0, cost: 0, costKnown: false },
  taskUsage: { input: 120, output: 30, cached: 0, cost: 0.002, costKnown: true },
  agents: [], attachments: [], contextTokens: 1500, contextLimit: 8000, contextLimitSource: 'model', tokenLimit: 5000, dollarLimit: 0.5,
  vision: true, theme: 'dark', ...overrides,
});

function show(Component: typeof SettingsPanel | typeof SessionPanel | typeof MessageCopyPanel | typeof AgentPanel | typeof BudgetPanel | typeof AttachmentPanel, methods: Record<string, unknown>, current = state(), extras: Record<string, unknown> = {}) {
  const controller = methods as unknown as UIController;
  let closed = 0;
  const app = render(React.createElement(Component, {
    controller, state: current, width: 80, rows: 30, close: () => { closed++; }, ...extras,
  }));
  return { app, controller, get closed() { return closed; }, cleanup: () => { app.unmount(); app.cleanup(); } };
}

test('settings panel edits infinity and per-tool rules without dumping configuration into chat', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings(), tokenBudget: 5000 } as Record<string, any>;
  let policy = 'default';
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [{ name: 'web_search', description: 'Search ordinary public pages.', available: true, policy }] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); if (key.startsWith('tool.')) policy = value; else values[key] = value; },
  });
  t.after(view.cleanup);
  assert.match(view.app.lastFrame()!, /SETTINGS.*Esc to close/);
  await press(view.app, '\t');
  assert.match(view.app.lastFrame()!, /Tokens per task/);
  await press(view.app, '\r');
  await press(view.app, '\u0015');
  await press(view.app, 'infinity');
  view.app.stdin.write('\r');
  await until(() => changes.length === 1 && /Unlimited ∞/.test(view.app.lastFrame()!), 'save unlimited budget');
  assert.deepEqual(changes[0], ['tokenBudget', 0]);
  await press(view.app, '\t');
  assert.match(view.app.lastFrame()!, /web_search/);
  view.app.stdin.write('\u001b[C');
  await until(() => changes.length === 2, 'save tool policy');
  assert.deepEqual(changes[1], ['tool.web_search', 'ask']);
  assert.doesNotMatch(view.app.lastFrame()!, /baseURL|apiKeyEnv|"providers"/);
});

test('every settings-panel field can be changed through its actual keyboard controls', { timeout: 20000 }, async t => {
  const values = { ...defaultSettings() } as Record<string, any>;
  const jsonFields = new Set(['browserOptions', 'verificationCommands', 'sandboxNetworkDomains', 'fallback', 'agentToolProfiles', 'modelRoutes', 'modelRoleBudgets']);
  for (const key of jsonFields) values[key] = JSON.stringify(values[key]);
  const changes: [string, string | number][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: string | number) {
      changes.push([key, value]);
      values[key] = jsonFields.has(key) ? JSON.parse(String(value)) : value;
    },
  });
  t.after(view.cleanup);

  const textValues: Record<string, string> = {
    browserOptions: '{"viewportWidth":1440}',
    verificationCommands: '["npm test"]',
    sandboxNetworkDomains: '["registry.npmjs.org"]',
    sandboxDockerImage: 'node:24-bookworm-slim',
    fallback: '["google"]',
    agentToolProfiles: '{"reviewer":["read_file"]}',
    modelRoutes: '{"reviewer":{"provider":"google"}}',
    modelRoleBudgets: '{"coder":{"maxCalls":5}}',
    repeatFailureThreshold: '4',
    tokenBudget: '1234',
    dollarBudget: '1.25',
    maxInputTokens: '64000',
    maxOutputTokens: '8192',
    maxSteps: '64',
    maxAgents: '4',
    maxProcesses: '3',
    maxDepth: '2',
    timeoutMs: '15000',
    toolOutputLimit: '10000',
  };
  assert.deepEqual(Object.keys(textValues).sort(), SETTINGS_FIELDS.filter(field => !field.options).map(field => field.key).sort());

  for (const section of ['general', 'limits'] as const) {
    if (section === 'limits') await press(view.app, '\t');
    for (const field of SETTINGS_FIELDS.filter(item => item.section === section)) {
      await selectSetting(view.app, field.label);
      const changeCount = changes.length;
      let expected: string | number;
      if (field.options) {
        const current = field.options.findIndex(option => option.value === values[field.key]);
        expected = field.options[(Math.max(0, current) + 1) % field.options.length]!.value;
        await press(view.app, '\u001b[C');
      } else {
        await press(view.app, '\r');
        await press(view.app, '\u0015');
        view.app.stdin.write(textValues[field.key]!);
        await until(() => (view.app.lastFrame() ?? '').includes(textValues[field.key]!), `type setting ${field.key}`);
        expected = jsonFields.has(field.key) || field.kind === 'text' ? textValues[field.key]! : Number(textValues[field.key]);
        await press(view.app, '\r');
      }
      await until(() => changes.length === changeCount + 1, `save setting ${field.key}`);
      assert.deepEqual(changes[changeCount], [field.key, expected], `settings panel save ${field.key}`);
    }
  }
  assert.equal(changes.length, SETTINGS_FIELDS.length);
});

test('settings panel updates the real controller and survives a reload', { timeout: 10000 }, async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'PolonRLM-settings-ui-'));
  const root = path.join(folder, 'workspace'), home = path.join(folder, 'home');
  await mkdir(root);
  const controller = await Controller.open(root, home);
  const view = show(SettingsPanel, controller as unknown as Record<string, unknown>, controller.snapshot());
  t.after(async () => { view.cleanup(); await controller.close(); await rm(folder, { recursive: true, force: true }); });

  await selectSetting(view.app, 'Verification commands');
  await press(view.app, '\r');
  await press(view.app, '\u0015');
  const commands = '["npm test","npm run check"]';
  view.app.stdin.write(commands);
  await until(() => (view.app.lastFrame() ?? '').includes(commands), 'edit real verification settings');
  await press(view.app, '\r');
  await until(() => (view.app.lastFrame() ?? '').includes('Saved'), 'finish saving real verification settings');
  assert.deepEqual(controller.readSettings().values.verificationCommands, commands);

  await selectSetting(view.app, 'Role model routes');
  await press(view.app, '\r');
  await press(view.app, '\u0015');
  const routes = '{"reviewer":{"provider":"openrouter","model":"review-model"}}';
  view.app.stdin.write(routes);
  await until(() => (view.app.lastFrame() ?? '').includes('review-mo'), 'edit real model routes', () => view.app.lastFrame() ?? '');
  await press(view.app, '\r');
  await until(() => (view.app.lastFrame() ?? '').includes('Saved'), 'finish saving real model routes');
  assert.equal(controller.config.settings.modelRoutes.reviewer?.model, 'review-model');

  const reopened = new ConfigManager(home);
  await reopened.load();
  assert.deepEqual(reopened.settings.verificationCommands, ['npm test', 'npm run check']);
  assert.deepEqual(reopened.settings.modelRoutes, { reviewer: { provider: 'openrouter', model: 'review-model' } });
});

test('settings panel can switch the browser engine from automatic selection', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings() } as Record<string, any>;
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = value; },
  });
  t.after(view.cleanup);
  await selectSetting(view.app, 'Browser engine');
  assert.match(view.app.lastFrame()!, /Browser engine/);
  view.app.stdin.write('\u001b[C');
  await until(() => changes.length === 1 && values.browserEngine === 'chromium', 'select Playwright Chromium');
  assert.deepEqual(changes[0], ['browserEngine', 'chromium']);
});

test('settings panel can disable automatic verification and adjust repair attempts', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings() } as Record<string, any>;
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = value; },
  });
  t.after(view.cleanup);
  await selectSetting(view.app, 'Verification mode');
  assert.match(view.app.lastFrame()!, /Verification mode/);
  await press(view.app, '\u001b[C');
  await until(() => values.verificationMode === 'manual', 'disable automatic verification');
  assert.deepEqual(changes[0], ['verificationMode', 'manual']);
  await press(view.app, '\u001b[B');
  assert.match(view.app.lastFrame()!, /Automatic repair attempts/);
  await press(view.app, '\u001b[C');
  await until(() => values.verificationRepairAttempts === 2, 'set two automatic repair attempts');
  assert.deepEqual(changes[1], ['verificationRepairAttempts', 2]);
});

test('settings panel saves the sandbox network allowlist as JSON instead of a number', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings() } as Record<string, any>;
  values.sandboxNetworkDomains = JSON.stringify(values.sandboxNetworkDomains);
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = JSON.parse(value); },
  });
  t.after(view.cleanup);
  await selectSetting(view.app, 'Sandbox network allowlist');
  assert.match(view.app.lastFrame()!, /Sandbox network allowlist/);
  await press(view.app, '\r');
  await press(view.app, '\u0015');
  view.app.stdin.write('["registry.npmjs.org", "github.com"]');
  await until(() => /registry.npmjs.org/.test(view.app.lastFrame() ?? ''), 'edit the sandbox network allowlist');
  view.app.stdin.write('\r');
  await until(() => changes.length === 1, 'save the sandbox network allowlist');
  assert.deepEqual(changes[0], ['sandboxNetworkDomains', '["registry.npmjs.org", "github.com"]']);
  assert.deepEqual(values.sandboxNetworkDomains, ['registry.npmjs.org', 'github.com']);
});

test('settings panel edits the ordered fallback provider list', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings(), fallback: '[]' } as Record<string, any>;
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = JSON.parse(value); },
  });
  t.after(view.cleanup);
  await selectSetting(view.app, 'Fallback providers');
  assert.match(view.app.lastFrame()!, /Fallback providers/);
  await press(view.app, '\r');
  await press(view.app, '\u0015');
  view.app.stdin.write('["google", "openrouter"]');
  await until(() => /openrouter/.test(view.app.lastFrame() ?? ''), 'edit the fallback providers');
  view.app.stdin.write('\r');
  await until(() => changes.length === 1, 'save fallback providers');
  assert.deepEqual(changes[0], ['fallback', '["google", "openrouter"]']);
  assert.deepEqual(values.fallback, ['google', 'openrouter']);
});

test('settings panel edits JSON subagent role profiles', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings(), agentToolProfiles: '{}' } as Record<string, any>;
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = JSON.parse(value); },
  });
  t.after(view.cleanup);
  await selectSetting(view.app, 'Subagent tool profiles');
  assert.match(view.app.lastFrame()!, /Subagent tool profiles/);
  await press(view.app, '\r');
  await press(view.app, '\u0015');
  view.app.stdin.write('{"reviewer":["read_file","search_files"]}');
  await until(() => /search_files/.test(view.app.lastFrame() ?? ''), 'edit subagent role profiles');
  view.app.stdin.write('\r');
  await until(() => changes.length === 1, 'save subagent role profiles');
  assert.deepEqual(changes[0], ['agentToolProfiles', '{"reviewer":["read_file","search_files"]}']);
  assert.deepEqual(values.agentToolProfiles, { reviewer: ['read_file', 'search_files'] });
});

test('settings panel edits persisted role-specific model routes', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings(), modelRoutes: '{}' } as Record<string, any>;
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = JSON.parse(value); },
  });
  t.after(view.cleanup);
  await selectSetting(view.app, 'Role model routes');
  assert.match(view.app.lastFrame()!, /Role model routes/);
  await press(view.app, '\r');
  await press(view.app, '\u0015');
  view.app.stdin.write('{"reviewer":{"provider":"google","model":"flash-test"}}');
  await until(() => /flash-test/.test(view.app.lastFrame() ?? ''), 'edit role model routes');
  view.app.stdin.write('\r');
  await until(() => changes.length === 1, 'save role model routes');
  assert.deepEqual(changes[0], ['modelRoutes', '{"reviewer":{"provider":"google","model":"flash-test"}}']);
  assert.deepEqual(values.modelRoutes, { reviewer: { provider: 'google', model: 'flash-test' } });
});

test('settings panel edits role model budgets as JSON', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings(), modelRoleBudgets: '{}' } as Record<string, any>;
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = JSON.parse(value); },
  });
  t.after(view.cleanup);
  await selectSetting(view.app, 'Role model budgets');
  assert.match(view.app.lastFrame()!, /Role model budgets/);
  await press(view.app, '\r');
  await press(view.app, '\u0015');
  view.app.stdin.write('{"coder":{"maxTokens":50000,"maxCost":1,"maxCalls":30}}');
  await until(() => /maxTokens/.test(view.app.lastFrame() ?? ''), 'edit role model budgets');
  view.app.stdin.write('\r');
  await until(() => changes.length === 1, 'save role model budgets');
  assert.deepEqual(changes[0], ['modelRoleBudgets', '{"coder":{"maxTokens":50000,"maxCost":1,"maxCalls":30}}']);
  assert.deepEqual(values.modelRoleBudgets, { coder: { maxTokens: 50000, maxCost: 1, maxCalls: 30 } });
});

test('settings panel lets the user choose a fixed Cortex strategy', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings() } as Record<string, any>;
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = value; },
  });
  t.after(view.cleanup);
  await selectSetting(view.app, 'Cortex strategy');
  assert.match(view.app.lastFrame()!, /Cortex strategy/);
  await press(view.app, '\r');
  await until(() => changes.length === 1, 'save fixed Cortex strategy');
  assert.deepEqual(changes[0], ['cortexStrategy', 'fixed']);
});

test('message picker copies full user and AI messages', { timeout: 5000 }, async t => {
  const copied: string[] = [];
  const assistant = state({ messages: [{ role: 'user', text: 'My complete request' }, { role: 'assistant', speaker: 'model-x', text: 'A full answer\nwith a second paragraph.' }, { role: 'system', text: 'Ignore this message' }] });
  const aiPanel = show(MessageCopyPanel, {}, assistant, { onCopy: (text: string) => copied.push(text) });
  t.after(aiPanel.cleanup);
  assert.match(aiPanel.app.lastFrame()!, /AI.*model-x/);
  aiPanel.app.stdin.write('\r'); await until(() => copied.length === 1, 'copy assistant message');
  const userPanel = show(MessageCopyPanel, {}, state({ messages: [{ role: 'user', text: 'My complete request' }] }), { onCopy: (text: string) => copied.push(text) });
  t.after(userPanel.cleanup); userPanel.app.stdin.write('\r'); await until(() => copied.length === 2, 'copy user message');
  assert.deepEqual(copied, ['A full answer\nwith a second paragraph.', 'My complete request']);
});

test('session panel searches, renames a selected session and resumes it on Enter', { timeout: 5000 }, async t => {
  let sessions = [
    { id: 'alpha', title: 'Alpha task', updated: 1 },
    { id: 'needle', title: 'Needle search', updated: 2 },
  ];
  let renamed: { id: string; title: string } | undefined;
  let resumed: string | undefined;
  const view = show(SessionPanel, {
    listSessions(query = '') { return sessions.filter(session => (session.title + ' ' + session.id).toLowerCase().includes(query.toLowerCase())); },
    renameSession(id: string, title: string) { renamed = { id, title }; sessions = sessions.map(session => session.id === id ? { ...session, title } : session); },
    resumeSession(id: string) { resumed = id; },
  });
  t.after(view.cleanup);
  await until(() => Boolean(view.app.lastFrame()), 'mount');
  view.app.stdin.write('Needle');
  await until(() => /Needle search/.test(view.app.lastFrame() ?? ''), 'show filtered session');
  assert.doesNotMatch(view.app.lastFrame() ?? '', /Alpha task/);
  view.app.stdin.write('\u0015');
  await until(() => /Alpha task/.test(view.app.lastFrame() ?? ''), 'clear search');
  await press(view.app, 'r');
  assert.doesNotMatch(view.app.lastFrame() ?? '', /Enter save/);
  await press(view.app, '\u0015');
  await until(() => /Alpha task/.test(view.app.lastFrame() ?? ''), 'clear the r search');
  await press(view.app, '\u0012');
  await until(() => /Enter save name/.test(view.app.lastFrame() ?? ''), 'enter rename mode');
  await press(view.app, '\u0015');
  view.app.stdin.write('Renamed task');
  await until(() => /Renamed task/.test(view.app.lastFrame() ?? ''), 'show edited session name');
  view.app.stdin.write('\r');
  await until(() => renamed?.title === 'Renamed task', 'save renamed session');
  assert.equal(renamed?.id, 'alpha');
  view.app.stdin.write('\r');
  await until(() => resumed === 'alpha', 'resume selected session');
});

test('session panel keeps resume failures inside the panel', { timeout: 5000 }, async t => {
  const view = show(SessionPanel, {
    listSessions() { return [{ id: 'busy', title: 'Busy task', updated: 1 }]; },
    resumeSession() { throw new Error('task is still running'); },
  });
  t.after(view.cleanup);
  await until(() => /Busy task/.test(view.app.lastFrame() ?? ''), 'show session');
  await press(view.app, '\r');
  await until(() => /task is still running/.test(view.app.lastFrame() ?? ''), 'show resume error');
  assert.equal(view.closed, 0);
});

test('subagent panel shows task progress and changed files, then stops only the selected agent', { timeout: 5000 }, async t => {
  const stopped: string[] = [];
  const view = show(AgentPanel, { stopAgent(id: string) { stopped.push(id); } }, state({
    agents: [{ id: 'agent-1', role: 'coder', status: 'working', task: 'Update the parser safely', progress: 2, totalSteps: 5, changedFiles: ['src/parser.ts'] }],
  }));
  t.after(view.cleanup);
  await until(() => /src\/parser\.ts/.test(view.app.lastFrame() ?? ''), 'show agent details');
  assert.match(view.app.lastFrame() ?? '', /coder/);
  assert.match(view.app.lastFrame() ?? '', /2\/5/);
  assert.match(view.app.lastFrame() ?? '', /Update the parser safely/);
  view.app.stdin.write('\u0018');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(stopped, [], 'Ctrl+X must not stop a subagent');
  view.app.stdin.write('x');
  await until(() => stopped.length === 1, 'stop selected agent');
  assert.deepEqual(stopped, ['agent-1']);
});

test('budget panel edits per-task token and dollar limits before work starts', { timeout: 5000 }, async t => {
  const budgets: number[][] = [];
  const view = show(BudgetPanel, { async setBudgets(tokens: number, dollars: number) { budgets.push([tokens, dollars]); } });
  t.after(view.cleanup);
  await until(() => /5000/.test(view.app.lastFrame() ?? ''), 'show current token limit');
  assert.match(view.app.lastFrame() ?? '', /Context now: ~1,500 \/ 8,000 \(model window\)/);
  for (let index = 0; index < 4; index++) await press(view.app, '\u007f');
  view.app.stdin.write('7500');
  await until(() => /7500/.test(view.app.lastFrame() ?? ''), 'show edited token limit', () => view.app.lastFrame() ?? '');
  await press(view.app, '\t');
  for (let index = 0; index < 4; index++) await press(view.app, '\u007f');
  view.app.stdin.write('0.75');
  await until(() => /0\.75/.test(view.app.lastFrame() ?? ''), 'show edited cost limit');
  view.app.stdin.write('\r');
  await until(() => budgets.length === 1, 'save per-task limits');
  assert.deepEqual(budgets[0], [7500, 0.75]);
  assert.equal(view.closed, 1);
});

test('attachment panel lists model vision status and adds file and clipboard images', { timeout: 5000 }, async t => {
  const files: string[] = [], clipboard: string[] = [];
  const removed: number[] = [];
  const mouseEvents = new EventEmitter();
  const view = show(AttachmentPanel, {
    async addImagePath(filename: string) { files.push(filename); },
    addImageData(data: string) { clipboard.push(data); },
    removeImage(index: number) { removed.push(index); },
  }, state({ attachments: [
    { name: 'reference.png', mediaType: 'image/png', bytes: 1024 },
    { name: 'other-screen.png', mediaType: 'image/png', bytes: 2048 },
  ] }), {
    mouseEvents, readClipboardImage: async () => 'clipboard-png',
  });
  t.after(view.cleanup);
  await until(() => /reference\.png/.test(view.app.lastFrame() ?? ''), 'show queued image');
  assert.match(view.app.lastFrame() ?? '', /2 images attached/);
  assert.match(view.app.lastFrame() ?? '', /supports images/);
  const lines = view.app.lastFrame()!.split('\n');
  const secondRow = lines.findIndex(line => line.includes('other-screen.png'));
  assert.ok(secondRow >= 0, 'second attachment should be visible');
  const secondColumn = lines[secondRow]!.indexOf('other-screen.png');
  mouseEvents.emit('mouse', { action: 'down', button: 0, x: secondColumn, y: secondRow });
  mouseEvents.emit('mouse', { action: 'up', button: 0, x: secondColumn, y: secondRow });
  await until(() => /› 02  other-screen\.png/.test(view.app.lastFrame() ?? ''), 'select the second image by clicking it');
  const selectedLines = view.app.lastFrame()!.split('\n');
  const selectedRow = selectedLines.findIndex(line => line.includes('other-screen.png'));
  const removeColumn = selectedLines[selectedRow]!.indexOf('[x]');
  mouseEvents.emit('mouse', { action: 'down', button: 0, x: removeColumn, y: selectedRow });
  mouseEvents.emit('mouse', { action: 'up', button: 0, x: removeColumn, y: selectedRow });
  await until(() => removed.length === 1, 'remove the clicked image', () => view.app.lastFrame() ?? '');
  assert.deepEqual(removed, [1]);
  view.app.stdin.write('\u0018\u0001\u0003');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(view.app.lastFrame() ?? '', /reference\.png/);
  assert.doesNotMatch(view.app.lastFrame() ?? '', /File:/);
  await press(view.app, 'a');
  await until(() => /File:/.test(view.app.lastFrame() ?? ''), 'enter file picker');
  view.app.stdin.write('C:\\Pictures\\second.png');
  await until(() => /second\.png/.test(view.app.lastFrame() ?? ''), 'show image path');
  view.app.stdin.write('\r');
  await until(() => files.length === 1, 'add an image file');
  assert.equal(files[0], 'C:\\Pictures\\second.png');
  await until(() => !/File:/.test(view.app.lastFrame() ?? ''), 'finish adding image');
  await press(view.app, 'p');
  await until(() => clipboard.length === 1, 'paste an image from clipboard');
  assert.deepEqual(clipboard, ['clipboard-png']);
});
