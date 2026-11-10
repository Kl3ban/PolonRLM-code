import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { marked } from 'marked';
import type { Approve, ApprovalRequest, UIController, UIState } from '../src/core/types.js';
import { TerminalApp } from '../src/ui/tui.js';
import { markdownLines, sanitizeTerminalText } from '../src/ui/markdown.js';

async function until(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`UI did not ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function fixture(initial: Partial<UIState> = {}, inputs: { mouseEvents?: EventEmitter; readClipboard?: () => Promise<string>; readImageClipboard?: () => Promise<string>; writeClipboard?: (text: string) => Promise<void> } = {}) {
  let state: UIState = {
    workspace: 'C:\\Projects\\demo', sessionId: 'session-test', provider: 'custom', model: 'test-model', mode: 'BUILD', cortex: 2,
    busy: false, status: 'Ready', messages: [],
    usage: { input: 100, output: 5, cached: 10, cost: 0, costKnown: false },
    taskUsage: { input: 0, output: 0, cached: 0, cost: 0, costKnown: true }, agents: [], attachments: [],
    contextTokens: 0, contextLimit: 12_000, tokenLimit: 100_000, dollarLimit: 10, vision: true, theme: 'dark',
    ...initial,
  };
  const listeners = new Set<() => void>();
  const submissions: string[] = [];
  const modelsChosen: { id: string; persist?: boolean }[] = [];
  const providersChosen: string[] = [];
  const effortsChosen: string[] = [];
  const keysSaved: string[] = [];
  const imagesAdded: string[] = [];
  const imagesRemoved: number[] = [];
  const endpointsSaved: unknown[] = [];
  const services = { failModels: false };
  let approver: Approve | undefined;
  let cancelled = 0;
  let closed = 0;
  let modeChanges = 0;
  const update = (changes: Partial<UIState>) => {
    state = { ...state, ...changes };
    listeners.forEach(listener => listener());
  };
  const controller: UIController = {
    snapshot: () => ({ ...state, messages: [...state.messages] }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async submit(text) { submissions.push(text); },
    addImageData(data, name) { imagesAdded.push(data); update({ attachments: [...state.attachments, { name: name ?? 'Screenshot.png', mediaType: 'image/png', bytes: 100 }] }); },
    removeImage(index) { imagesRemoved.push(index); update({ attachments: state.attachments.filter((_, item) => item !== index) }); },
    clearImages() { update({ attachments: [] }); },
    cancel() { cancelled++; },
    cycleMode() { modeChanges++; update({ mode: state.mode === 'BUILD' ? 'PLAN' : 'BUILD' }); },
    async close() { closed++; },
    setApprover(approve) { approver = approve; },
    async listModels() { if (services.failModels) throw new Error('HTTP 401: set an API key'); return [{ id: 'acme/fast', contextWindow: 32000 }, { id: 'acme/deep', contextWindow: 64000 }]; },
    listEfforts() { return [{ id: 'auto', label: 'Automatic' }, { id: 'low', label: 'Low' }, { id: 'high', label: 'High' }]; },
    async setEffort(id) { effortsChosen.push(id); },
    listProviders() { return [{ id: 'custom', url: 'http://localhost/v1', model: 'test-model' }, ...['google', 'nvidia', 'mistral', 'openai'].map(id => ({ id, url: 'https://example.com', model: 'test-model' }))]; },
    async configureProvider(provider, apiKey) { endpointsSaved.push({ provider, apiKey }); update({ provider: provider.id, model: provider.model }); },
    async setModel(id, persist) { modelsChosen.push({ id, persist }); update({ model: id }); },
    async selectProvider(id) { providersChosen.push(id); update({ provider: id }); },
    async setApiKey(key) { keysSaved.push(key); services.failModels = false; },
  };
  const app = render(React.createElement(TerminalApp, { controller, readImageClipboard: async () => '', ...inputs }));
  return {
    app, submissions, listeners, update, modelsChosen, providersChosen, effortsChosen, keysSaved, imagesAdded, imagesRemoved, endpointsSaved, services,
    get cancelled() { return cancelled; },
    get closed() { return closed; },
    get modeChanges() { return modeChanges; },
    async ready() { await until(() => Boolean(approver) && /PolonRLM/.test(app.lastFrame() || ''), 'mount'); },
    async type(text: string) {
      const previous = app.frames.length;
      app.stdin.write(text);
      await until(() => app.frames.length > previous, `render input ${text.startsWith('/key') ? '/key [hidden]' : JSON.stringify(text)}`);
    },
    async approve(request: ApprovalRequest, signal?: AbortSignal) { assert.ok(approver); return approver(request, signal); },
    dispose() { app.unmount(); app.cleanup(); },
  };
}

test('Ctrl+V attaches a screenshot, shows the attachment count and permits an image-only submission', async t => {
  let textReads = 0;
  const view = fixture({}, { readImageClipboard: async () => 'test-image-data', readClipboard: async () => { textReads++; return 'stale clipboard text'; } });
  t.after(view.dispose); await view.ready();
  view.app.stdin.write('\u0016');
  await until(() => /1 image/.test(view.app.lastFrame() ?? ''), 'show attached image count');
  assert.deepEqual(view.imagesAdded, ['test-image-data']);
  assert.equal(textReads, 0);
  view.app.stdin.write('\r');
  await until(() => view.submissions.length === 1, 'submit image without text');
});

test('Ctrl+V keeps text paste working when no screenshot is available', async t => {
  const view = fixture({}, { readImageClipboard: async () => '', readClipboard: async () => 'Text from clipboard' });
  t.after(view.dispose); await view.ready(); view.app.stdin.write('\u0016');
  await until(() => /Text from clipboard/.test(view.app.lastFrame() ?? ''), 'paste clipboard text');
  assert.deepEqual(view.imagesAdded, []);
});

test('start composer keeps five attached images compact and opens the image picker', async t => {
  const attachments = Array.from({ length: 5 }, (_, index) => ({ name: `screen-${index + 1}.png`, mediaType: 'image/png', bytes: 1024 }));
  const mouseEvents = new EventEmitter();
  const view = fixture({ attachments }, { mouseEvents });
  t.after(view.dispose); await view.ready();
  assert.match(view.app.lastFrame()!, /5 images/);
  assert.doesNotMatch(view.app.lastFrame()!, /screen-[1-5]\.png/);
  const lines = view.app.lastFrame()!.split('\n');
  const row = lines.findIndex(line => line.includes('5 images'));
  const column = lines[row]!.indexOf('5 images');
  mouseEvents.emit('mouse', { action: 'down', button: 0, x: column, y: row });
  mouseEvents.emit('mouse', { action: 'up', button: 0, x: column, y: row });
  await until(() => /ATTACHMENTS/.test(view.app.lastFrame() ?? ''), 'open attachment picker by clicking the image summary');
  assert.match(view.app.lastFrame()!, /5 images attached/);
  for (const attachment of attachments) assert.match(view.app.lastFrame()!, new RegExp(attachment.name));
});

test('start composer selects and copies typed text with Ctrl+A and Ctrl+C', async t => {
  const copied: string[] = [];
  const view = fixture({}, { writeClipboard: async text => { copied.push(text); } });
  t.after(view.dispose); await view.ready();
  view.app.stdin.write('draft text');
  await until(() => /draft text/.test(view.app.lastFrame() ?? ''), 'show start composer text');
  view.app.stdin.write('\x01');
  view.app.stdin.write('\x03');
  await until(() => copied.length === 1, 'copy selected start composer text');
  assert.equal(copied[0], 'draft text');
  assert.equal(view.closed, 0);
});

test('start composer selects and copies a mouse-dragged text range', async t => {
  const mouseEvents = new EventEmitter();
  const copied: string[] = [];
  const view = fixture({}, { mouseEvents, writeClipboard: async text => { copied.push(text); } });
  t.after(view.dispose); await view.ready();
  view.app.stdin.write('Alpha beta');
  await until(() => /Alpha beta/.test(view.app.lastFrame() ?? ''), 'show text to select in start composer');
  const lines = view.app.lastFrame()!.split('\n');
  const y = lines.findIndex(line => line.includes('Alpha beta'));
  const x = lines[y]!.indexOf('Alpha beta') + 'Alpha '.length;
  mouseEvents.emit('mouse', { action: 'down', button: 0, x, y });
  mouseEvents.emit('mouse', { action: 'move', button: 0, x: x + 4, y });
  mouseEvents.emit('mouse', { action: 'up', button: 0, x: x + 4, y });
  view.app.stdin.write('\x03');
  await until(() => copied.length === 1, 'copy mouse-selected start composer text');
  assert.equal(copied[0], 'beta');
  assert.equal(view.closed, 0);
});

test('start composer can remove the last image while draft text is present', async t => {
  const view = fixture({ attachments: [
    { name: 'first.png', mediaType: 'image/png', bytes: 100 },
    { name: 'second.png', mediaType: 'image/png', bytes: 100 },
  ] });
  t.after(view.dispose); await view.ready();
  view.app.stdin.write('keep this task');
  await until(() => /keep this task/.test(view.app.lastFrame() ?? ''), 'show task beside attached images');
  view.app.stdin.write('\x1b\x7f');
  await until(() => view.imagesRemoved.length === 1, 'remove last image without deleting draft');
  assert.deepEqual(view.imagesRemoved, [1]);
  assert.match(view.app.lastFrame()!, /keep this task/);
  assert.match(view.app.lastFrame()!, /1 image/);
});

test('TUI renders provider, mode, usage and live model output', { timeout: 5000 }, async t => {
  const view = fixture();
  t.after(() => view.dispose());
  await view.ready();
  assert.match(view.app.lastFrame()!, /Build/);
  assert.match(view.app.lastFrame()!, /Cortex 2/);
  assert.match(view.app.lastFrame()!, /test-model.*custom/);
  assert.match(view.app.lastFrame()!, /105/);
  assert.match(view.app.lastFrame()!, /unknown/);
  view.update({ messages: [{ role: 'assistant', text: '# Result\n\nStreaming answer' }], usage: { input: 100, output: 20, cached: 10, cost: 0.001, costKnown: true } });
  await until(() => /Streaming answer/.test(view.app.lastFrame() || ''), 'show streamed output');
  assert.match(view.app.lastFrame()!, /Result/);
  assert.match(view.app.lastFrame()!, /\$0\.00100/);
});

test('settings aliases open the panel and a draggable scrollbar reaches the first and last messages', { timeout: 5000 }, async t => {
  const mouseEvents = new EventEmitter();
  const view = fixture({ messages: [{ role: 'assistant', text: Array.from({ length: 90 }, (_, i) => `History paragraph ${i}`).join('\n\n') }] }, { mouseEvents });
  t.after(view.dispose);
  await view.ready();
  assert.match(view.app.lastFrame()!, /History paragraph 89/);
  const lines = view.app.lastFrame()!.split('\n'), thumb = lines.findIndex(line => line.includes('┃'));
  assert.ok(thumb >= 0, 'scroll thumb must be visible');
  const x = lines[thumb]!.indexOf('┃');
  mouseEvents.emit('mouse', { action: 'down', button: 0, x, y: thumb });
  mouseEvents.emit('mouse', { action: 'move', button: 0, x, y: 2 });
  mouseEvents.emit('mouse', { action: 'up', button: 0, x, y: 2 });
  await until(() => /History paragraph 0/.test(view.app.lastFrame()!), 'drag to the first paragraph');
  view.app.stdin.write('\u001b[6~');
  await until(() => !/History paragraph 0(?:\D|$)/.test(view.app.lastFrame()!), 'page down');
  await view.type('/setting');
  view.app.stdin.write('\r');
  await until(() => /SETTINGS/.test(view.app.lastFrame()!), 'open settings alias');
  assert.deepEqual(view.submissions, []);
});

test('TUI submits input, completes slash commands and recalls history', { timeout: 5000 }, async t => {
  const view = fixture();
  t.after(() => view.dispose());
  await view.ready();
  await view.type('Build a test');
  view.app.stdin.write('\r');
  await until(() => view.submissions.length === 1, 'submit input');
  assert.equal(view.submissions[0], 'Build a test');
  await view.type('/sta');
  await view.type('\t');
  assert.match(view.app.lastFrame()!, /\/status/);
  view.app.stdin.write('\r');
  await until(() => view.submissions.length === 2, 'submit completed command');
  assert.equal(view.submissions[1]?.trim(), '/status');
  await view.type('\u001b[A');
  view.app.stdin.write('\r');
  await until(() => view.submissions.length === 3, 'submit recalled command');
  assert.equal(view.submissions[2]?.trim(), '/status');
});

test('delayed clipboard paste preserves text typed while the clipboard is loading', { timeout: 5000 }, async t => {
  let resolveClipboard!: (value: string) => void;
  let started!: () => void;
  const clipboardStarted = new Promise<void>(resolve => { started = resolve; });
  const view = fixture({}, { readClipboard: () => { started(); return new Promise(resolve => { resolveClipboard = resolve; }); } });
  t.after(() => view.dispose());
  await view.ready();
  await view.type('base');
  view.app.stdin.write('\u0016');
  await clipboardStarted;
  await view.type(' typed');
  resolveClipboard(' pasted');
  await until(() => /base typed pasted/.test(view.app.lastFrame() || ''), 'append clipboard text to the latest draft');
});

test('API keys never appear in frames or recalled history', { timeout: 5000 }, async t => {
  const view = fixture();
  t.after(() => view.dispose());
  await view.ready();
  await view.type('public message');
  view.app.stdin.write('\r');
  await until(() => view.submissions.length === 1, 'submit public input');
  const key = 'placeholder-key-not-for-use';
  await view.type(`/key ${key}`);
  assert.match(view.app.lastFrame()!, /\/key/);
  assert.ok(!view.app.frames.some(frame => frame.includes(key)));
  view.app.stdin.write('\r');
  await until(() => view.submissions.length === 2, 'submit hidden key');
  assert.equal(view.submissions[1], `/key ${key}`);
  await view.type('\u001b[A');
  assert.match(view.app.lastFrame()!, /public message/);
  view.app.stdin.write('\r');
  await until(() => view.submissions.length === 3, 'submit public history item');
  assert.equal(view.submissions[2], 'public message');
  assert.ok(!view.app.frames.some(frame => frame.includes(key)));
});

test('approval prompts queue, deny and allow separately, and reject on unmount', { timeout: 5000 }, async t => {
  const view = fixture();
  t.after(() => view.dispose());
  await view.ready();
  const first = view.approve({ tool: 'write_file', description: 'First change', preview: '-old\n+new' });
  const second = view.approve({ tool: 'execute_command', description: 'Second change' });
  await until(() => /First change/.test(view.app.lastFrame() || ''), 'show first approval');
  assert.doesNotMatch(view.app.lastFrame()!, /Second change/);
  view.app.stdin.write('n');
  assert.equal(await first, false);
  await until(() => /Second change/.test(view.app.lastFrame() || ''), 'show queued approval');
  view.app.stdin.write('y');
  assert.equal(await second, true);
  const abandoned = view.approve({ tool: 'write_file', description: 'Abandoned change' });
  const queued = view.approve({ tool: 'write_file', description: 'Queued change' });
  await until(() => /Abandoned change/.test(view.app.lastFrame() || ''), 'show pending approval');
  view.app.unmount();
  assert.equal(await abandoned, false);
  assert.equal(await queued, false);
});

test('tool results expand per operation and show duration, errors and file diffs', { timeout: 5000 }, async t => {
  const mouseEvents = new EventEmitter();
  const view = fixture({ messages: [
    { role: 'tool', text: '', toolCallId: 'change-1', toolName: 'write_file', toolState: 'done', toolOutput: '--- a/file.txt\n+++ b/file.txt\n-old line\n+new line', toolDurationMs: 250 },
    { role: 'tool', text: '', toolCallId: 'shell-1', toolName: 'execute_command', toolState: 'error', toolOutput: 'Approval denied for the command.', toolDurationMs: 25 },
  ] }, { mouseEvents });
  t.after(() => view.dispose());
  await view.ready();
  assert.match(view.app.lastFrame()!, /Tool activity.*2 operations.*errors: 1/);
  assert.doesNotMatch(view.app.lastFrame()!, /old line|znaków/);
  assert.match(view.app.lastFrame()!, /Approval denied for the command/);
  const clickTool = (name: string) => {
    const rows = view.app.lastFrame()!.split('\n');
    const y = rows.findIndex(row => row.includes(name));
    assert.ok(y >= 0, `Missing tool row: ${name}`);
    mouseEvents.emit('mouse', { action: 'down', button: 0, x: 20, y });
    mouseEvents.emit('mouse', { action: 'up', button: 0, x: 20, y });
  };
  clickTool('Tool activity');
  await until(() => /Write file.*0\.3s/.test(view.app.lastFrame() || ''), 'expand operations');
  assert.match(view.app.lastFrame()!, /Terminal command.*error.*0\.0s/);
  clickTool('Write file');
  await until(() => /new line/.test(view.app.lastFrame() || ''), 'expand file diff');
  assert.match(view.app.lastFrame()!, /old line/);
  clickTool('Terminal command');
  await until(() => /Approval denied for the command/.test(view.app.lastFrame() || ''), 'expand tool error');
  assert.match(view.app.lastFrame()!, /old line/);
});

test('drag selection copies only the selected text without quitting; Shift+arrow extends it', async t => {
  const mouseEvents = new EventEmitter();
  const copied: string[] = [];
  const view = fixture({ messages: [{ role: 'assistant', text: 'Hello assistant' }] }, {
    mouseEvents, writeClipboard: async text => { copied.push(text); },
  });
  t.after(() => view.dispose());
  await view.ready();
  const lines = view.app.lastFrame()!.split('\n');
  const y = lines.findIndex(line => line.includes('Hello assistant'));
  const x = lines[y]!.indexOf('Hello assistant');
  mouseEvents.emit('mouse', { action: 'down', button: 0, x, y });
  mouseEvents.emit('mouse', { action: 'move', button: 0, x: x + 5, y });
  mouseEvents.emit('mouse', { action: 'up', button: 0, x: x + 5, y });
  view.app.stdin.write('\x03');
  await until(() => copied.length === 1, 'copy dragged selection');
  assert.equal(copied[0], 'Hello');
  assert.equal(view.closed, 0);
  assert.equal(view.cancelled, 0);
  view.app.stdin.write('\x1b[1;2C');
  await new Promise(resolve => setTimeout(resolve, 30));
  view.app.stdin.write('\x03');
  await until(() => copied.length === 2, 'copy keyboard extension');
  assert.equal(copied[1], 'Hello ');
});

test('aborting a pending approval removes it from the UI and its waiting queue', { timeout: 5000 }, async t => {
  const view = fixture();
  t.after(() => view.dispose());
  await view.ready();
  const activeAbort = new AbortController();
  const queuedAbort = new AbortController();
  const active = view.approve({ tool: 'write_file', description: 'Active approval' }, activeAbort.signal);
  const queued = view.approve({ tool: 'execute_command', description: 'Queued approval' }, queuedAbort.signal);
  await until(() => /Active approval/.test(view.app.lastFrame() || ''), 'show active approval');
  queuedAbort.abort();
  assert.equal(await queued, false);
  assert.doesNotMatch(view.app.lastFrame()!, /Queued approval/);
  activeAbort.abort();
  assert.equal(await active, false);
  await until(() => !/APPROVAL:/.test(view.app.lastFrame() || ''), 'clear cancelled approval');
});

test('Tab changes mode, Ctrl+P opens commands; Ctrl+C cancels work and closes idle UI', { timeout: 5000 }, async t => {
  const view = fixture();
  t.after(() => view.dispose());
  await view.ready();
  view.app.stdin.write('\t');
  await until(() => view.modeChanges === 1 && /Plan/.test(view.app.lastFrame() || ''), 'change mode');
  view.app.stdin.write('\u0010');
  await until(() => /Commands/.test(view.app.lastFrame() || ''), 'show command palette');
  view.app.stdin.write('\u001b');
  await until(() => !/Select a model.*ctrl\+k/.test(view.app.lastFrame() || ''), 'close command palette');
  view.update({ busy: true, status: 'Working', messages: [{ role: 'user', text: 'Zadanie w toku' }] });
  await until(() => /Working/.test(view.app.lastFrame() || ''), 'show active state');
  view.app.stdin.write('\u0003');
  await until(() => view.cancelled === 1, 'cancel active work');
  assert.equal(view.closed, 0);
  assert.equal(view.listeners.size, 1);
  view.update({ busy: false, status: 'Idle' });
  await until(() => /Idle/.test(view.app.lastFrame() || ''), 'show idle state');
  view.app.stdin.write('\u0003');
  await until(() => view.closed === 1 && view.listeners.size === 0, 'close idle UI');
});

test('closed controller status exits and removes the UI subscription', { timeout: 5000 }, async t => {
  const view = fixture();
  t.after(() => view.dispose());
  await view.ready();
  assert.equal(view.listeners.size, 1);
  view.update({ status: 'closed' });
  await until(() => view.listeners.size === 0, 'exit after /exit command');
});

test('Markdown strips hostile terminal controls and wraps Unicode and code', () => {
  const hostile = 'before\u001b[2J\u001b]52;c;clipboard-payload\u0007after\u0000\u009b';
  assert.equal(sanitizeTerminalText(hostile), 'beforeafter');
  const lines = markdownLines('# Heading\n\n**bold** and `inline`\n\n```typescript\nconst text = "你好👋";\n```\n\n[Docs](https://example.com)', 18);
  assert.ok(lines.some(line => line.bold && line.text.includes('Heading')));
  const plain = lines.map(line => sanitizeTerminalText(line.text)).join('\n');
  assert.match(plain, /bold and inline/);
  assert.match(plain, /const text/);
  assert.match(plain, /你好👋/);
  assert.ok(lines.every(line => stringWidth(line.text) <= 18));
  assert.ok(!markdownLines(hostile, 80).some(line => line.text.includes('clipboard-payload')));
});

test('unlabeled Markdown code blocks use English UI text', () => {
  assert.ok(markdownLines('```\nconst value = 1;\n```', 80).some(line => line.text.includes('code')));
});

test('stream updates parse only changed messages and invalidate cache after resize or role change', { timeout: 5000 }, async t => {
  const parser = t.mock.method(marked, 'lexer');
  const historic = { role: 'assistant', text: 'Historic **result**' };
  const current = { role: 'assistant', text: 'Streaming initial' };
  const view = fixture({ messages: [historic, current] });
  t.after(() => view.dispose());
  await view.ready();
  const callsFor = (text: string) => parser.mock.calls.filter(call => call.arguments[0] === text).length;
  assert.equal(callsFor(historic.text), 1);
  assert.equal(callsFor(current.text), 1);
  current.text += ' updated';
  view.update({ messages: [historic, current] });
  await until(() => /Streaming initial updated/.test(view.app.lastFrame() || ''), 'show changed message');
  assert.equal(callsFor(historic.text), 1);
  assert.equal(callsFor(current.text), 1);
  view.update({ status: 'Usage changed', usage: { input: 500, output: 10, cached: 0, cost: 0, costKnown: false } });
  await until(() => /Usage changed/.test(view.app.lastFrame() || ''), 'update status');
  assert.equal(callsFor(historic.text), 1);
  Object.defineProperty(view.app.stdout, 'columns', { configurable: true, value: 70 });
  view.app.stdout.emit('resize');
  await until(() => callsFor(historic.text) === 2, 'rewrap after terminal resize');
  historic.role = 'system';
  view.update({ messages: [historic, current] });
  await until(() => /Historic \*\*result\*\*/.test(view.app.lastFrame() || ''), 'invalidate changed message role');
  assert.equal(callsFor(historic.text), 2);
});

test('autocomplete includes runtime commands and failed agents leave active list', { timeout: 5000 }, async t => {
  const view = fixture({ messages: [{ role: 'user', text: 'Zadanie' }], agents: [{ id: 'failed', role: 'reviewer', status: 'error' }, { id: 'active', role: 'coder', status: 'running' }] });
  t.after(() => view.dispose());
  await view.ready();
  assert.match(view.app.lastFrame()!, /coder:running/);
  assert.doesNotMatch(view.app.lastFrame()!, /reviewer:error/);
  for (const [index, command] of ['/cancel', '/undo', '/memory', '/forget'].entries()) {
    await view.type(command.slice(0, -1));
    await view.type('\t');
    assert.ok(view.app.lastFrame()?.includes(command));
    view.app.stdin.write('\r');
    await until(() => view.submissions.length === index + 1, `submit completed ${command}`);
    assert.equal(view.submissions[index]?.trim(), command);
  }
});

test('minimal home centers a clean wordmark and compact composer without animation or startup logs', async t => {
  const view = fixture({ usage: { input: 0, output: 0, cached: 0, cost: 0, costKnown: true } });
  t.after(() => view.dispose()); await view.ready();
  const frame = view.app.lastFrame()!;
  assert.match(frame, /█/);
  assert.match(frame, /Describe the task or paste an error/);
  assert.match(frame, /Menu.*Alt\+M/);
  assert.doesNotMatch(frame, /SYSTEM|Ready|\$0\.00000|╭|╰|JANUSZGPT/);
  assert.doesNotMatch(frame, /Hint|Shared|ctrl\+b|What are we working on|╱╱/);
  const lines = frame.split('\n'); const prompt = lines.findIndex(line => line.includes('Describe the task'));
  assert.ok(prompt > 4 && prompt < lines.length - 4);
  assert.ok(lines[prompt]!.indexOf('Describe the task') >= 12);
});

test('model picker filters live catalog and persists chosen model; provider picker changes provider', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready();
  view.app.stdin.write('\u000b');
  await until(() => /acme\/fast/.test(view.app.lastFrame() || ''), 'load model picker');
  await view.type('deep'); view.app.stdin.write('\r');
  await until(() => view.modelsChosen.length === 1 && /acme\/deep/.test(view.app.lastFrame() || '') && !/Models \/ ENGINE/.test(view.app.lastFrame() || ''), 'select model');
  assert.deepEqual(view.modelsChosen, [{ id: 'acme/deep', persist: true }]);
  view.app.stdin.write('\u0010');
  await until(() => /Commands/.test(view.app.lastFrame() || ''), 'open commands');
  await view.type('/connect'); view.app.stdin.write('\r');
  await until(() => /API providers/.test(view.app.lastFrame() || ''), 'open providers');
  await view.type('google'); view.app.stdin.write('\r');
  await until(() => view.providersChosen.length === 1, 'choose provider');
  assert.deepEqual(view.providersChosen, ['google']);
});

test('reasoning picker lists model-supported choices and applies the selected effort', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready();
  await view.type('/effort'); view.app.stdin.write('\r');
  await until(() => /Reasoning effort/.test(view.app.lastFrame() || ''), 'open reasoning picker');
  assert.match(view.app.lastFrame()!, /Automatic/);
  assert.match(view.app.lastFrame()!, /Low/);
  assert.match(view.app.lastFrame()!, /High/);
  await view.type('high'); view.app.stdin.write('\r');
  await until(() => view.effortsChosen.length === 1, 'apply reasoning effort');
  assert.deepEqual(view.effortsChosen, ['high']);
});

test('model picker reports failures and Escape restores draft without executing a command', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready(); view.services.failModels = true;
  await view.type('Zachowaj tekst'); view.app.stdin.write('\u000b');
  await until(() => /HTTP 401/.test(view.app.lastFrame() || ''), 'show endpoint error');
  view.app.stdin.write('\u001b');
  await until(() => /Zachowaj tekst/.test(view.app.lastFrame() || ''), 'restore draft');
  assert.equal(view.submissions.length, 0);
});

test('compact terminals and light theme preserve editor and never render wider than terminal', async t => {
  const view = fixture({ theme: 'light' }); t.after(() => view.dispose()); await view.ready();
  Object.defineProperty(view.app.stdout, 'columns', { configurable: true, value: 42 });
  Object.defineProperty(view.app.stdout, 'rows', { configurable: true, value: 14 });
  view.app.stdout.emit('resize');
  await until(() => view.app.lastFrame()!.split('\n').every(line => stringWidth(line) <= 42), 'resize compact layout');
  assert.match(view.app.lastFrame()!, /PolonRLM/);
  assert.ok(view.app.lastFrame()!.split('\n').every(line => stringWidth(line) <= 42));
  await view.type('małe okno'); view.app.stdin.write('\r');
  await until(() => view.submissions.includes('małe okno'), 'submit in compact terminal');
});

test('failed model catalog keeps recovery actions and allows a manual model', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready();
  view.services.failModels = true;
  view.app.stdin.write('\u000b');
  await until(() => /HTTP 401/.test(view.app.lastFrame() || ''), 'show catalog error');
  assert.match(view.app.lastFrame()!, /Enter a model ID/);
  assert.match(view.app.lastFrame()!, /Change provider/);
  view.app.stdin.write('\u000e');
  await until(() => /MODEL \/ CUSTOM ID/.test(view.app.lastFrame() || ''), 'open manual input');
  await view.type('vendor/custom-model');
  view.app.stdin.write('\r');
  await until(() => view.modelsChosen.length === 1, 'save manual model');
  assert.deepEqual(view.modelsChosen, [{ id: 'vendor/custom-model', persist: true }]);
});

test('model recovery masks a pasted key, retries catalog and switches providers in place', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready();
  view.services.failModels = true;
  view.app.stdin.write('\u000b');
  await until(() => /HTTP 401/.test(view.app.lastFrame() || ''), 'show catalog error');
  view.app.stdin.write('\u000c');
  await until(() => /CONNECT \/ API KEY/.test(view.app.lastFrame() || ''), 'open secret input');
  const secret = 'dummy-recovery-key';
  await view.type('\u001b[200~' + secret + '\u001b[201~');
  assert.ok(!view.app.frames.some(frame => frame.includes(secret)));
  view.app.stdin.write('\r');
  await until(() => /acme\/fast/.test(view.app.lastFrame() || ''), 'reload after key save');
  assert.deepEqual(view.keysSaved, [secret]);
  assert.ok(!view.app.frames.some(frame => frame.includes(secret)));
  view.app.stdin.write('\u000c');
  await until(() => /CONNECT \/ API KEY/.test(view.app.lastFrame() || ''), 'reopen secret input');
  await view.type(secret);
  view.app.stdin.write('\u001b');
  await until(() => /Models \/ ENGINE/.test(view.app.lastFrame() || ''), 'cancel secret input');
  assert.ok(!view.app.frames.some(frame => frame.includes(secret)));
  view.app.stdin.write('\u0001');
  await until(() => /API providers/.test(view.app.lastFrame() || ''), 'open providers');
  await view.type('google'); view.app.stdin.write('\r');
  await until(() => /CONNECT \/ API KEY/.test(view.app.lastFrame() || ''), 'show key step for selected provider');
  view.app.stdin.write('\t');
  await until(() => /Provider: google/.test(view.app.lastFrame() || '') && /acme\/fast/.test(view.app.lastFrame() || ''), 'return to model catalog');
  assert.deepEqual(view.providersChosen, ['google']);
});

test('idle home stays still and preserves draft without background timers', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready();
  await new Promise(resolve => setTimeout(resolve, 80));
  const idle = view.app.frames.length;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(view.app.frames.length, idle);
  await view.type('Nie przeszkadzaj podczas pisania');
  await new Promise(resolve => setTimeout(resolve, 80));
  const typing = view.app.frames.length;
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(view.app.frames.length, typing);
  assert.match(view.app.lastFrame()!, /Nie przeszkadzaj podczas pisania/);
});

test('provider wizard selects Google, NVIDIA, Mistral and OpenAI and permits keeping an existing key', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready();
  for (const id of ['google', 'nvidia', 'mistral', 'openai']) {
    view.app.stdin.write('\u000f');
    await until(() => /API providers/.test(view.app.lastFrame() || ''), 'open provider picker');
    await view.type(id); view.app.stdin.write('\r');
    await until(() => /CONNECT \/ API KEY/.test(view.app.lastFrame() || ''), 'open key step');
    view.app.stdin.write('\t');
    await until(() => new RegExp('Provider: ' + id).test(view.app.lastFrame() || ''), 'open chosen provider models');
    view.app.stdin.write('\u001b');
    await until(() => !/Models \/ ENGINE/.test(view.app.lastFrame() || ''), 'close picker');
  }
  assert.deepEqual(view.providersChosen, ['google', 'nvidia', 'mistral', 'openai']);
});

test('custom endpoint wizard saves URL, model and a masked pasted key', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready();
  view.app.stdin.write('\u000f');
  await until(() => /API providers/.test(view.app.lastFrame() || ''), 'open provider picker');
  await view.type('custom'); view.app.stdin.write('\r');
  await until(() => /CONNECT \/ CUSTOM ENDPOINT/.test(view.app.lastFrame() || ''), 'open endpoint form');
  await view.type('\t'); await view.type('\u0015');
  await view.type('https://gateway.example/v1');
  await view.type('\t'); await view.type('\u0015'); await view.type('my-model');
  await view.type('\t'); await view.type('\u001b[200~dummy-custom-secret\u001b[201~');
  view.app.stdin.write('\r');
  await until(() => view.endpointsSaved.length === 1, 'save custom endpoint');
  assert.deepEqual(view.endpointsSaved, [{ provider: { id: 'custom', kind: 'compatible', baseURL: 'https://gateway.example/v1', model: 'my-model' }, apiKey: 'dummy-custom-secret' }]);
  assert.ok(!view.app.frames.some(frame => frame.includes('dummy-custom-secret')));
});

test('clicking the API input preserves paste focus; Ctrl+V, right click and paste button work', async t => {
  const mouseEvents = new EventEmitter();
  const secret = 'dummy-clipboard-key';
  const view = fixture({}, { mouseEvents, readClipboard: async () => secret });
  t.after(() => view.dispose()); await view.ready();
  view.app.stdin.write('\u000b');
  await until(() => /Models \/ ENGINE/.test(view.app.lastFrame() || ''), 'open models');
  view.app.stdin.write('\u000c');
  await until(() => /Paste API key/.test(view.app.lastFrame() || ''), 'open API field');
  const clickText = (needle: string, button: number) => {
    const lines = view.app.lastFrame()!.split('\n');
    const y = lines.findIndex(line => line.includes(needle)); assert.ok(y >= 0);
    mouseEvents.emit('mouse', { action: 'down', button, x: lines[y]!.indexOf(needle), y });
  };
  clickText('Paste API key', 0);
  view.app.stdin.write('\u0016');
  await until(() => /•{5}/.test(view.app.lastFrame() || ''), 'paste with Ctrl+V after mouse focus');
  await view.type('\u0015'); clickText('Paste API key', 2);
  await until(() => /•{5}/.test(view.app.lastFrame() || ''), 'paste with right click');
  await view.type('\u0015'); clickText('Paste from clipboard', 0);
  await until(() => /•{5}/.test(view.app.lastFrame() || ''), 'paste with explicit button');
  view.app.stdin.write('\r');
  await until(() => view.keysSaved.length === 1, 'save clipboard key');
  assert.deepEqual(view.keysSaved, [secret]);
  assert.ok(!view.app.frames.some(frame => frame.includes(secret)));
});

test('Alt shortcuts navigate menus without Ctrl combinations', async t => {
  const view = fixture(); t.after(() => view.dispose()); await view.ready();
  view.app.stdin.write('\u001bd');
  await until(() => /API providers/.test(view.app.lastFrame() || ''), 'open providers with Alt+D');
  view.app.stdin.write('\u001bl');
  await until(() => /Models \/ ENGINE/.test(view.app.lastFrame() || ''), 'open models with Alt+L');
  view.app.stdin.write('\u001bm');
  await until(() => /Commands \/ PolonRLM/.test(view.app.lastFrame() || ''), 'open menu with Alt+M');
});
