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

test('subagent overlay rejects source trees over the file limit', async t => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'polon-worktree-limit-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  for (let index = 0; index <= 5000; index++) await writeFile(path.join(source, `file-${index}.txt`), '');
  await assert.rejects(AgentWorktree.create(source), /5,000 files/);
});
