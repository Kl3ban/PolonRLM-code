import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { Controller } from '../src/core/controller.js';
import { ConfigManager } from '../src/core/config.js';
import { SessionStore } from '../src/core/store.js';
import type { Message, RuntimeEvent } from '../src/core/types.js';

async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-controller-'));
  const root = path.join(folder, 'project'); const home = path.join(folder, 'home'); await mkdir(root);
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = new ConfigManager(home); await config.load();
  config.settings.provider = 'custom';
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
  let runs = 0;
  (controller as any).runtime.run = async (session: string) => {
    runs++; const store = (controller as any).store as SessionStore;
    store.recordUsage(session, { input: 100, output: 20, cached: 0, cost: 0, costKnown: true });
    if (runs === 2) { const w = store.workflow(session); w.goal!.status = 'complete'; w.goal!.evidence = 'Outputs checked'; store.saveWorkflow(session, w); }
    return 'Progress';
  };
  await controller.submit('/goal --tokens 4000 Implement feature');
  assert.equal(runs, 2);
  const store = (controller as any).store as SessionStore;
  const goal = store.workflow(controller.snapshot().sessionId).goal!;
  assert.equal(goal.status, 'complete'); assert.equal(goal.usedTokens, 240);
  await controller.submit('/goal clear');
  assert.equal(store.workflow(controller.snapshot().sessionId).goal, undefined);
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
    assert.deepEqual({ reasoning: provider?.reasoning, requestTimeoutMs: provider?.requestTimeoutMs, temperature: provider?.temperature, inputPrice: provider?.inputPrice, outputPrice: provider?.outputPrice, toolCalling: provider?.toolCalling, vision: provider?.vision, contextWindow: provider?.contextWindow, maxOutputTokens: provider?.maxOutputTokens, reasoningSupported: provider?.reasoningSupported, apiKeyEnv: provider?.apiKeyEnv }, { reasoning: 'low', requestTimeoutMs: 123456, temperature: 0.2, inputPrice: 1.5, outputPrice: 3, toolCalling: false, vision: true, contextWindow: 65000, maxOutputTokens: 2048, reasoningSupported: true, apiKeyEnv: 'TEST_ONLY_API_KEY' });
    await controller.submit('/settings provider.temperature 8'); assert.equal(provider?.temperature, 0.2);
    await controller.submit('/settings provider.kind invalid'); assert.equal(provider?.kind, 'compatible');
    await controller.submit('/settings provider.inputPrice -1'); assert.equal(provider?.inputPrice, 1.5);
    await controller.submit('/settings provider.id forbidden'); assert.equal(provider?.id, 'custom');
    await controller.submit('/connect toString'); assert.equal(controller.snapshot().provider, 'custom');
    await controller.submit('/mcp add example {"type":"http","url":"http://127.0.0.1:4444/mcp"}');
    assert.ok(controller.config.settings.mcp.example);
    await controller.submit('/mcp remove example'); assert.equal(controller.config.settings.mcp.example, undefined);
    await saved.load(); assert.equal(saved.settings.mode, 'REVIEW'); assert.equal(saved.settings.permissions, 'readonly'); assert.equal(saved.settings.theme, 'light'); assert.equal(saved.settings.browserEngine, 'edge'); assert.equal(saved.settings.providers.custom?.reasoning, 'low'); assert.equal(saved.settings.providers.custom?.temperature, 0.2);
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
