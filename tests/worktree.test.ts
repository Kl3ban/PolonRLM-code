import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentWorktree } from '../src/core/agent-worktree.js';

test('subagent overlays reuse dependency trees without copying or reporting dependency changes', async t => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'polon-worktree-'));
  let overlay: AgentWorktree | undefined;
  t.after(async () => { if (overlay) await overlay.remove(); await rm(source, { recursive: true, force: true }); });
  await mkdir(path.join(source, 'src'), { recursive: true });
  await mkdir(path.join(source, 'node_modules', 'fixture'), { recursive: true });
  await mkdir(path.join(source, 'vendor', 'fixture'), { recursive: true });
  await writeFile(path.join(source, 'src', 'index.ts'), 'export const value = 1;');
  await writeFile(path.join(source, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1;');
  await writeFile(path.join(source, 'vendor', 'fixture', 'source.go'), 'package fixture');
  overlay = await AgentWorktree.create(source);
  assert.ok((await lstat(path.join(overlay.root, 'node_modules'))).isSymbolicLink());
  assert.ok((await lstat(path.join(overlay.root, 'vendor'))).isSymbolicLink());
  assert.equal(await readFile(path.join(overlay.root, 'node_modules', 'fixture', 'index.js'), 'utf8'), 'module.exports = 1;');
  assert.equal(await readFile(path.join(overlay.root, 'vendor', 'fixture', 'source.go'), 'utf8'), 'package fixture');
  await writeFile(path.join(source, 'node_modules', 'fixture', 'index.js'), 'module.exports = 2;');
  await writeFile(path.join(source, 'vendor', 'fixture', 'source.go'), 'package changed');
  await writeFile(path.join(overlay.root, 'src', 'index.ts'), 'export const value = 2;');
  assert.deepEqual((await overlay.changes()).map(change => change.path), [path.join('src', 'index.ts')]);
});

test('subagent overlays omit Git-ignored local files from copies and change reports', async t => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'polon-worktree-ignore-'));
  let overlay: AgentWorktree | undefined;
  t.after(async () => { if (overlay) await overlay.remove(); await rm(source, { recursive: true, force: true }); });
  await writeFile(path.join(source, '.gitignore'), 'private-cache/\n*.local\n');
  await mkdir(path.join(source, 'src'));
  await writeFile(path.join(source, 'src', '.gitignore'), 'nested-ignored.dat\n');
  await writeFile(path.join(source, 'src', '.ignore'), 'ignored.dat\n');
  await writeFile(path.join(source, 'main.ts'), 'export const main = true;');
  await writeFile(path.join(source, 'src', 'visible.ts'), 'export const visible = true;');
  await writeFile(path.join(source, 'src', 'nested-ignored.dat'), 'dummy nested git-ignored data');
  await writeFile(path.join(source, 'src', 'ignored.dat'), 'dummy nested ignored data');
  await mkdir(path.join(source, 'private-cache'));
  await writeFile(path.join(source, 'private-cache', 'api-key-screenshot.png'), 'dummy local screenshot');
  await writeFile(path.join(source, 'session.local'), 'dummy local report');

  overlay = await AgentWorktree.create(source);
  assert.equal(await readFile(path.join(overlay.root, 'main.ts'), 'utf8'), 'export const main = true;');
  assert.equal(await readFile(path.join(overlay.root, 'src', 'visible.ts'), 'utf8'), 'export const visible = true;');
  await assert.rejects(readFile(path.join(overlay.root, 'src', 'nested-ignored.dat')));
  await assert.rejects(readFile(path.join(overlay.root, 'src', 'ignored.dat')));
  await assert.rejects(readFile(path.join(overlay.root, 'private-cache', 'api-key-screenshot.png')));
  await assert.rejects(readFile(path.join(overlay.root, 'session.local')));

  await mkdir(path.join(overlay.root, 'private-cache'), { recursive: true });
  await writeFile(path.join(overlay.root, 'private-cache', 'new.local'), 'ignored change');
  await writeFile(path.join(overlay.root, 'new.ts'), 'export const next = true;');
  assert.deepEqual((await overlay.changes()).map(change => change.path), ['new.ts']);

  await writeFile(path.join(overlay.root, '.gitignore'), 'private-cache/\n*.local\nmain.ts\n');
  await writeFile(path.join(overlay.root, 'main.ts'), 'export const main = false;');
  assert.deepEqual((await overlay.changes()).map(change => change.path), ['.gitignore', 'main.ts', 'new.ts']);
});

test('dependency workspace stages successful node changes and preserves the original baseline', async t => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'polon-worktree-graph-'));
  let branch: AgentWorktree | undefined, worker: AgentWorktree | undefined;
  t.after(async () => { if (worker) await worker.remove(); if (branch) await branch.remove(); await rm(source, { recursive: true, force: true }); });
  await writeFile(path.join(source, 'shared.txt'), 'base');
  branch = await AgentWorktree.create(source);
  worker = await AgentWorktree.create(branch.root);
  await writeFile(path.join(worker.root, 'shared.txt'), 'staged by dependency');
  await writeFile(path.join(worker.root, 'new.txt'), 'new dependency output');
  await branch.mergeChanges(await worker.changes());
  assert.equal(await readFile(path.join(branch.root, 'shared.txt'), 'utf8'), 'staged by dependency');
  assert.equal(await readFile(path.join(branch.root, 'new.txt'), 'utf8'), 'new dependency output');
  assert.deepEqual((await branch.changes()).map(change => change.path), ['new.txt', 'shared.txt']);
  assert.equal(await readFile(path.join(source, 'shared.txt'), 'utf8'), 'base', 'staging must never change the user workspace');
});

test('dependency workspace rejects stale staged changes before mutating any other path', async t => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'polon-worktree-graph-conflict-'));
  let branch: AgentWorktree | undefined, worker: AgentWorktree | undefined;
  t.after(async () => { if (worker) await worker.remove(); if (branch) await branch.remove(); await rm(source, { recursive: true, force: true }); });
  await writeFile(path.join(source, 'a.txt'), 'base a');
  await writeFile(path.join(source, 'b.txt'), 'base b');
  branch = await AgentWorktree.create(source);
  worker = await AgentWorktree.create(branch.root);
  await writeFile(path.join(worker.root, 'a.txt'), 'worker a');
  await writeFile(path.join(worker.root, 'b.txt'), 'worker b');
  const changes = await worker.changes();
  await writeFile(path.join(branch.root, 'b.txt'), 'another dependency changed it');
  await assert.rejects(branch.mergeChanges(changes), /Graph conflict: b\.txt changed/);
  assert.equal(await readFile(path.join(branch.root, 'a.txt'), 'utf8'), 'base a', 'preflight should prevent an earlier file from being staged');
  assert.equal(await readFile(path.join(branch.root, 'b.txt'), 'utf8'), 'another dependency changed it');
});

test('subagent overlay rejects source trees over the file limit', async t => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'polon-worktree-limit-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  for (let index = 0; index <= 5000; index++) await writeFile(path.join(source, `file-${index}.txt`), '');
  await assert.rejects(AgentWorktree.create(source), /5,000 files/);
});
