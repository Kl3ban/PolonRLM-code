import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Controller } from '../src/core/controller.js';
import type { RuntimeEvent } from '../src/core/types.js';
import { AgentClient } from '../src/sdk/index.js';

function fakeController(): { controller: Controller; events: RuntimeEvent[]; submitted: string[] } {
  const events: RuntimeEvent[] = [];
  const submitted: string[] = [];
  const controller = {
    onEvent: undefined as ((event: RuntimeEvent) => void) | undefined,
    snapshot: () => ({
      sessionId: 'session-1', workspace: '/work', provider: 'fake', model: 'fake-model', mode: 'BUILD', status: 'Ready',
      messages: [{ role: 'assistant', text: 'finished' }],
      taskUsage: { input: 3, output: 2, cached: 0, cost: 0, costKnown: true },
    }),
    readSettings: () => ({ tools: [{ name: 'read_file', description: 'read', available: true, policy: 'default' }], values: {} }),
    submit: async (prompt: string) => {
      submitted.push(prompt);
      controller.onEvent?.({ type: 'text', text: 'working' });
    },
    cancel: () => {},
    close: async () => {},
  } as unknown as Controller;
  return { controller, events, submitted };
}

test('SDK creates a real controller from an explicit provider without a model call', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'PolonRLM-sdk-'));
  const workspace = path.join(folder, 'workspace');
  await mkdir(workspace);
  let client: AgentClient | undefined;
  t.after(async () => {
    await client?.close();
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  client = await AgentClient.create({
    workspace,
    home: path.join(folder, 'home'),
    provider: { id: 'fake', config: { kind: 'compatible', baseURL: 'http://127.0.0.1:1', model: 'fake-model' } },
    settings: { permissions: 'workspace' },
  });
  assert.equal(client.describe().provider, 'fake');
  assert.equal(client.describe().model, 'fake-model');
  assert.equal(client.describe().workspace, await realpath(workspace));
  assert.ok(client.tools().length > 0);
});

test('SDK rejects a missing workspace before opening any store', async () => {
  await assert.rejects(AgentClient.create({ workspace: '' }), /requires a workspace/);
});

test('SDK wraps a controller, forwards events and returns the final answer', async () => {
  const { controller, events, submitted } = fakeController();
  const client = AgentClient.fromController(controller);
  assert.equal(client.sessionId, 'session-1');
  assert.equal(client.describe().model, 'fake-model');
  assert.equal(client.tools()[0]?.name, 'read_file');
  const result = await client.run('do the work', event => { events.push(event); });
  assert.deepEqual(submitted, ['do the work']);
  assert.equal(result.text, 'finished');
  assert.equal(result.sessionId, 'session-1');
  assert.equal(result.usage.output, 2);
  assert.deepEqual(events, [{ type: 'text', text: 'working' }]);
  assert.equal(controller.onEvent, undefined, 'the temporary sink must be restored');
});
