import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { render } from 'ink-testing-library';
import type { UIController, UIState } from '../src/core/types.js';
import { AgentPanel, AttachmentPanel, BudgetPanel, MessageCopyPanel, SessionPanel } from '../src/ui/panels.js';
import { SettingsPanel } from '../src/ui/settings.js';
import { defaultSettings } from '../src/core/config.js';

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

const state = (overrides: Partial<UIState> = {}): UIState => ({
  workspace: 'C:\\Projects\\demo', sessionId: 'active', provider: 'test', model: 'vision-model', mode: 'BUILD', cortex: 2,
  busy: false, status: 'Ready', messages: [], usage: { input: 0, output: 0, cached: 0, cost: 0, costKnown: false },
  taskUsage: { input: 120, output: 30, cached: 0, cost: 0.002, costKnown: true },
  agents: [], attachments: [], contextTokens: 1500, contextLimit: 8000, tokenLimit: 5000, dollarLimit: 0.5,
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

test('settings panel can switch the browser engine from automatic selection', { timeout: 5000 }, async t => {
  const values = { ...defaultSettings() } as Record<string, any>;
  const changes: [string, unknown][] = [];
  const view = show(SettingsPanel, {
    readSettings: () => ({ values, tools: [] }),
    async updateSetting(key: string, value: any) { changes.push([key, value]); values[key] = value; },
  });
  t.after(view.cleanup);
  for (let index = 0; index < 5; index++) await press(view.app, '\u001b[B');
  assert.match(view.app.lastFrame()!, /Browser engine/);
  view.app.stdin.write('\u001b[C');
  await until(() => changes.length === 1 && values.browserEngine === 'chromium', 'select Playwright Chromium');
  assert.deepEqual(changes[0], ['browserEngine', 'chromium']);
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
  const view = show(AttachmentPanel, {
    async addImagePath(filename: string) { files.push(filename); },
    addImageData(data: string) { clipboard.push(data); },
  }, state({ attachments: [{ name: 'reference.png', mediaType: 'image/png', bytes: 1024 }] }), {
    readClipboardImage: async () => 'clipboard-png',
  });
  t.after(view.cleanup);
  await until(() => /reference\.png/.test(view.app.lastFrame() ?? ''), 'show queued image');
  assert.match(view.app.lastFrame() ?? '', /supports images/);
  view.app.stdin.write('\u0018\u0001\u0003');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(view.app.lastFrame() ?? '', /reference\.png/);
  assert.doesNotMatch(view.app.lastFrame() ?? '', /Plik:/);
  await press(view.app, 'a');
  await until(() => /Plik:/.test(view.app.lastFrame() ?? ''), 'enter file picker');
  view.app.stdin.write('C:\\Pictures\\second.png');
  await until(() => /second\.png/.test(view.app.lastFrame() ?? ''), 'show image path');
  view.app.stdin.write('\r');
  await until(() => files.length === 1, 'add an image file');
  assert.equal(files[0], 'C:\\Pictures\\second.png');
  await until(() => !/Wczytywanie obrazu/.test(view.app.lastFrame() ?? ''), 'finish image loading');
  await press(view.app, 'p');
  await until(() => clipboard.length === 1, 'paste an image from clipboard');
  assert.deepEqual(clipboard, ['clipboard-png']);
});
