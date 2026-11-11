import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpServer, type AcpClient } from '../src/acp/server.js';

test('ACP adapter initializes, creates a session, streams text and closes it', async () => {
  const notifications: Array<Record<string, any>> = [];
  let cancelled = false;
  let closed = false;
  const client: AcpClient = {
    sessionId: 'sess-1',
    describe: () => ({ sessionId: 'sess-1', workspace: process.cwd(), provider: 'fake', model: 'fake-model', mode: 'BUILD', status: 'Ready' }),
    tools: () => [{ name: 'read_file', description: 'read', available: true, policy: 'default' }],
    run: async (prompt, onEvent) => {
      onEvent?.({ type: 'text', text: 'hello' });
      return { text: `answer:${prompt}`, sessionId: 'sess-1', usage: { input: 1, output: 1, cached: 0, cost: 0, costKnown: true } };
    },
    cancel: () => { cancelled = true; },
    close: async () => { closed = true; },
  };
  const server = new AcpServer({ createClient: async () => client, onNotification: message => notifications.push(message as Record<string, any>) });
  const initialize = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) as any;
  assert.equal(initialize.result.protocolVersion, 1);
  assert.equal(initialize.result.agentInfo.name, 'PolonRLM');

  const created = await server.handle({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } }) as any;
  assert.equal(created.result.sessionId, 'sess-1');

  const prompt = await server.handle({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'do work' }] } }) as any;
  assert.equal(prompt.result.stopReason, 'end_turn');
  assert.ok(notifications.some(message => message.params?.update?.sessionUpdate === 'agent_message_chunk' && message.params.update.content.text === 'hello'));

  await server.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'sess-1' } });
  assert.equal(cancelled, true);
  const closedResult = await server.handle({ jsonrpc: '2.0', id: 4, method: 'session/close', params: { sessionId: 'sess-1' } }) as any;
  assert.deepEqual(closedResult.result, {});
  assert.equal(closed, true);
  const unsupported = await server.handle({ jsonrpc: '2.0', id: 5, method: 'session/load', params: {} }) as any;
  assert.equal(unsupported.error.code, -32601);
});
