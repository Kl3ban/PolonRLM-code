import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/tools/workspace.js';
import { Permissions } from '../src/core/permissions.js';
import { defaultSettings } from '../src/core/config.js';
import { affectedDependents, discoverVerificationPlan, hashWorkspaceFiles, parseGitStatusPaths } from '../src/core/verification.js';

async function withWorkspace(run: (workspace: Workspace) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'polonrlm-verify-'));
  try { await run(await Workspace.open(root, new Permissions(defaultSettings()))); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

test('verification commands use configured order or safe manifest detection', async () => {
  await withWorkspace(async workspace => {
    await writeFile(path.join(workspace.root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.0.0', scripts: { test: 'vitest run', check: 'tsc --noEmit', dev: 'vite' } }));
    const detected = await discoverVerificationPlan(workspace, []);
    assert.equal(detected.source, 'manifest');
    assert.deepEqual(detected.commands.map(item => item.command), ['pnpm run test', 'pnpm run check']);
    const configured = await discoverVerificationPlan(workspace, ['node verify.mjs', 'npm run custom']);
    assert.equal(configured.source, 'configured');
    assert.deepEqual(configured.commands.map(item => item.command), ['node verify.mjs', 'npm run custom']);
    const explicit = await discoverVerificationPlan(workspace, ['npm test'], 'node one-off.mjs');
    assert.equal(explicit.source, 'custom');
    assert.deepEqual(explicit.commands.map(item => item.command), ['node one-off.mjs']);
  });
});

test('verification detection skips npm init placeholder and recognizes Rust and Go', async () => {
  await withWorkspace(async workspace => {
    await writeFile(path.join(workspace.root, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    const empty = await discoverVerificationPlan(workspace, []);
    assert.equal(empty.commands.length, 0);
    await rm(path.join(workspace.root, 'package.json'));
    await writeFile(path.join(workspace.root, 'Cargo.toml'), '[package]\nname="fixture"\n');
    assert.deepEqual((await discoverVerificationPlan(workspace, [])).commands.map(item => item.command), ['cargo test', 'cargo check']);
    await rm(path.join(workspace.root, 'Cargo.toml'));
    await writeFile(path.join(workspace.root, 'go.mod'), 'module fixture\n');
    assert.deepEqual((await discoverVerificationPlan(workspace, [])).commands.map(item => item.command), ['go test ./...', 'go vet ./...']);
  });
});

test('Git paths are parsed without metadata and file hashes reveal edits during verification', async () => {
  assert.deepEqual(parseGitStatusPaths(' M src/app.ts\n?? notes/new file.txt\nR  old.ts -> src/new.ts\n?? .polonrlm/private.db\n'), ['src/app.ts', 'notes/new file.txt', 'src/new.ts']);
  await withWorkspace(async workspace => {
    await mkdir(path.join(workspace.root, 'src'));
    await writeFile(path.join(workspace.root, 'src/app.ts'), 'export const value = 1;');
    const before = await hashWorkspaceFiles(workspace, ['src/app.ts', 'deleted.ts']);
    assert.equal(before.get('deleted.ts'), null);
    await writeFile(path.join(workspace.root, 'src/app.ts'), 'export const value = 2;');
    const after = await hashWorkspaceFiles(workspace, ['src/app.ts', 'deleted.ts']);
    assert.notEqual(before.get('src/app.ts'), after.get('src/app.ts'));
  });
});

test('Git status parser decodes quoted, renamed, unicode, and deleted paths', () => {
  const status = [
    '?? "space name.ts"',
    'A  "za\\305\\274\\303\\263\\305\\202\\304\\207.ts"',
    'R  "old name.ts" -> "new name.ts"',
    'D  "tab\\tname.ts"',
    ' M deleted.ts',
    '?? ".git/config"',
  ].join('\n');
  assert.deepEqual(parseGitStatusPaths(status), ['space name.ts', 'zażółć.ts', 'new name.ts', 'tab\tname.ts', 'deleted.ts']);
  assert.deepEqual(parseGitStatusPaths('R  "a -> b.ts" -> "c -> d.ts"\n'), ['c -> d.ts']);
});

test('change impact analysis walks reverse imports with depth and size bounds', () => {
  const edges = [
    { from: 'src/api.ts', to: 'src/client.ts' },
    { from: 'src/page.ts', to: 'src/api.ts' },
    { from: 'tests/api.test.ts', to: 'src/api.ts' },
    { from: 'src/unrelated.ts', to: 'lib/x.ts' },
    { from: 'src\\windows.ts', to: 'src\\client.ts' },
  ];
  assert.deepEqual(affectedDependents(edges, ['src/client.ts']).sort(), ['src/api.ts', 'src/page.ts', 'src/windows.ts', 'tests/api.test.ts']);
  assert.deepEqual(affectedDependents(edges, ['src/client.ts'], 1).sort(), ['src/api.ts', 'src/windows.ts']);
  assert.equal(affectedDependents(edges, ['src/client.ts'], 3, 2).length, 2);
  assert.deepEqual(affectedDependents(edges, ['src/client.ts'], 3, 2).filter(path => path === 'src/client.ts'), []);
  assert.deepEqual(affectedDependents([], ['src/client.ts']), []);
});
