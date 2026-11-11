import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PluginManager } from '../src/plugins/manager.js';

async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), 'polonrlm-plugin-'));
  const plugins = new PluginManager(home);
  t.after(async () => { await plugins.close(); await rm(home, { recursive: true, force: true }); });
  return { home, plugins };
}

test('plugin preview never executes code; explicit reviewed hash enables bounded lifecycle hooks', async t => {
  const { plugins } = await fixture(t);
  const id = 'review-hooks';
  const marker = `__polonrlm_plugin_${randomUUID().replaceAll('-', '')}`;
  const directory = await plugins.create(id);
  const source = `
globalThis[${JSON.stringify(marker)}] = { loaded: true, events: [] };
export default {
  id: ${JSON.stringify(id)},
  version: '1.0.0',
  activate(api) {
    api.hooks.beforeTask(event => {
      if (!Object.isFrozen(event)) throw new Error('task context must be frozen');
      return 'Only for ' + event.role;
    });
    api.hooks.beforeTool(event => {
      if (!Object.isFrozen(event.arguments)) throw new Error('tool arguments must be frozen');
      if (event.tool === 'write_file') return 'manual review required';
    });
    api.hooks.afterTool(event => globalThis[${JSON.stringify(marker)}].events.push('tool:' + event.tool + ':' + event.isError));
    api.hooks.afterTask(event => globalThis[${JSON.stringify(marker)}].events.push('task:' + event.status));
  },
  deactivate() { globalThis[${JSON.stringify(marker)}].events.push('deactivated'); },
};
`;
  const entry = path.join(directory, 'index.mjs');
  await writeFile(entry, source, 'utf8');
  const preview = await plugins.preview(id);
  assert.equal((globalThis as Record<string, unknown>)[marker], undefined, 'preview must not import the module');

  const reviewed = await plugins.review(id);
  assert.equal(reviewed.sha256, preview.sha256);
  assert.equal(plugins.consumeReview(id, '0'.repeat(64)), false, 'a different version must not consume approval');
  const currentReview = await plugins.review(id);
  assert.equal(plugins.consumeReview(id, currentReview.sha256), true, 'only the currently reviewed hash can be confirmed');
  await assert.rejects(plugins.activate(id, '0'.repeat(64)), /changed since approval/);
  await plugins.activate(id, preview.sha256);

  const state = (globalThis as Record<string, any>)[marker];
  assert.equal(state.loaded, true);
  assert.deepEqual(await plugins.beforeTask({ sessionId: 's', workspace: 'w', task: 'Fix a bug', role: 'reviewer', mode: 'REVIEW' }), [{ id, context: 'Only for reviewer' }]);
  await assert.rejects(plugins.beforeTool({ sessionId: 's', workspace: 'w', task: 'Write a file', role: 'orchestrator', mode: 'BUILD', tool: 'write_file', arguments: { path: 'a.txt' } }), /blocked write_file: manual review required/);
  await plugins.afterTool({ sessionId: 's', workspace: 'w', task: 'Write a file', role: 'orchestrator', mode: 'BUILD', tool: 'write_file', arguments: { path: 'a.txt' }, result: 'denied', isError: true, durationMs: 3 });
  await plugins.afterTask({ sessionId: 's', workspace: 'w', task: 'Write a file', role: 'orchestrator', mode: 'BUILD', status: 'complete' });
  assert.deepEqual(state.events, ['tool:write_file:true', 'task:complete']);

  await plugins.deactivate(id);
  assert.deepEqual(state.events, ['tool:write_file:true', 'task:complete', 'deactivated']);
  assert.equal((await plugins.list({ [id]: { enabled: true, sha256: preview.sha256 } }))[0]?.loaded, false);
});

test('editing a plugin invalidates its pinned hash and pending review', async t => {
  const { plugins } = await fixture(t);
  const id = 'hash-check';
  const directory = await plugins.create(id);
  const original = await plugins.review(id);
  assert.equal(plugins.consumeReview(id, original.sha256), true);

  const entry = path.join(directory, 'index.mjs');
  const current = await readFile(entry, 'utf8');
  await writeFile(entry, current + '\n// changed after review\n', 'utf8');
  const changed = await plugins.preview(id);
  assert.notEqual(changed.sha256, original.sha256);
  await assert.rejects(plugins.activate(id, original.sha256), /changed since approval/);
  assert.equal(plugins.consumeReview(id, changed.sha256), false, 'a new hash is not implicitly approved');
  assert.equal((await plugins.list({ [id]: { enabled: true, sha256: original.sha256 } }))[0]?.problem, 'Files changed; confirm again to load.');
});

test('plugins can register a bounded model-callable tool with a JSON Schema', async t => {
  const { plugins } = await fixture(t);
  const id = 'tool-plugin';
  const directory = await plugins.create(id);
  await writeFile(path.join(directory, 'index.mjs'), `
export default {
  id: ${JSON.stringify(id)},
  version: '1.0.0',
  activate(api) {
    api.tools.register({
      name: 'plugin_echo',
      description: 'Echo a value through a trusted plugin.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      readOnly: true,
      run(args, context) {
        if (!Object.isFrozen(args) || !Object.isFrozen(context)) throw new Error('plugin tool context must be frozen');
        return 'echo:' + args.text + ':' + context.tool;
      },
    });
  },
};
`, 'utf8');
  const preview = await plugins.preview(id);
  await plugins.review(id);
  assert.equal(plugins.consumeReview(id, preview.sha256), true);
  await plugins.activate(id, preview.sha256);
  const definitions = plugins.toolDefinitions();
  assert.equal(definitions[0]?.definition.name, 'plugin_echo');
  assert.equal(definitions[0]?.definition.readOnly, true);
  assert.equal(await plugins.callTool(id, 'plugin_echo', { text: 'hello' }, { sessionId: 's', workspace: 'w', task: 't', role: 'main', mode: 'BUILD', tool: 'plugin_echo', arguments: { text: 'hello' } }), 'echo:hello:plugin_echo');
  await plugins.deactivate(id);
  assert.deepEqual(plugins.toolDefinitions(), []);
  await assert.rejects(plugins.callTool(id, 'plugin_echo', { text: 'hello' }, { sessionId: 's', workspace: 'w', task: 't', role: 'main', mode: 'BUILD', tool: 'plugin_echo', arguments: { text: 'hello' } }), /not loaded/);
});

test('plugins reject undeclared files and invalid configuration identifiers', async t => {
  const { plugins } = await fixture(t);
  const directory = await plugins.create('one-file');
  await writeFile(path.join(directory, 'helper.mjs'), 'export const secret = true;');
  await assert.rejects(plugins.preview('one-file'), /Extra files are not loaded/);
  await assert.rejects(plugins.create('../outside'), /Plugin ID must start/);
});
