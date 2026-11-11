import assert from 'node:assert/strict';
import test from 'node:test';
import { startAgentServer, type AgentClientLike } from '../src/server/agent-server.js';

test('agent server authenticates, exposes tools, runs prompts and streams SSE', async t => {
  let cancelled = false;
  let closed = false;
  const client: AgentClientLike = {
    sessionId: 'server-session',
    describe: () => ({ sessionId: 'server-session', workspace: '/work', provider: 'fake', model: 'fake-model', mode: 'BUILD', status: 'Ready' }),
    tools: () => [{ name: 'read_file', description: 'read', available: true, policy: 'default' }],
    run: async (prompt, onEvent) => {
      onEvent?.({ type: 'text', text: 'streamed' });
      return { text: `echo:${prompt}`, sessionId: 'server-session', usage: { input: 1, output: 1, cached: 0, cost: 0, costKnown: true } };
    },
    cancel: () => { cancelled = true; },
    close: async () => { closed = true; },
  };
  const server = await startAgentServer({ workspace: '/work', host: '127.0.0.1', port: 0, token: 'secret', client });
  t.after(async () => { await server.close(); });
  const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };

  assert.equal((await fetch(`${server.url}/health`)).status, 401);
  const health = await (await fetch(`${server.url}/health`, { headers })).json() as any;
  assert.equal(health.status, 'ok');
  assert.equal(health.sessionId, 'server-session');

  const tools = await (await fetch(`${server.url}/v1/tools`, { headers })).json() as any;
  assert.equal(tools.tools[0].name, 'read_file');

  const response = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'hello' }) });
  assert.equal(response.status, 200);
  const result = await response.json() as any;
  assert.equal(result.text, 'echo:hello');
  assert.equal(result.sessionId, 'server-session');

  const stream = await fetch(`${server.url}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'stream', stream: true }) });
  const text = await stream.text();
  assert.match(text, /event: ready/);
  assert.match(text, /event: runtime/);
  assert.match(text, /"text":"streamed"/);
  assert.match(text, /event: done/);
  assert.match(text, /echo:stream/);

  const cancel = await fetch(`${server.url}/v1/cancel`, { method: 'POST', headers });
  assert.equal(cancel.status, 200);
  assert.equal(cancelled, true);

  await server.close();
  assert.equal(closed, true);
});
