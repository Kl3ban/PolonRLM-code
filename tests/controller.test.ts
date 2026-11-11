import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { Controller } from '../src/core/controller.js';
import { ConfigManager, defaultSettings, settingsSchema } from '../src/core/config.js';
import { SessionStore } from '../src/core/store.js';
import { SETTINGS_FIELDS } from '../src/core/settings-fields.js';
import type { Message, RuntimeEvent, Settings } from '../src/core/types.js';

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-controller-'));
  const root = path.join(folder, 'project'); const home = path.join(folder, 'home'); await mkdir(root);
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = new ConfigManager(home); await config.load();
  config.settings.provider = 'custom';
  config.settings.verificationMode = 'manual';
  config.settings.providers.custom = { id: 'custom', kind: 'compatible', baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'test-model' };
  config.settings.cortex = 0; config.settings.maxOutputTokens = 128; config.settings.timeoutMs = 5000;
  await config.save();
  return { root, home, config, async dispose() {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
    await rm(folder, { recursive: true, force: true });
  } };
}

function chunk(response: ServerResponse, delta: Record<string, unknown>, finish: string | null = null): void {
  response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function finish(response: ServerResponse): void {
  response.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}
async function body(request: IncomingMessage): Promise<Record<string, any>> {
  let value = ''; for await (const piece of request) value += piece; return JSON.parse(value);
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) assert.fail('Controller did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('/goal continues work, tracks cumulative usage and persists completion', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  const store = (controller as any).store as SessionStore;
  const session = controller.snapshot().sessionId;
  store.savePlan(session, [{ step: 'Old task step', status: 'in_progress' }]);
  let runs = 0;
  (controller as any).runtime.run = async (session: string) => {
    runs++;
    store.recordUsage(session, { input: 100, output: 20, cached: 0, cost: 0, costKnown: true });
    if (runs === 2) { const w = store.workflow(session); w.goal!.status = 'complete'; w.goal!.evidence = 'Outputs checked'; store.saveWorkflow(session, w); }
    return 'Progress';
  };
  await controller.submit('/goal --tokens 4000 Implement feature');
  assert.equal(runs, 2);
  const goal = store.workflow(controller.snapshot().sessionId).goal!;
  assert.equal(goal.status, 'complete'); assert.equal(goal.usedTokens, 240);
  assert.equal(store.workflow(controller.snapshot().sessionId).plan, undefined, 'new goal must not inherit a stale task plan');
  await controller.submit('/goal clear');
  assert.equal(store.workflow(controller.snapshot().sessionId).goal, undefined);
});

test('/agents shows active and persisted subagent runs', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  await controller.submit('/agents');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /Active: none\.\nRecent persisted runs: none\./);
  const store = (controller as any).store as SessionStore;
  store.saveAgentRun({ session: controller.snapshot().sessionId, id: 'saved-1', role: 'reviewer', task: 'Review the parser', status: 'done', output: 'Reviewed.', changedFiles: ['src/parser.ts'], startedAt: 1, updatedAt: 2 });
  await controller.submit('/agents');
  const output = controller.snapshot().messages.at(-1)?.text ?? '';
  assert.match(output, /Recent persisted runs:/);
  assert.match(output, /saved-1 · reviewer · done · 1 file/);
});

test('/sandbox on, off, and auto switch isolation and explain readiness', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  const sandbox = (controller as any).sandbox;
  sandbox.status = async (_cwd: string, mode: string) => ({ mode, available: true, backend: 'test-sandbox', reason: 'test backend ready' });

  await controller.submit('/sandbox on');
  assert.equal(controller.config.settings.sandboxMode, 'required');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /required \(test-sandbox\)/);

  await controller.submit('/sandbox status');
  const status = controller.snapshot().messages.at(-1)?.text ?? '';
  assert.match(status, /Ready: yes/);
  assert.match(status, /Execution: test-sandbox isolation is ready/);
  assert.match(status, /Network: sandboxed commands may reach no hosts/);

  await controller.submit('/sandbox off');
  assert.equal(controller.config.settings.sandboxMode, 'off');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /host under the normal permission policy/);

  await controller.submit('/sandbox auto');
  assert.equal(controller.config.settings.sandboxMode, 'auto');

  sandbox.status = async (_cwd: string, mode: string) => ({ mode, available: false, backend: 'test-sandbox', reason: 'not provisioned' });
  await controller.submit('/sandbox on');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /Cannot enable required isolation: not provisioned/);
  assert.equal(controller.config.settings.sandboxMode, 'auto', 'a failed switch must not change the saved mode');
});

test('/settings persists validated subagent tool profiles', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  await controller.submit('/settings agentToolProfiles {"reviewer":["read_file","search_files"]}');
  assert.deepEqual(controller.config.settings.agentToolProfiles, { reviewer: ['read_file', 'search_files'] });
  const reopened = new ConfigManager(f.home); await reopened.load();
  assert.deepEqual(reopened.settings.agentToolProfiles, { reviewer: ['read_file', 'search_files'] });
  await controller.submit('/settings');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /Subagent tool profiles: \{"reviewer":\["read_file","search_files"\]\}/);
  assert.equal(settingsSchema.safeParse({ ...defaultSettings(), agentToolProfiles: { reviewer: ['read_file', 'read_file'] } }).success, false);
});

test('/plugins require reviewing the exact source hash before running trusted code', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home);
  t.after(async () => { await controller.close(); await f.dispose(); });
  const id = 'review-gate';
  const marker = `__polonrlm_controller_plugin_${Date.now()}`;
  const entry = path.join(f.home, 'plugins', id, 'index.mjs');

  await controller.submit(`/plugins create ${id}`);
  await writeFile(entry, `globalThis[${JSON.stringify(marker)}] = 'version one'; export default { id: ${JSON.stringify(id)}, version: '1.0.0', activate() {} };`, 'utf8');
  await controller.submit(`/plugins enable ${id}`);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined, 'review must not evaluate the module');

  await writeFile(entry, `globalThis[${JSON.stringify(marker)}] = 'changed after review'; export default { id: ${JSON.stringify(id)}, version: '1.0.0', activate() {} };`, 'utf8');
  await controller.submit(`/plugins enable ${id} confirm`);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined, 'edited code must not run under a previous review');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /NOT started because its files were not the version from the last review/);

  await controller.submit(`/plugins enable ${id}`);
  await controller.submit(`/plugins enable ${id} confirm`);
  assert.equal((globalThis as Record<string, unknown>)[marker], 'changed after review');
  assert.equal(controller.config.settings.plugins[id]?.enabled, true);
  assert.match(controller.config.settings.plugins[id]?.sha256 ?? '', /^[a-f0-9]{64}$/);

  await controller.submit('/settings plugins');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /Use \/plugins/);
  await controller.submit(`/plugins disable ${id}`);
  assert.equal(controller.config.settings.plugins[id]?.enabled, false);
});

test('/sandbox setup previews system changes without installing anything', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  await controller.submit('/sandbox setup');
  const message = controller.snapshot().messages.at(-1)?.text ?? '';
  assert.match(message, /machine-wide network filter/i);
  assert.match(message, /skips user-profile read grants/i);
  assert.match(message, /\/sandbox setup confirm/i);
  assert.equal(controller.config.settings.sandboxMode, 'auto');
});

test('every settings-panel field validates, persists, reloads, and reads back its configured value', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home);
  t.after(async () => { await controller.close(); await f.dispose(); });
  const values = {
    mode: 'REVIEW', cortex: 5, permissions: 'workspace', theme: 'light', webSearchMode: 'yahoo', browserEngine: 'edge',
    verificationCommands: '["npm test","npm run check"]', verificationMode: 'after_changes', verificationRepairAttempts: 2, sandboxMode: 'required', sandboxNetworkDomains: '["registry.npmjs.org","github.com"]',
    fallback: '["google"]', agentToolProfiles: '{"reviewer":["read_file","search_files"]}',
    modelRoutes: '{"coder":{"provider":"google","model":"test-code"},"reviewer":{"provider":"custom"}}',
    modelRoleBudgets: '{"coder":{"maxCalls":12,"maxTokens":32000,"maxCost":0.75}}', cortexStrategy: 'fixed', repeatFailureThreshold: 5,
    tokenBudget: 8000, dollarBudget: 1.25, maxInputTokens: 80000, maxOutputTokens: 16000, maxSteps: 128, maxAgents: 8,
    maxProcesses: 6, maxDepth: 3, timeoutMs: 35000, toolOutputLimit: 300000,
  } satisfies Record<string, string | number>;
  assert.deepEqual(Object.keys(values).sort(), SETTINGS_FIELDS.map(field => field.key).sort());

  for (const [name, value] of Object.entries(values)) await controller.updateSetting(name, value);
  await controller.submit('/permissions read_file off');
  await controller.submit('/permissions allow read_file');
  await controller.submit('/permissions deny execute_command');

  const view = controller.readSettings().values;
  for (const [name, value] of Object.entries(values)) assert.deepEqual(view[name], value, `readSettings(${name})`);
  const reopened = new ConfigManager(f.home);
  await reopened.load();
  const jsonFields = new Set(['verificationCommands', 'sandboxNetworkDomains', 'fallback', 'agentToolProfiles', 'modelRoutes', 'modelRoleBudgets']);
  for (const [name, value] of Object.entries(values)) {
    const expected = jsonFields.has(name) ? JSON.parse(value as string) : value;
    assert.deepEqual(reopened.settings[name as keyof Settings], expected, `persisted ${name}`);
  }
  assert.equal(reopened.settings.toolPermissions.read_file, 'off');
  assert.deepEqual(reopened.settings.allowTools, ['read_file']);
  assert.deepEqual(reopened.settings.denyTools, ['execute_command']);
});

test('/settings persists role model budgets', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  await controller.submit('/settings modelRoleBudgets {"coder":{"maxCalls":30,"maxTokens":50000,"maxCost":1}}');
  assert.deepEqual(controller.config.settings.modelRoleBudgets, { coder: { maxCalls: 30, maxTokens: 50000, maxCost: 1 } });
  const reopened = new ConfigManager(f.home); await reopened.load();
  assert.deepEqual(reopened.settings.modelRoleBudgets, { coder: { maxCalls: 30, maxTokens: 50000, maxCost: 1 } });
  assert.match(controller.readSettings().values.modelRoleBudgets, /"coder"/);
});

test('/settings lets the user choose adaptive or fixed Cortex strategy', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  await controller.submit('/settings cortexStrategy fixed');
  assert.equal(controller.config.settings.cortexStrategy, 'fixed');
  const reopened = new ConfigManager(f.home); await reopened.load();
  assert.equal(reopened.settings.cortexStrategy, 'fixed');
  await controller.submit('/settings cortexStrategy adaptive');
  assert.equal(controller.config.settings.cortexStrategy, 'adaptive');
});

test('/settings persists the repeated failure warning threshold', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home);
  t.after(async () => { await controller.close(); await f.dispose(); });
  await controller.submit('/settings repeatFailureThreshold 5');
  assert.equal(controller.config.settings.repeatFailureThreshold, 5);
  const reopened = new ConfigManager(f.home); await reopened.load();
  assert.equal(reopened.settings.repeatFailureThreshold, 5);
});

test('/timeline shows persisted evidence and validates its event count', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  const store = (controller as any).store as SessionStore;
  store.audit(controller.snapshot().sessionId, 'run_tests', { arguments: { command: 'npm test' }, result: 'private result', isError: false, agent: 'tester', durationMs: 12 });
  await controller.submit('/timeline');
  const output = controller.snapshot().messages.at(-1)?.text ?? '';
  assert.match(output, /EVIDENCE TIMELINE/);
  assert.match(output, /TOOL DONE.*tester.*Run tests/);
  assert.match(output, /No \/verify report is recorded/);
  assert.doesNotMatch(output, /private result/);
  await controller.submit('/timeline 0');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /whole number from 1 to 200/);
});

test('/fallback edits ordered providers, persists, and rejects invalid choices', async t => {
  const f = await fixture();
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  await controller.submit('/fallback google,openrouter');
  assert.deepEqual(controller.config.settings.fallback, ['google', 'openrouter']);
  const reopened = new ConfigManager(f.home); await reopened.load();
  assert.deepEqual(reopened.settings.fallback, ['google', 'openrouter']);
  await controller.submit('/fallback');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /google.*openrouter/s);
  await controller.selectProvider('google');
  assert.deepEqual(controller.config.settings.fallback, ['openrouter']);
  await controller.selectProvider('custom');
  await controller.submit('/fallback google,openrouter');
  await controller.submit('/fallback google google');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /List each fallback provider once/);
  assert.deepEqual(controller.config.settings.fallback, ['google', 'openrouter']);
  await controller.submit('/fallback custom');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /selected provider cannot also be a fallback/);
  await controller.submit('/fallback missing-provider');
  assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /Unknown provider/);
  assert.deepEqual(controller.config.settings.fallback, ['google', 'openrouter']);
  await controller.submit('/fallback none');
  assert.deepEqual(controller.config.settings.fallback, []);
});

test('a corrupt unrelated DPAPI key leaves startup and provider switching available', { skip: process.platform !== 'win32' }, async t => {
  const previous = process.env.NVIDIA_API_KEY; delete process.env.NVIDIA_API_KEY;
  t.after(() => { if (previous === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = previous; });
  const f = await fixture();
  const credentials = path.join(f.home, 'credentials'); await mkdir(credentials);
  await writeFile(path.join(credentials, Buffer.from('nvidia').toString('hex') + '.dpapi'), 'broken-DPAPI-data');
  const controller = await Controller.open(f.root, f.home); t.after(async () => { await controller.close(); await f.dispose(); });
  assert.match(controller.snapshot().messages.map(message => message.text).join('\n'), /key nvidia/);
  await controller.selectProvider('openai');
  assert.equal(controller.snapshot().provider, 'openai');
});

test('controller starts on a fresh chat database and reports the preserved corrupted files', async () => {
  const f = await fixture();
  await writeFile(path.join(f.home, 'sessions.sqlite'), 'not a SQLite database');
  const controller = await Controller.open(f.root, f.home);
  try {
    assert.equal(controller.integrityCheck(), 'ok');
    assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /chat database failed its integrity check/i);
    assert.ok((await readdir(f.home)).some(name => name.startsWith('sessions.sqlite.corrupt-')));
  } finally {
    await controller.close();
    await f.dispose();
  }
});

test('file recovery journal survives restart, encrypts snapshots and restores an unfinished transaction safely', async t => {
  const f = await fixture();
  let controller = await Controller.open(f.root, f.home);
  try {
    controller.setApprover(async () => true);
    const workspace = (controller as any).workspace;
    const filename = path.join(f.root, 'recovery.txt');
    await writeFile(filename, 'before snapshot');
    const group = await workspace.beginTransaction('restart check');
    await workspace.change('write_file', 'recovery.txt', () => 'after snapshot', 'BUILD');
    const saved = await readFile(path.join(f.home, 'sessions.sqlite'));
    assert.equal(saved.includes(Buffer.from('before snapshot')), false);
    assert.equal(saved.includes(Buffer.from('after snapshot')), false);
    await controller.close();

    controller = await Controller.open(f.root, f.home);
    controller.setApprover(async () => true);
    const reopened = (controller as any).workspace;
    const status = reopened.recoveryStatus();
    assert.ok(status.groups.some((item: any) => item.id === group.id && item.state === 'running'));
    assert.ok(status.changes.some((item: any) => item.path === 'recovery.txt' && item.state === 'applied'));
    const result = await reopened.rollbackRecovery(group.id.slice(0, 8), 'BUILD');
    assert.deepEqual(result.restored, ['recovery.txt']);
    assert.equal(await readFile(filename, 'utf8'), 'before snapshot');
    assert.equal(reopened.changeHistory(10)[0]?.state, 'rolled_back');

    await reopened.change('write_file', 'recovery.txt', () => 'agent edit', 'BUILD');
    const edit = reopened.changeHistory(1)[0]!;
    await writeFile(filename, 'external edit');
    const conflict = await reopened.rollbackRecovery(edit.id.slice(0, 8), 'BUILD');
    assert.equal(conflict.failed, 'recovery.txt');
    assert.equal(await readFile(filename, 'utf8'), 'external edit');
    assert.equal(reopened.changeHistory(1)[0]?.state, 'conflict');

    const encoded = path.join(f.root, 'encoded.txt');
    const originalBytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('checkpoint original', 'utf16le')]);
    await writeFile(encoded, originalBytes);
    const checkpoint = await reopened.createCheckpoint('encoding restore', ['encoded.txt']);
    await writeFile(encoded, 'later utf8 content', 'utf8');
    const diff = await reopened.diffCheckpoint(checkpoint.id);
    const expected = Object.fromEntries(diff.files.map((file: any) => [file.path, file.currentHash]));
    await controller.close();
    controller = await Controller.open(f.root, f.home);
    controller.setApprover(async () => true);
    const restored = await (controller as any).workspace.restoreCheckpoint(checkpoint.id.slice(0, 8), expected, 'BUILD');
    assert.deepEqual(restored.applied, ['encoded.txt']);
    assert.deepEqual(await readFile(encoded), originalBytes);
    assert.ok((controller as any).workspace.listCheckpoints().some((item: any) => item.id === checkpoint.id));
  } finally {
    await controller.close(); await f.dispose();
  }
});

test('/image attaches a local photo to the next prompt without persisting binary data', async () => {
  let request: any;
  const f = await fixture(async (req, response) => { request = await body(req); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); chunk(response, { content: 'Photo received.' }, 'stop'); finish(response); });
  const controller = await Controller.open(f.root, f.home);
  try {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    const filename = path.join(f.root, 'photo with spaces.png'); await writeFile(filename, Buffer.from(data, 'base64'));
    await controller.submit('/image "' + filename + '"');
    assert.match(controller.snapshot().messages.at(-1)!.text, /Attached image/);
    await controller.submit('Describe this photo.');
    assert.match(controller.snapshot().messages.find(message => message.role === 'user')!.text, /Attached: photo with spaces.png/);
    assert.ok(JSON.stringify(request.messages).includes('data:image/png;base64,' + data));
    assert.equal(controller.snapshot().status, 'Ready');
    controller.addImageData(data);
    await controller.submit('');
    assert.ok(JSON.stringify(request.messages).includes('data:image/png;base64,' + data));
    assert.ok(controller.snapshot().messages.some(message => message.role === 'user' && /Describe the attached image.*\n\[Attached: Screenshot.png\]/.test(message.text)));
    const store = new SessionStore(f.home);
    try { assert.equal(JSON.stringify(store.messages(store.list(controller.snapshot().workspace)[0]!.id)).includes(data), false); } finally { store.close(); }
    for (let index = 0; index < 5; index++) controller.addImageData(data, `screen-${index + 1}.png`);
    assert.equal(controller.snapshot().attachments.length, 5);
    assert.throws(() => controller.addImageData(data), /Up to 5 images per message/);
    controller.removeImage(2);
    assert.equal(controller.snapshot().attachments.length, 4);
  } finally { await controller.close(); await f.dispose(); }
});

test('/image uses a vision-capable fallback when the primary model cannot receive images', async () => {
  let request: any;
  const f = await fixture(async (req, response) => {
    request = await body(req);
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); chunk(response, { content: 'Vision fallback received the photo.' }, 'stop'); finish(response);
  });
  f.config.settings.fallback = ['vision'];
  f.config.settings.providers.custom!.vision = false;
  f.config.settings.providers.vision = { ...f.config.settings.providers.custom!, id: 'vision', model: 'vision-model', vision: true, toolCalling: true };
  await f.config.save();
  const controller = await Controller.open(f.root, f.home);
  try {
    const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    const filename = path.join(f.root, 'photo.png'); await writeFile(filename, Buffer.from(data, 'base64'));
    await controller.submit('/image "' + filename + '"');
    await controller.submit('Describe this photo.');
    assert.equal(request.model, 'vision-model');
    assert.ok(JSON.stringify(request.messages).includes('data:image/png;base64,' + data));
    assert.equal(controller.snapshot().status, 'Ready');
  } finally { await controller.close(); await f.dispose(); }
});

test('controller streams real tool execution and resumes persisted history past empty startup sessions', { timeout: 15000 }, async () => {
  let calls = 0; const requests: Record<string, any>[] = [];
  const local = await fixture(async (request, response) => {
    requests.push(await body(request)); calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (calls === 1) {
      chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'write-1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'Written by the agent\n' }) } }] });
      chunk(response, {}, 'tool_calls');
    } else { chunk(response, { role: 'assistant', content: 'Verified result.' }); chunk(response, {}, 'stop'); }
    finish(response);
  });
  let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    const approvals: string[] = []; controller.setApprover(async request => { approvals.push(request.tool); assert.match(request.preview || '', /Written by the agent/); return true; });
    const events: RuntimeEvent[] = []; controller.onEvent = event => events.push(event);
    await controller.submit('Create result.txt with the provided content.');
    assert.equal(controller.snapshot().status, 'Ready');
    assert.equal(await readFile(path.join(local.root, 'result.txt'), 'utf8'), 'Written by the agent\n');
    assert.deepEqual(approvals, ['write_file']); assert.equal(calls, 2);
    assert.ok(requests[1]!.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'write-1'));
    assert.ok(events.some(event => event.type === 'tool' && event.state === 'done'));
    assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'Verified result.');
    assert.equal(controller.snapshot().usage.input, 200);
    await controller.close();
    controller = await Controller.open(local.root, local.home); await controller.close();
    controller = await Controller.open(local.root, local.home); controller.resumeSession();
    assert.ok(controller.snapshot().messages.some(message => message.text.includes('Create result.txt')));
    assert.ok(controller.snapshot().messages.some(message => message.text === 'Verified result.'));
    assert.equal(controller.snapshot().usage.output, 40);
    assert.throws(() => controller!.resumeSession('missing-session'), /No session was found/);
  } finally { await controller?.close(); await local.dispose(); }
});

test('HTTP adapter tool call reaches a real workspace tool and its result returns on the next request', { timeout: 15000 }, async () => {
  const requests: Record<string, any>[] = [];
  const local = await fixture(async (request, response) => {
    requests.push(await body(request));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (requests.length === 1) {
      chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'note.txt' }) } }] });
      chunk(response, {}, 'tool_calls');
    } else {
      chunk(response, { role: 'assistant', content: 'The file says: MODEL_TOOL_ROUNDTRIP_OK.' }, 'stop');
    }
    finish(response);
  });
  await writeFile(path.join(local.root, 'note.txt'), 'MODEL_TOOL_ROUNDTRIP_OK\n', 'utf8');
  let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    await controller.submit('Read note.txt and report its exact contents.');
    const state = controller.snapshot();
    assert.equal(state.status, 'Ready');
    assert.equal(requests.length, 2);
    assert.ok((requests[0]!.tools as any[]).some(tool => tool.function?.name === 'read_file'));
    const followupMessages = requests[1]!.messages as any[];
    assert.ok(followupMessages.some(message => message.role === 'assistant' && message.tool_calls?.some((call: any) => call.id === 'read-1')));
    assert.ok(followupMessages.some(message => message.role === 'tool' && message.tool_call_id === 'read-1' && String(message.content).includes('MODEL_TOOL_ROUNDTRIP_OK')));
    assert.ok(state.messages.some(message => message.role === 'tool' && message.toolName === 'read_file' && message.toolOutput?.includes('MODEL_TOOL_ROUNDTRIP_OK')));
    assert.ok(state.messages.some(message => message.role === 'assistant' && message.text.includes('MODEL_TOOL_ROUNDTRIP_OK')));
  } finally { await controller?.close(); await local.dispose(); }
});

test('controller commands persist config and transient model overrides clear stale metadata', { timeout: 10000 }, async () => {
  const local = await fixture((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'discovered', context_length: 8192, max_completion_tokens: 1024, supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } }] })); });
  let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    await controller.submit('/models'); await controller.submit('/model 1');
    assert.equal(controller.snapshot().model, 'discovered');
    assert.equal(controller.config.settings.providers.custom!.contextWindow, 8192);
    assert.equal(controller.config.settings.providers.custom!.maxOutputTokens, 1024);
    assert.equal(controller.config.settings.providers.custom!.reasoningSupported, false);
    assert.equal(controller.snapshot().contextLimit, 8064);
    assert.equal(controller.snapshot().contextLimitSource, 'model');
    await controller.submit('/settings maxInputTokens 2048');
    assert.equal(controller.snapshot().contextLimit, 2048);
    assert.equal(controller.snapshot().contextLimitSource, 'app');
    await controller.submit('/settings maxInputTokens infinity');
    assert.equal(controller.snapshot().contextLimitSource, 'model');
    await controller.submit('/settings verificationCommands ["npm test", "npm run check"]');
    assert.deepEqual(controller.config.settings.verificationCommands, ['npm test', 'npm run check']);
    assert.equal(controller.readSettings().values.verificationCommands, '["npm test","npm run check"]');
    await controller.submit('/settings sandboxNetworkDomains ["registry.npmjs.org","github.com"]');
    assert.deepEqual(controller.config.settings.sandboxNetworkDomains, ['registry.npmjs.org', 'github.com']);
    assert.equal(controller.readSettings().values.sandboxNetworkDomains, '["registry.npmjs.org","github.com"]');
    await controller.submit('/settings sandboxMode required');
    assert.equal(controller.config.settings.sandboxMode, 'required');
    await controller.submit('/settings sandboxMode invalid');
    assert.equal(controller.config.settings.sandboxMode, 'required');
    assert.equal(controller.config.settings.providers.custom!.inputPrice, 1);
    await controller.setModel('cli-override');
    assert.equal(controller.snapshot().model, 'cli-override');
    assert.equal(controller.config.settings.providers.custom!.contextWindow, undefined);
    assert.equal(controller.config.settings.providers.custom!.maxOutputTokens, undefined);
    assert.equal(controller.config.settings.providers.custom!.reasoningSupported, undefined);
    assert.equal(controller.config.settings.providers.custom!.inputPrice, undefined);
    const saved = new ConfigManager(local.home); await saved.load();
    assert.equal(saved.settings.providers.custom!.model, 'discovered');
    await controller.submit('/mode REVIEW'); await controller.submit('/cortex 3'); await controller.submit('/permissions readonly'); await controller.submit('/settings theme light'); await controller.submit('/settings browserEngine edge');
    assert.equal(controller.snapshot().mode, 'REVIEW'); assert.equal(controller.snapshot().cortex, 3); assert.equal(controller.snapshot().theme, 'light'); assert.equal(controller.config.settings.browserEngine, 'edge');
    await controller.submit('/settings cortex 99'); assert.equal(controller.snapshot().cortex, 3);
    const providers = controller.config.settings.providers; const provider = providers.custom; const mcp = controller.config.settings.mcp;
    await controller.submit('/settings provider.reasoning low');
    await controller.submit('/settings provider.reasoningControl effort');
    await controller.submit('/settings provider.reasoningEfforts ["low","high"]');
    await controller.submit('/settings provider.requestTimeoutMs 0');
    assert.equal(provider?.requestTimeoutMs, 0);
    const inheritedTimeout = new ConfigManager(local.home); await inheritedTimeout.load();
    assert.equal(inheritedTimeout.settings.providers.custom?.requestTimeoutMs, 0);
    await controller.submit('/settings provider.requestTimeoutMs 123456');
    await controller.submit('/settings provider.temperature 0.2');
    await controller.submit('/settings provider.inputPrice 1.5');
    await controller.submit('/settings provider.outputPrice 3');
    await controller.submit('/settings provider.toolCalling false');
    await controller.submit('/settings provider.vision true');
    await controller.submit('/settings provider.contextWindow 65000');
    await controller.submit('/settings provider.maxOutputTokens 2048');
    await controller.submit('/settings provider.reasoningSupported true');
    await controller.submit('/settings provider.apiKeyEnv TEST_ONLY_API_KEY');
    await controller.submit('/settings provider.kind compatible');
    assert.equal(controller.config.settings.providers, providers); assert.equal(providers.custom, provider); assert.equal(controller.config.settings.mcp, mcp);
    assert.deepEqual({ reasoning: provider?.reasoning, reasoningControl: provider?.reasoningControl, reasoningEfforts: provider?.reasoningEfforts, requestTimeoutMs: provider?.requestTimeoutMs, temperature: provider?.temperature, inputPrice: provider?.inputPrice, outputPrice: provider?.outputPrice, toolCalling: provider?.toolCalling, vision: provider?.vision, contextWindow: provider?.contextWindow, maxOutputTokens: provider?.maxOutputTokens, reasoningSupported: provider?.reasoningSupported, apiKeyEnv: provider?.apiKeyEnv }, { reasoning: 'low', reasoningControl: 'effort', reasoningEfforts: ['low', 'high'], requestTimeoutMs: 123456, temperature: 0.2, inputPrice: 1.5, outputPrice: 3, toolCalling: false, vision: true, contextWindow: 65000, maxOutputTokens: 2048, reasoningSupported: true, apiKeyEnv: 'TEST_ONLY_API_KEY' });
    await controller.submit('/settings provider.temperature 8'); assert.equal(provider?.temperature, 0.2);
    await controller.submit('/settings provider.kind invalid'); assert.equal(provider?.kind, 'compatible');
    await controller.submit('/settings provider.inputPrice -1'); assert.equal(provider?.inputPrice, 1.5);
    await controller.submit('/settings provider.id forbidden'); assert.equal(provider?.id, 'custom');
    await controller.submit('/connect toString'); assert.equal(controller.snapshot().provider, 'custom');
    await controller.submit('/mcp add example {"type":"http","url":"http://127.0.0.1:4444/mcp"}');
    assert.ok(controller.config.settings.mcp.example);
    await controller.submit('/mcp remove example'); assert.equal(controller.config.settings.mcp.example, undefined);
    await saved.load(); assert.equal(saved.settings.mode, 'REVIEW'); assert.equal(saved.settings.permissions, 'readonly'); assert.equal(saved.settings.theme, 'light'); assert.equal(saved.settings.browserEngine, 'edge'); assert.equal(saved.settings.providers.custom?.reasoning, 'low'); assert.equal(saved.settings.providers.custom?.temperature, 0.2);
    assert.deepEqual(saved.settings.verificationCommands, ['npm test', 'npm run check']);
    assert.equal(saved.settings.sandboxMode, 'required'); assert.deepEqual(saved.settings.sandboxNetworkDomains, ['registry.npmjs.org', 'github.com']);
  } finally { await controller?.close(); await local.dispose(); }
});

test('invalid values for every configurable setting are rejected without mutating or saving config', { timeout: 10000 }, async () => {
  const local = await fixture();
  let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    const invalidValues: Record<string, string | number> = {
      mode: 'INVALID', cortex: 6, permissions: 'invalid', theme: 'blue', webSearchMode: 'google', browserEngine: 'safari',
      verificationCommands: '[""]', verificationMode: 'always', verificationRepairAttempts: 4, sandboxMode: 'unsafe',
      sandboxNetworkDomains: '["bad domain"]', fallback: '["missing-provider"]', agentToolProfiles: '{"root":["read_file"]}',
      modelRoutes: '{"reviewer":{"provider":"missing-provider"}}', modelRoleBudgets: '{"coder":{"maxCalls":-1}}',
      cortexStrategy: 'random', repeatFailureThreshold: -1, tokenBudget: 999, dollarBudget: -1, maxInputTokens: -1,
      maxOutputTokens: -1, maxSteps: -1, maxAgents: -1, maxProcesses: -1, maxDepth: -2, timeoutMs: -1, toolOutputLimit: -1,
    };
    assert.deepEqual(Object.keys(invalidValues).sort(), SETTINGS_FIELDS.map(field => field.key).sort());
    const memoryBefore = JSON.stringify(controller.config.settings);
    const diskBefore = await readFile(path.join(local.home, 'config.json'));
    for (const [name, value] of Object.entries(invalidValues)) {
      await assert.rejects(controller.updateSetting(name, value), `invalid setting ${name} should be rejected`);
      assert.equal(JSON.stringify(controller.config.settings), memoryBefore, `invalid setting ${name} must not mutate memory`);
    }
    assert.deepEqual(await readFile(path.join(local.home, 'config.json')), diskBefore);
  } finally { await controller?.close(); await local.dispose(); }
});

test('/verify runs configured checks, records diagnostics and file hashes, and keeps history after restart', { timeout: 20_000 }, async () => {
  const local = await fixture();
  let controller: Controller | undefined;
  try {
    local.config.settings.permissions = 'all';
    local.config.settings.verificationCommands = ['node verify.mjs'];
    await local.config.save();
    await mkdir(path.join(local.root, 'src'));
    await writeFile(path.join(local.root, 'src', 'app.ts'), 'export const answer: number = 1;');
    await writeFile(path.join(local.root, 'verify.mjs'), "process.stdout.write('checks passed');\n");
    controller = await Controller.open(local.root, local.home);
    const session = controller.snapshot().sessionId;
    await (controller as any).workspace.change('write_file', 'src/app.ts', () => 'export const answer: number = 42;', 'BUILD');

    await controller.submit('/verify');
    const store = (controller as any).store as SessionStore;
    const report = store.verificationReports(session, 1)[0]!;
    assert.equal(report.status, 'passed');
    assert.deepEqual(report.commands.map(check => [check.command, check.exitCode, check.status]), [['node verify.mjs', 0, 'passed']]);
    assert.ok(report.diagnostics.some(item => item.path === 'src/app.ts'));
    assert.equal(report.files.length, 1);
    assert.equal(report.files[0]!.path, 'src/app.ts');
    assert.ok(report.files[0]!.beforeHash);
    assert.equal(report.files[0]!.beforeHash, report.files[0]!.afterHash);
    assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /VERIFICATION PASSED/);

    await controller.submit('/verify history 1');
    assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /VERIFICATION HISTORY[\s\S]*PASSED/);
    await controller.submit(`/verify report ${report.id.slice(0, 8)}`);
    assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /VERIFICATION PASSED[\s\S]*node verify\.mjs/);
    await controller.close(); controller = undefined;
    const reopened = new SessionStore(local.home);
    try { assert.equal(reopened.verificationReports(session, 1)[0]?.id, report.id); }
    finally { reopened.close(); }
  } finally { await controller?.close(); await local.dispose(); }
});

test('/verify repair makes a bounded repair call only after a failed check, then reruns independent verification', { timeout: 20_000 }, async () => {
  const local = await fixture();
  let controller: Controller | undefined;
  try {
    local.config.settings.permissions = 'all';
    local.config.settings.verificationCommands = ['node verify.mjs'];
    await local.config.save();
    await mkdir(path.join(local.root, 'src'));
    await writeFile(path.join(local.root, 'src', 'app.ts'), 'export const answer: number = "bad";');
    await writeFile(path.join(local.root, 'verify.mjs'), "import { readFileSync } from 'node:fs'; process.exit(readFileSync('src/app.ts', 'utf8').includes('bad') ? 1 : 0);\n");
    controller = await Controller.open(local.root, local.home);
    const session = controller.snapshot().sessionId;
    const runtime = (controller as any).runtime;
    const workspace = (controller as any).workspace;
    let repairCalls = 0;
    const repairBudgets: unknown[] = [];
    runtime.run = async (...args: any[]) => {
      repairCalls++;
      repairBudgets.push(args[4]);
      await workspace.change('write_file', 'src/app.ts', () => 'export const answer: number = 42;', 'BUILD');
    };

    await controller.submit('/verify repair 2');
    const reports = ((controller as any).store as SessionStore).verificationReports(session, 10);
    assert.equal(repairCalls, 1, JSON.stringify(reports.map(report => ({ status: report.status, commands: report.commands, diagnostics: report.diagnostics }))));
    assert.ok(repairBudgets[0] && typeof repairBudgets[0] === 'object');
    assert.deepEqual(reports.map(report => report.status), ['passed', 'failed']);
    assert.match(controller.snapshot().messages.map(message => message.text).join('\n'), /VERIFICATION FAILED[\s\S]*VERIFICATION PASSED/);
  } finally { await controller?.close(); await local.dispose(); }
});

test('automatic verification runs only after BUILD changes and shares the task budget with bounded repair', { timeout: 20_000 }, async () => {
  const local = await fixture();
  let controller: Controller | undefined;
  try {
    local.config.settings.permissions = 'all';
    local.config.settings.verificationCommands = ['node verify.mjs'];
    local.config.settings.verificationMode = 'after_changes';
    local.config.settings.verificationRepairAttempts = 1;
    await local.config.save();
    await mkdir(path.join(local.root, 'src'));
    await writeFile(path.join(local.root, 'src', 'app.ts'), 'export const answer: number = 1;');
    await writeFile(path.join(local.root, 'verify.mjs'), "import { readFileSync } from 'node:fs'; process.exit(readFileSync('src/app.ts', 'utf8').includes('bad') ? 1 : 0);\n");
    controller = await Controller.open(local.root, local.home);
    const runtime = (controller as any).runtime;
    const workspace = (controller as any).workspace;
    const budgets: unknown[] = [];
    runtime.run = async (...args: any[]) => {
      budgets.push(args[4]);
      if (budgets.length === 1) await workspace.change('write_file', 'src/app.ts', () => 'export const answer: number = "bad";', 'BUILD');
      else if (budgets.length === 2) await workspace.change('write_file', 'src/app.ts', () => 'export const answer: number = 42;', 'BUILD');
      else if (budgets.length === 4) {
        await workspace.change('write_file', 'src/app.ts', () => 'export const answer: number = "bad again";', 'BUILD');
        throw new Error('simulated provider failure after partial edit');
      }
    };

    await controller.submit('Change the answer in src/app.ts.');
    const reports = ((controller as any).store as SessionStore).verificationReports(controller.snapshot().sessionId, 10);
    assert.equal(budgets.length, 2, 'one build call and one configured repair call');
    assert.ok(budgets[0] && budgets[0] === budgets[1], 'verification repair must share the task RunBudget');
    assert.deepEqual(reports.map(report => report.status), ['passed', 'failed']);
    assert.match(controller.snapshot().messages.map(message => message.text).join('\n'), /Running automatic verification[\s\S]*VERIFICATION FAILED[\s\S]*VERIFICATION PASSED/);

    await controller.submit('Check whether another change is needed.');
    assert.equal(((controller as any).store as SessionStore).verificationReports(controller.snapshot().sessionId, 10).length, 2, 'an unchanged BUILD must not trigger another check');

    await controller.updateSetting('verificationRepairAttempts', 0);
    await controller.submit('Make one more change, then the model request fails.');
    const afterFailure = ((controller as any).store as SessionStore).verificationReports(controller.snapshot().sessionId, 10);
    assert.equal(afterFailure.length, 3);
    assert.equal(afterFailure[0]!.status, 'failed', 'partial edits must still receive a verification report');
    assert.match(controller.snapshot().messages.map(message => message.text).join('\n'), /simulated provider failure after partial edit/);
  } finally { await controller?.close(); await local.dispose(); }
});

test('/verify reports an approval block without starting the configured command', { timeout: 10_000 }, async () => {
  const local = await fixture();
  let controller: Controller | undefined;
  const marker = path.join(local.root, 'command-ran.txt');
  try {
    local.config.settings.verificationCommands = [`node -e \"require('fs').writeFileSync('${marker.replaceAll('\\', '/')}', 'ran')\"`];
    await local.config.save();
    controller = await Controller.open(local.root, local.home);
    let repairCalls = 0;
    (controller as any).runtime.run = async () => { repairCalls++; };
    await controller.submit('/verify repair');
    const report = ((controller as any).store as SessionStore).verificationReports(controller.snapshot().sessionId, 1)[0]!;
    assert.equal(report.status, 'blocked');
    assert.equal(report.commands[0]?.status, 'blocked');
    assert.equal(repairCalls, 0);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await controller.submit('/verify repair 4');
    assert.match(controller.snapshot().messages.at(-1)?.text ?? '', /whole number from 1 to 3/);
    assert.equal(repairCalls, 0);
  } finally { await controller?.close(); await local.dispose(); }
});

test('/effort command lists model controls, persists a valid choice and restores automatic mode', async t => {
  const local = await fixture();
  let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    const provider = controller.config.settings.providers.custom!;
    provider.kind = 'google';
    provider.baseURL = 'https://generativelanguage.googleapis.com/v1beta';
    await controller.setModel('gemini-3.5-flash-lite');

    await controller.submit('/effort');
    assert.ok(controller.listEfforts().some(option => option.id === 'minimal'));
    assert.ok(controller.snapshot().messages.some(message => message.text.includes('Reasoning effort') && message.text.includes('Minimal')));
    await controller.submit('/effort high');
    assert.equal(provider.reasoning, 'high');
    assert.equal(controller.listEfforts().find(option => option.id === 'high')?.detail, 'Current');

    await controller.submit('/effort off');
    assert.ok(controller.snapshot().messages.at(-1)?.text.includes('not available'));
    assert.equal(provider.reasoning, 'high');

    await controller.submit('/effort auto');
    assert.equal(provider.reasoning, undefined);
    const saved = new ConfigManager(local.home);
    await saved.load();
    assert.equal(saved.settings.providers.custom?.reasoning, undefined);
  } finally { await controller?.close(); await local.dispose(); }
});

test('settings mutations roll back in memory when config persistence fails', { timeout: 10000 }, async () => {
  const local = await fixture(); let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    const settings = controller.config.settings;
    const originalSave = controller.config.save.bind(controller.config);
    const initial = {
      provider: settings.provider, model: settings.providers[settings.provider]!.model,
      mode: settings.mode, cortex: settings.cortex, theme: settings.theme,
      tokenBudget: settings.tokenBudget, dollarBudget: settings.dollarBudget,
      permissions: settings.permissions, toolPermissions: { ...settings.toolPermissions },
      allowTools: [...settings.allowTools], denyTools: [...settings.denyTools],
      reasoning: settings.providers[settings.provider]!.reasoning,
    };
    controller.config.save = async () => { throw new Error('simulated disk error'); };

    await controller.submit('/mode REVIEW');
    await controller.submit('/cortex 3');
    await controller.submit('/settings theme light');
    await controller.submit('/settings provider.reasoning low');
    await controller.submit('/permissions all');
    await controller.submit('/budget 1200 2');
    await controller.submit('/model unsaved-model');
    await controller.submit('/mcp add unsaved {"type":"http","url":"http://127.0.0.1:4444/mcp"}');
    await controller.submit('/connect openai');

    assert.equal(settings.provider, initial.provider);
    assert.equal(settings.providers[initial.provider]!.model, initial.model);
    assert.equal(settings.mode, initial.mode); assert.equal(settings.cortex, initial.cortex); assert.equal(settings.theme, initial.theme);
    assert.equal(settings.tokenBudget, initial.tokenBudget); assert.equal(settings.dollarBudget, initial.dollarBudget);
    assert.equal(settings.permissions, initial.permissions); assert.deepEqual(settings.toolPermissions, initial.toolPermissions);
    assert.deepEqual(settings.allowTools, initial.allowTools); assert.deepEqual(settings.denyTools, initial.denyTools);
    assert.equal(settings.providers[initial.provider]!.reasoning, initial.reasoning);
    assert.equal(settings.mcp.unsaved, undefined);
    assert.ok(controller.snapshot().messages.some(message => message.text.includes('simulated disk error')));

    controller.config.save = originalSave;
  } finally { await controller?.close(); await local.dispose(); }
});

test('provider setup rolls back persisted settings when secure key storage fails', { timeout: 10000 }, async () => {
  const local = await fixture(); let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    const settings = controller.config.settings, previousProvider = settings.provider, previous = { ...settings.providers.custom! };
    const vault = (controller as any).vault; const originalSet = vault.set.bind(vault);
    vault.set = async () => { throw new Error('simulated DPAPI failure'); };
    await assert.rejects(controller.configureProvider({ ...previous, model: 'unsaved-model' }, 'one-time-test-key'), /simulated DPAPI failure/);
    assert.equal(settings.provider, previousProvider); assert.deepEqual(settings.providers.custom, previous);
    const disk = new ConfigManager(local.home); await disk.load();
    assert.equal(disk.settings.provider, previousProvider); assert.deepEqual(disk.settings.providers.custom, previous);
    vault.set = originalSet;
  } finally { await controller?.close(); await local.dispose(); }
});

test('controller /key never adds plaintext to UI, config or SQLite', { timeout: 15000 }, async () => {
  const local = await fixture(); let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    const secret = 'controller-test-secret-93851';
    await controller.submit(`/key ${secret}`);
    assert.ok(!JSON.stringify(controller.snapshot()).includes(secret));
    assert.ok(!(await readFile(path.join(local.home, 'config.json'), 'utf8')).includes(secret));
    assert.ok(!(await readFile(path.join(local.home, 'sessions.sqlite'))).includes(Buffer.from(secret)));
    if (process.platform === 'win32') assert.ok(!controller.snapshot().messages.some(message => message.role === 'error'));
  } finally { await controller?.close(); await local.dispose(); }
});

test('controller cancels streaming and concurrent close callers await one shutdown', { timeout: 10000 }, async () => {
  let requested = false;
  const local = await fixture(async (request, response) => { await body(request); requested = true; response.writeHead(200, { 'Content-Type': 'text/event-stream' }); chunk(response, { role: 'assistant', content: 'Partial answer' }); });
  let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    const running = controller.submit('Wait until the request is cancelled.');
    await until(() => requested && controller!.snapshot().busy);
    await controller.submit('/model forbidden-while-busy');
    assert.equal(controller.snapshot().model, 'test-model');
    controller.cancel(); await running;
    assert.equal(controller.snapshot().status, 'Cancelled'); assert.equal(controller.snapshot().busy, false);
    const first = controller.close(); const second = controller.close(); assert.equal(first, second); await Promise.all([first, second]);
    assert.equal(controller.snapshot().status, 'closed');
  } finally { await controller?.close(); await local.dispose(); }
});

test('/compact archives only active context and preserves complete session history', { timeout: 10000 }, async () => {
  const local = await fixture(); let controller: Controller | undefined; let store: SessionStore | undefined;
  try {
    controller = await Controller.open(local.root, local.home, { maxInputTokens: 2048 });
    store = new SessionStore(local.home); const session = store.create(controller.snapshot().workspace);
    const messages: Message[] = [];
    for (let index = 0; index < 8; index++) messages.push({ role: 'user', content: `Old request ${index}: ${'details '.repeat(200)}` }, { role: 'assistant', content: `Old result ${index}: ${'evidence '.repeat(200)}` });
    messages.push({ role: 'user', content: 'Latest short instruction' }); messages.forEach(message => store!.append(session, message));
    controller.resumeSession(session); await controller.submit('/compact');
    assert.deepEqual(store.messages(session), messages);
    assert.ok(store.context(session).length < messages.length);
    controller.resumeSession(session);
    assert.ok(controller.snapshot().messages.some(message => message.text.startsWith('Old request 0:')));
  } finally { await controller?.close(); store?.close(); await local.dispose(); }
});

test('MCP list and connection approval never reveal legacy inline credentials', async () => {
  const local = await fixture(); let controller: Controller | undefined; const secret = 'mcp-auth-inline-secret-927451'; let approvalPreview = '';
  try {
    controller = await Controller.open(local.root, local.home);
    await controller.submit(`/mcp add rejected {"type":"stdio","command":"node","env":{"AUTH":"${secret}"}}`);
    assert.equal(controller.config.settings.mcp.rejected, undefined);
    assert.equal((await readFile(path.join(local.home, 'config.json'), 'utf8')).includes(secret), false);
    controller.config.settings.mcp.legacy = { type: 'stdio', command: 'node', args: ['--auth', secret], env: { AUTH: secret }, url: `https://user:${secret}@mcp.example.test/path?token=${secret}` };
    controller.setApprover(async request => { approvalPreview = request.preview ?? ''; return false; });
    await controller.submit('/mcp list');
    assert.equal(JSON.stringify(controller.snapshot().messages).includes(secret), false);
    await controller.submit('/mcp connect legacy');
    assert.equal(approvalPreview.includes(secret), false);
    assert.match(approvalPreview, /REDACTED/);
  } finally { await controller?.close(); await local.dispose(); }
});

test('/mcp add rejects incomplete and mismatched transports before saving them', async t => {
  const local = await fixture(); let controller: Controller | undefined;
  try {
    controller = await Controller.open(local.root, local.home);
    const invalid = [
      ['missing-stdio-command', { type: 'stdio' }],
      ['blank-stdio-command', { type: 'stdio', command: '   ' }],
      ['stdio-with-url', { type: 'stdio', command: 'node', url: 'https://mcp.example.test' }],
      ['missing-http-url', { type: 'http' }],
      ['http-with-command', { type: 'http', url: 'https://mcp.example.test', command: 'node' }],
      ['http-with-env', { type: 'http', url: 'https://mcp.example.test', env: { TOKEN: '${MCP_TOKEN}' } }],
    ] as const;
    for (const [name, config] of invalid) {
      await controller.submit(`/mcp add ${name} ${JSON.stringify(config)}`);
      assert.equal(controller.config.settings.mcp[name], undefined, `${name} must not be saved`);
    }
    const persisted = JSON.parse(await readFile(path.join(local.home, 'config.json'), 'utf8'));
    assert.deepEqual(persisted.mcp, {});
  } finally { await controller?.close(); await local.dispose(); }
});

test('CLI --model reaches endpoint and invalid --session fails without starting work', { timeout: 15000 }, async () => {
  const requests: Record<string, any>[] = [];
  const local = await fixture(async (request, response) => { requests.push(await body(request)); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); chunk(response, { role: 'assistant', content: 'CLI finished' }); chunk(response, {}, 'stop'); finish(response); });
  try {
    const args = ['--import', 'tsx', 'src/cli.ts', 'run', 'Answer briefly', '--workspace', local.root, '--provider', 'custom', '--model', 'overridden-model', '--json'];
    const result = await execa(process.execPath, args, { env: { POLONRLM_HOME: local.home }, timeout: 10000, reject: false, windowsHide: true });
    assert.equal(result.exitCode, 0, result.stderr); assert.equal(requests[0]?.model, 'overridden-model');
    const events = result.stdout.trim().split('\n').map(line => JSON.parse(line)); assert.ok(events.some(event => event.type === 'text' && event.text === 'CLI finished'));
    const failed = await execa(process.execPath, [...args, '--session', 'does-not-exist'], { env: { POLONRLM_HOME: local.home }, timeout: 10000, reject: false, windowsHide: true });
    assert.equal(failed.exitCode, 1); assert.match(failed.stderr, /No session was found/); assert.equal(requests.length, 1);
  } finally { await local.dispose(); }
});

test('CLI doctor finds bundled ripgrep when PATH has no rg', { timeout: 15000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-doctor-'));
  const workspace = path.join(folder, 'workspace'); const home = path.join(folder, 'home'); await mkdir(workspace);
  try {
    const result = await execa(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'doctor', '--workspace', workspace], {
      cwd: process.cwd(), env: { ...process.env, POLONRLM_HOME: home, PATH: '' }, timeout: 10000, reject: false, windowsHide: true,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /rg: ripgrep \d/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
