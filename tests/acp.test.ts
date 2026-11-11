import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpServer, type AcpClient } from '../src/acp/server.js';

function fakeClient(): { client: AcpClient; state: { images: string[]; resumed: string[]; cancelled: boolean; closed: boolean } } {
  const state = { images: [] as string[], resumed: [] as string[], cancelled: false, closed: false };
  const client: AcpClient = {
    sessionId: 'sess-1',
    describe: () => ({ sessionId: 'sess-1', workspace: process.cwd(), provider: 'fake', model: 'fake-model', mode: 'BUILD', status: 'Ready' }),
    tools: () => [{ name: 'read_file', description: 'read', available: true, policy: 'default' }],
    history: () => [{ role: 'user', text: 'old question' }, { role: 'assistant', text: 'old answer' }],
    addImageData: (data: string) => { state.images.push(data); },
    resumeSession: (id: string) => { state.resumed.push(id); },
    run: async (prompt, onEvent) => {
      onEvent?.({ type: 'text', text: 'hello' });
      return { text: `answer:${prompt}`, sessionId: 'sess-1', usage: { input: 1, output: 1, cached: 0, cost: 0, costKnown: true } };
    },
    cancel: () => { state.cancelled = true; },
    close: async () => { state.closed = true; },
  };
  return { client, state };
}

test('ACP adapter supports images, load replay, resume, permissions and close', async () => {
  const notifications: Array<Record<string, any>> = [];
  const { client, state } = fakeClient();
  const server = new AcpServer({
    createClient: async () => client,
    onNotification: message => notifications.push(message as Record<string, any>),
    requestClient: async () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } }),
  });
  const initialize = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) as any;
  assert.equal(initialize.result.protocolVersion, 1);
  assert.equal(initialize.result.agentCapabilities.loadSession, true);
  assert.equal(initialize.result.agentCapabilities.promptCapabilities.image, true);
  assert.ok(initialize.result.agentCapabilities.sessionCapabilities.resume);

  assert.equal(await server.requestPermission('sess-1', { tool: 'execute_command', description: 'Run tests' }), true);

  const created = await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } }) as any;
  assert.equal(created.result.sessionId, 'sess-1');

  const prompt = await server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: {
    sessionId: 'sess-1',
    prompt: [{ type: 'text', text: 'do work' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
  } }) as any;
  assert.equal(prompt.result.stopReason, 'end_turn');
  assert.deepEqual(state.images, ['aGVsbG8=']);
  assert.ok(notifications.some(message => message.params?.update?.sessionUpdate === 'agent_message_chunk' && message.params.update.content.text === 'hello'));

  const loaded = await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/load', params: { cwd: process.cwd(), sessionId: 'old-session', mcpServers: [] } }) as any;
  assert.deepEqual(loaded.result, { modes: null, configOptions: null });
  assert.deepEqual(state.resumed, ['old-session']);
  assert.ok(notifications.some(message => message.params?.sessionId === 'old-session' && message.params?.update?.sessionUpdate === 'user_message_chunk' && message.params.update.content.text === 'old question'));
  assert.ok(notifications.some(message => message.params?.sessionId === 'old-session' && message.params?.update?.sessionUpdate === 'agent_message_chunk' && message.params.update.content.text === 'old answer'));

  const resumed = await server.handle({ jsonrpc: '2.0', id: 5, method: 'session/resume', params: { cwd: process.cwd(), sessionId: 'old-session' } }) as any;
  assert.deepEqual(resumed.result, { modes: null, configOptions: null });

  await server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess-1' } });
  assert.equal(state.cancelled, true);
  const closedResult = await server.handle({ jsonrpc: '2.0', id: 6, method: 'session/close', params: { sessionId: 'sess-1' } }) as any;
  assert.deepEqual(closedResult.result, {});
  assert.equal(state.closed, true);
  const unsupported = await server.handle({ jsonrpc: '2.0', id: 7, method: 'session/set_mode', params: {} }) as any;
  assert.equal(unsupported.error.code, -32601);
});
