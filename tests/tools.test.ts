import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, access, readdir, unlink, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTwoFilesPatch } from 'diff';
import { defaultSettings } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltins, withShellLock } from '../src/tools/builtin.js';
import { registerProjectMap } from '../src/tools/project-map.js';
import { SessionStore } from '../src/core/store.js';
import { RecoveryCipher } from '../src/core/recovery.js';
import { firstUsablePython, resolvePythonCommand } from '../src/tools/python-runtime.js';
import { selectOcrLanguage, tesseractFailure } from '../src/tools/documents.js';
import type { ApprovalRequest, Settings } from '../src/core/types.js';
import type { SandboxExecutor } from '../src/tools/sandbox.js';

async function fixture(t: TestContext, changes: Partial<Settings> = {}, sandbox?: SandboxExecutor, withProjectStore = false) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'PolonRLM-tools-'));
  const root = path.join(folder, 'workspace'); await mkdir(root);
  const settings = { ...defaultSettings(), ...changes };
  let projectStore = withProjectStore ? new SessionStore(folder) : undefined;
  const permissions = new Permissions(settings);
  const approvals: ApprovalRequest[] = [];
  permissions.approve = async request => { approvals.push(request); return true; };
  const workspace = await Workspace.open(root, permissions);
  const registry = new ToolRegistry(permissions, 20000); registerBuiltins(registry, workspace, settings, { sandbox, store: projectStore });
  t.after(async () => {
    const target = path.resolve(folder);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('PolonRLM-tools-'));
    await registry.close();
    projectStore?.close();
    // Remove Windows junctions before walking their targets during recursive fixture cleanup.
    for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isSymbolicLink()) await unlink(path.join(root, entry.name));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const run = (name: string, args: Record<string, unknown>, mode: 'BUILD' | 'PLAN' | 'REVIEW' = 'BUILD', signal = new AbortController().signal) => registry.execute(name, args, { mode, signal });
  const replaceProjectStore = (store: SessionStore) => { projectStore?.close(); projectStore = store; registerProjectMap(registry, workspace, store); };
  return { folder, root, settings, permissions, approvals, workspace, registry, run, get projectStore() { return projectStore; }, replaceProjectStore };
}

test('tool schemas do not require parameters that have defaults', async t => {
  const f = await fixture(t);
  const readFile = f.registry.getSpec('read_file')!.parameters as { required?: string[] };
  assert.deepEqual(readFile.required, ['path']);
  const runTests = f.registry.getSpec('run_tests')!.parameters as { required?: string[] };
  assert.deepEqual(runTests.required, ['command']);
  const readFiles = f.registry.getSpec('read_files')!.parameters as { properties?: { files?: { items?: { required?: string[] } } } };
  assert.deepEqual(readFiles.properties?.files?.items?.required, ['path']);
  const searchBatch = f.registry.getSpec('search_batch')!.parameters as { properties?: { queries?: { items?: { required?: string[] } } } };
  assert.deepEqual(searchBatch.properties?.queries?.items?.required, ['pattern']);
});

test('required sandbox mode fails closed for unisolated file writes and browser actions', async t => {
  const f = await fixture(t, { sandboxMode: 'required' });
  await writeFile(path.join(f.root, 'existing.txt'), 'keep');
  await assert.rejects(f.run('write_file', { path: 'new.txt', content: 'x' }), /not covered by the OS command sandbox/);
  await assert.rejects(f.run('edit_file', { path: 'existing.txt', old: 'keep', replacement: 'changed' }), /not covered by the OS command sandbox/);
  assert.equal(await f.run('read_file', { path: 'existing.txt' }), '1: keep');
  await assert.rejects(f.run('browser_automation', { url: 'https://example.com' }), /not covered by the OS command sandbox/);
  await assert.rejects(f.run('computer_use', { action: 'list' }), /not covered by the OS command sandbox/);
});

test('shell lock serializes concurrent mutating commands', async () => {
  let active = 0;
  let peak = 0;
  const task = () => withShellLock(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
  });
  await Promise.all([task(), task(), task()]);
  assert.equal(peak, 1);
});

test('task plan updates survive a store and tool-registry restart without overwriting the goal', async t => {
  const f = await fixture(t, {}, undefined, true);
  const firstStore = f.projectStore!;
  const session = firstStore.create(f.root);
  const goal = { objective: 'Finish the parser change', status: 'active' as const, tokenBudget: 0, usedTokens: 0 };
  const plan = [{ step: 'Inspect parser behavior', status: 'done' as const }, { step: 'Add regression test', status: 'in_progress' as const }];
  firstStore.saveWorkflow(session, { goal });
  const context = { mode: 'BUILD' as const, signal: new AbortController().signal, sessionId: session };

  await f.registry.execute('plan_update', { steps: plan }, context);
  assert.deepEqual(firstStore.workflow(session), { goal, plan });

  const reopened = new SessionStore(f.folder);
  f.replaceProjectStore(reopened);
  const resumed = new ToolRegistry(f.permissions, 20_000);
  registerBuiltins(resumed, f.workspace, f.settings, { store: reopened });
  t.after(() => resumed.close());
  assert.equal(await resumed.execute('plan_status', {}, context), JSON.stringify(plan));
  assert.deepEqual(reopened.workflow(session), { goal, plan });
});

test('automatic host fallback asks separately and denial prevents command preparation', async t => {
  const settings = { ...defaultSettings(), toolPermissions: { execute_command: 'auto' as const } };
  let prepared = false;
  const sandbox = {
    mode: 'auto',
    status: async () => ({ mode: 'auto', available: false, backend: 'test', reason: 'backend unavailable' }),
    needsFallbackApproval: () => true,
    prepare: async () => { prepared = true; throw new Error('must not prepare'); },
  } as unknown as SandboxExecutor;
  const f = await fixture(t, settings, sandbox);
  f.permissions.approve = async request => { f.approvals.push(request); return false; };
  await assert.rejects(f.run('execute_command', { command: 'must-not-run' }), /Approval denied/);
  assert.equal(prepared, false);
  assert.deepEqual(f.approvals.map(item => item.tool), ['sandbox_fallback']);
});

test('workspace rejects traversal, external junctions, protected aliases and Windows ambiguous names', async t => {
  const f = await fixture(t);
  const outside = path.join(f.folder, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'private.txt'), 'private');
  await assert.rejects(f.workspace.resolve('../outside/private.txt'), /outside the workspace/);
  await assert.rejects(f.workspace.resolve(outside), /outside the workspace/);
  await symlink(outside, path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.workspace.resolve('escape/private.txt'), /outside the workspace/);
  await assert.rejects(f.workspace.resolve('escape/new/deeper.txt'), /outside the workspace/);
  const metadata = path.join(f.root, '.git'); await mkdir(metadata); await writeFile(path.join(metadata, 'config'), 'git');
  await symlink(metadata, path.join(f.root, 'metadata-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.workspace.resolve('.git/config'), /metadata directory/);
  await assert.rejects(f.workspace.resolve('metadata-alias/config'), /metadata directory/);
  if (process.platform === 'win32') {
    await assert.rejects(f.workspace.resolve('.GIT/config'), /metadata directory/);
    await assert.rejects(f.workspace.resolve('file.txt:stream'), /Invalid Windows path/);
    await assert.rejects(f.workspace.resolve('.git /config'), /Invalid Windows path/);
    await assert.rejects(f.workspace.resolve('NUL.txt'), /Invalid Windows path/);
    for (const name of ['CONIN$', 'CONOUT$.txt', 'CLOCK$', 'COM¹.log', 'LPT²']) await assert.rejects(f.workspace.resolve(name), /Invalid Windows path/);
  }
});

test('file writes reject NUL before approval and preserve original content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'text.txt'), 'original');
  await assert.rejects(f.run('edit_file', { path: 'text.txt', old: 'original', replacement: 'bad\0text' }), /NUL/);
  await assert.rejects(f.run('write_file', { path: 'new.txt', content: '\0' }), /NUL/);
  assert.equal(f.approvals.length, 0);
  assert.equal(await readFile(path.join(f.root, 'text.txt'), 'utf8'), 'original');
  await assert.rejects(access(path.join(f.root, 'new.txt')));
  await assert.rejects(Workspace.open(path.join(f.root, 'text.txt'), f.permissions), /Workspace must be a directory/);
});

test('text tools preserve UTF-8 BOM and UTF-16 Windows file encodings through edit and undo', async t => {
  const f = await fixture(t, { permissions: 'workspace' });
  const be = (text: string) => {
    const body = Buffer.from(text, 'utf16le');
    for (let index = 0; index < body.length; index += 2) [body[index], body[index + 1]] = [body[index + 1]!, body[index]!];
    return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
  };
  const cases = [
    { name: 'utf8bom.txt', original: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('before\r\n', 'utf8')]), replacement: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('after\r\n', 'utf8')]) },
    { name: 'powershell-le.ps1', original: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('before\r\n', 'utf16le')]), replacement: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('after\r\n', 'utf16le')]) },
    { name: 'powershell-be.ps1', original: be('before\r\n'), replacement: be('after\r\n') },
  ];
  for (const item of cases) {
    await writeFile(path.join(f.root, item.name), item.original);
    assert.equal(await f.workspace.readText(item.name), 'before\r\n');
    await f.run('write_file', { path: item.name, content: 'after\r\n' });
    assert.deepEqual(await readFile(path.join(f.root, item.name)), item.replacement);
    await f.workspace.undo('BUILD');
    assert.deepEqual(await readFile(path.join(f.root, item.name)), item.original);
    await f.run('delete_file', { path: item.name });
    await f.workspace.undo('BUILD');
    assert.deepEqual(await readFile(path.join(f.root, item.name)), item.original);
  }
});

test('invalid encoded text is rejected before file approval or mutation', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'broken.txt'), Buffer.from([0xff, 0xfe, 0x61]));
  const approvals = f.approvals.length;
  await assert.rejects(f.workspace.readText('broken.txt'), /UTF-16/);
  await assert.rejects(f.run('write_file', { path: 'broken.txt', content: 'replacement' }), /UTF-16/);
  assert.equal(f.approvals.length, approvals);
  assert.deepEqual(await readFile(path.join(f.root, 'broken.txt')), Buffer.from([0xff, 0xfe, 0x61]));
});

test('project inspection skips an oversized manifest', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ scripts: { build: 'x'.repeat(5_000_001) } }));
  const result = JSON.parse(await f.run('inspect_project', {}));
  assert.ok(result.files.includes('package.json'));
  assert.equal(result.scripts, undefined);
});

test('project_map rebuilds a safe module graph from current files without returning source or secret text', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'src', 'lib'), { recursive: true });
  await mkdir(path.join(f.root, 'node_modules', 'ignored'), { recursive: true });
  await mkdir(path.join(f.root, 'dist'), { recursive: true });
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'map-fixture', packageManager: 'npm@11', scripts: { build: 'echo DO_NOT_RETURN_SCRIPT_BODY' }, dependencies: { lodash: '^4.0.0' } }));
  await writeFile(path.join(f.root, '.env'), 'SECRET_SHOULD_NEVER_BE_READ');
  await writeFile(path.join(f.root, 'src', 'main.ts'), 'import { helper } from "./lib/helper";\nimport lodash from "lodash";\nexport const run = () => helper();\nconst privateText = "DO_NOT_RETURN_SOURCE_BODY";');
  await writeFile(path.join(f.root, 'src', 'lib', 'helper.ts'), 'export function helper() { return 1; }');
  await writeFile(path.join(f.root, 'node_modules', 'ignored', 'bad.ts'), 'export const ignored = true;');
  await writeFile(path.join(f.root, 'dist', 'bad.js'), 'export const generated = true;');
  const map = JSON.parse(await f.run('project_map', {}));
  assert.equal(map.sourceFilesIndexed, 2);
  assert.ok(map.modules.some((entry: any) => entry.path === 'src/main.ts' && entry.exports.includes('run')));
  assert.deepEqual(map.importEdges, [{ from: 'src/main.ts', to: 'src/lib/helper.ts' }]);
  assert.deepEqual(map.externalImports, [{ name: 'lodash', references: 1 }]);
  assert.equal(map.manifests[0].name, 'map-fixture');
  assert.deepEqual(map.manifests[0].scripts, ['build']);
  const serialized = JSON.stringify(map);
  assert.doesNotMatch(serialized, /DO_NOT_RETURN|SECRET_SHOULD/);
  assert.doesNotMatch(serialized, /node_modules|dist\/bad/);
  await writeFile(path.join(f.root, 'src', 'lib', 'helper.ts'), 'export const changed = true;');
  const refreshed = JSON.parse(await f.run('project_map', {}));
  assert.ok(refreshed.modules.some((entry: any) => entry.path === 'src/lib/helper.ts' && entry.exports.includes('changed')));
});

test('project_map reports the exact truncation reason when the byte cap is hit', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'src'), { recursive: true });
  await writeFile(path.join(f.root, 'src', 'large.ts'), `export const value = "${'x'.repeat(1_100_000)}";`);
  const map = JSON.parse(await f.run('project_map', { maxBytes: 1_000_000 }));
  assert.equal(map.truncated, true);
  assert.equal(map.truncatedReason, 'byte-limit');
  assert.equal(map.sourceFilesIndexed, 0);
  await assert.rejects(f.run('project_map', { maxBytes: 0 }), /Invalid arguments/);
});

test('project_map indexes best-effort symbols and imports in Python, Go and Rust without source text', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'src'), { recursive: true });
  await writeFile(path.join(f.root, 'src', 'worker.py'), [
    '# def FakeComment(): pass',
    '"""',
    'def FakeString(): pass',
    '"""',
    'from pathlib import Path',
    'import os.path',
    'def public_worker(): return Path("SOURCE_SENTINEL")',
    'class _PrivateWorker: pass',
  ].join('\n'));
  await writeFile(path.join(f.root, 'src', 'server.go'), [
    '// func FakeComment() {}',
    'package server',
    'import (',
    '\t"fmt"',
    '\t"net/http"',
    ')',
    '/* func FakeBlock() {} */',
    'func ServeHTTP() {}',
    'func helper() {}',
    'type Server struct {}',
  ].join('\n'));
  await writeFile(path.join(f.root, 'src', 'engine.rs'), [
    '// pub fn fake_comment() {}',
    'use std::fmt;',
    'pub struct Engine {}',
    'fn helper() {}',
    'pub async fn run() {}',
    'const TEXT: &str = "pub fn fake_string() {} SOURCE_SENTINEL";',
  ].join('\n'));

  const map = JSON.parse(await f.run('project_map', {}));
  assert.equal(map.sourceFilesFound, 3);
  assert.equal(map.sourceFilesIndexed, 3);
  const python = map.modules.find((entry: any) => entry.path === 'src/worker.py');
  assert.equal(python.language, 'python');
  assert.deepEqual(python.imports, ['os.path', 'pathlib']);
  assert.deepEqual(python.symbols.map((symbol: any) => symbol.name), ['public_worker', '_PrivateWorker']);
  assert.equal(python.symbols[0].visibility, 'public');
  assert.equal(python.symbols[1].visibility, 'internal');

  const go = map.modules.find((entry: any) => entry.path === 'src/server.go');
  assert.equal(go.language, 'go');
  assert.deepEqual(go.imports, ['fmt', 'net/http']);
  assert.deepEqual(go.symbols.map((symbol: any) => symbol.name), ['ServeHTTP', 'helper', 'Server']);
  assert.equal(go.symbols[0].visibility, 'public');

  const rust = map.modules.find((entry: any) => entry.path === 'src/engine.rs');
  assert.equal(rust.language, 'rust');
  assert.deepEqual(rust.imports, ['std::fmt']);
  assert.deepEqual(rust.symbols.map((symbol: any) => symbol.name), ['Engine', 'helper', 'run', 'TEXT']);
  assert.equal(rust.symbols[0].visibility, 'public');

  const serialized = JSON.stringify(map);
  assert.doesNotMatch(serialized, /FakeComment|FakeBlock|FakeString|SOURCE_SENTINEL/);
});

test('project_map caps aggregate symbols, imports and exports in large workspaces', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'src'), { recursive: true });
  for (let file = 0; file < 110; file++) {
    const source = [
      ...Array.from({ length: 40 }, (_, item) => `import { value } from "pkg${file}_${item}";`),
      ...Array.from({ length: 20 }, (_, item) => `export const symbol${item} = ${item};`),
    ].join('\n');
    await writeFile(path.join(f.root, 'src', `module${file}.ts`), source);
  }

  const map = JSON.parse(await f.registry.execute('project_map', {}, { mode: 'BUILD', signal: new AbortController().signal, outputLimit: 2_000_000 }));
  assert.equal(map.sourceFilesIndexed, 110);
  assert.equal(map.symbolCount, 600);
  assert.equal(map.omittedIndexedSymbolCount, 110 * 16 - 600);
  assert.equal(map.modules.reduce((count: number, entry: any) => count + entry.imports.length, 0), 800);
  assert.equal(map.omittedImportCount, 110 * 40 - 800);
  assert.equal(map.modules.reduce((count: number, entry: any) => count + entry.exports.length, 0), 1200);
  assert.equal(map.omittedExportCount, 110 * 20 - 1200);
});

test('project_map persists hashes and summaries without source, then refreshes changed files across restarts', async t => {
  const f = await fixture(t, {}, undefined, true);
  await mkdir(path.join(f.root, 'src'), { recursive: true });
  await writeFile(path.join(f.root, 'package.json'), JSON.stringify({ name: 'persistent-map', scripts: { test: 'node --test' }, dependencies: { example: '^1.0.0' } }));
  await writeFile(path.join(f.root, 'src', 'a.ts'), 'export const first = "SOURCE_BODY_MUST_NOT_BE_CACHED";');
  await writeFile(path.join(f.root, 'src', 'b.ts'), 'export function second() { return 2; }');
  let store = f.projectStore!;
  store.saveProjectIndex(f.workspace.root, '.', { version: 2, root: f.workspace.root, target: '.', files: {} });

  const first = JSON.parse(await f.run('project_map', {}));
  assert.equal(first.index.cacheAvailable, true);
  assert.equal(first.index.loadedExisting, false);
  assert.equal(first.index.cachedFiles, 0);
  assert.equal(first.index.refreshedFiles, 3);
  assert.equal(first.index.persisted, true);
  const cachedIndex = store.projectIndex(f.workspace.root, '.') as any;
  assert.equal(cachedIndex.version, 3);
  assert.match(cachedIndex.files['src/a.ts'].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(cachedIndex.files['src/a.ts'].language, 'typescript');
  assert.deepEqual(cachedIndex.files['src/a.ts'].symbols.map((symbol: any) => symbol.name), ['first']);
  const cached = JSON.stringify(cachedIndex);
  assert.doesNotMatch(cached, /SOURCE_BODY_MUST_NOT_BE_CACHED/);

  const second = JSON.parse(await f.run('project_map', {}));
  assert.equal(second.index.loadedExisting, true);
  assert.equal(second.index.cachedFiles, 3);
  assert.equal(second.index.refreshedFiles, 0);
  assert.ok(second.sourceBytesRead > 0);
  assert.equal(second.sourceBytesParsed, 0);
  const isolated = JSON.parse(await f.registry.execute('project_map', {}, { mode: 'BUILD', signal: new AbortController().signal, isolated: true }));
  assert.equal(isolated.index.cacheAvailable, false);
  assert.equal(isolated.index.persisted, false);
  assert.equal(isolated.index.refreshedFiles, 3);

  f.replaceProjectStore(new SessionStore(f.folder));
  store = f.projectStore!;
  await writeFile(path.join(f.root, 'src', 'b.ts'), 'export const updated = true;');
  const third = JSON.parse(await f.run('project_map', {}));
  assert.equal(third.index.loadedExisting, true);
  assert.equal(third.index.cachedFiles, 2);
  assert.equal(third.index.refreshedFiles, 1);
  assert.ok(third.modules.some((entry: any) => entry.path === 'src/b.ts' && entry.exports.includes('updated')));
  assert.ok(!third.modules.some((entry: any) => entry.exports.includes('second')));

  const forced = JSON.parse(await f.run('project_map', { refresh: true }));
  assert.equal(forced.index.mode, 'forced-refresh');
  assert.equal(forced.index.cachedFiles, 0);
  assert.equal(forced.index.refreshedFiles, 3);
});

test('project_map detects same-size edits even when file metadata is restored', async t => {
  const f = await fixture(t, {}, undefined, true);
  await mkdir(path.join(f.root, 'src'), { recursive: true });
  const filename = path.join(f.root, 'src', 'stable.ts');
  await writeFile(filename, 'export const alpha = 1;');
  const fixedTime = new Date('2020-01-01T00:00:00.000Z');
  await utimes(filename, fixedTime, fixedTime);

  const first = JSON.parse(await f.run('project_map', {}));
  assert.ok(first.modules.some((entry: any) => entry.exports.includes('alpha')));
  const before = await stat(filename, { bigint: true });

  await writeFile(filename, 'export const bravo = 1;');
  await utimes(filename, fixedTime, fixedTime);
  const after = await stat(filename, { bigint: true });
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino);

  const refreshed = JSON.parse(await f.run('project_map', {}));
  assert.equal(refreshed.index.cachedFiles, 0);
  assert.equal(refreshed.index.refreshedFiles, 1);
  assert.ok(refreshed.modules.some((entry: any) => entry.exports.includes('bravo')));
  assert.ok(!refreshed.modules.some((entry: any) => entry.exports.includes('alpha')));
});

test('file tools perform exact unique edits, literal replacements, patch and delete with diffs', async t => {
  const f = await fixture(t, { permissions: 'workspace' });
  const initial = await f.run('write_file', { path: 'dir/żółć.txt', content: 'first\nunique\nlast\n' });
  assert.match(initial, /\+unique/);
  assert.equal(await f.run('read_file', { path: 'dir/żółć.txt', start: 2, lines: 1 }), '2: unique');
  assert.equal(await f.run('read_file', { path: 'dir/żółć.txt', line_start: 2, line_end: 2 }), '2: unique');
  assert.equal(await f.run('read_file', { path: 'dir/żółć.txt', offset: 1, limit: 1 }), '2: unique');
  await assert.rejects(f.run('read_file', { path: 'dir/żółć.txt', line_start: 2, line_end: 1 }), /line_end must be/);
  await f.run('edit_file', { path: 'dir/żółć.txt', old: 'unique', replacement: '$& literal' });
  assert.match(await readFile(path.join(f.root, 'dir/żółć.txt'), 'utf8'), /\$& literal/);
  await f.run('edit_file', { path: 'dir/żółć.txt', old: '$& literal', content: 'content alias' });
  assert.match(await readFile(path.join(f.root, 'dir/żółć.txt'), 'utf8'), /content alias/);
  await assert.rejects(f.run('edit_file', { path: 'dir/żółć.txt', old: 'content alias' }), /Provide replacement/);
  await f.run('write_file', { path: 'overlap.txt', content: 'aaa' });
  await assert.rejects(f.run('edit_file', { path: 'overlap.txt', old: 'aa', replacement: 'b' }), /Text must occur exactly once/);
  await assert.rejects(f.run('edit_file', { path: 'overlap.txt', old: 'absent', replacement: 'b' }), /Text must occur exactly once/);
  const before = await readFile(path.join(f.root, 'dir/żółć.txt'), 'utf8');
  const after = before.replace('last', 'patched');
  await f.run('apply_patch', { path: 'dir/żółć.txt', patch: createTwoFilesPatch('x', 'x', before, after) });
  assert.equal(await readFile(path.join(f.root, 'dir/żółć.txt'), 'utf8'), after);
  await assert.rejects(f.run('apply_patch', { path: 'dir/żółć.txt', patch: createTwoFilesPatch('x', 'x', 'unrelated\n', 'replacement\n') }), /does not match/);
  await f.run('delete_file', { path: 'dir/żółć.txt' });
  await assert.rejects(access(path.join(f.root, 'dir/żółć.txt')));
  assert.ok(f.approvals.some(request => request.tool === 'delete_file'));
  await f.workspace.undo('BUILD');
  assert.equal(await readFile(path.join(f.root, 'dir/żółć.txt'), 'utf8'), after);
});

test('approval denial preserves files; approval includes preview; stale approval cannot overwrite edits', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'safe.txt'), 'original');
  f.permissions.approve = async request => { assert.match(request.preview!, /\+changed/); return false; };
  await assert.rejects(f.run('write_file', { path: 'safe.txt', content: 'changed' }), /Approval denied/);
  assert.equal(await readFile(path.join(f.root, 'safe.txt'), 'utf8'), 'original');
  f.permissions.approve = async () => { await writeFile(path.join(f.root, 'safe.txt'), 'external'); return true; };
  await assert.rejects(f.run('write_file', { path: 'safe.txt', content: 'changed' }), /File changed while the write was being approved/);
  assert.equal(await readFile(path.join(f.root, 'safe.txt'), 'utf8'), 'external');
});

test('PLAN/REVIEW and readonly prohibit writes and shell while allowing file reads', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'x.txt'), 'readable');
  for (const mode of ['PLAN', 'REVIEW'] as const) {
    assert.match(await f.run('read_file', { path: 'x.txt' }, mode), /readable/);
    await assert.rejects(f.run('write_file', { path: 'x.txt', content: 'bad' }, mode), /blocks this action/);
    await assert.rejects(f.run('execute_command', { command: 'exit 0' }, mode), /blocks this action/);
    assert.ok(!f.registry.specs(mode).some(spec => ['write_file', 'execute_command'].includes(spec.name)));
  }
  f.settings.permissions = 'readonly';
  await assert.rejects(f.run('write_file', { path: 'x.txt', content: 'bad' }), /readonly/);
  assert.equal(await readFile(path.join(f.root, 'x.txt'), 'utf8'), 'readable');
});

test('concurrent mutations and undo serialize; repeated undo walks history instead of toggling', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'ordered.txt'), 'A');
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  f.permissions.approve = async () => {
    if (first) { first = false; entered(); await new Promise<void>(resolve => { release = resolve; }); }
    return true;
  };
  const one = f.workspace.change('edit_file', 'ordered.txt', before => before + 'B', 'BUILD');
  await waiting;
  const two = f.workspace.change('edit_file', 'ordered.txt', before => before + 'C', 'BUILD');
  const undo = f.workspace.undo('BUILD');
  release(); await Promise.all([one, two, undo]);
  assert.equal(await readFile(path.join(f.root, 'ordered.txt'), 'utf8'), 'AB');
  await f.workspace.undo('BUILD');
  assert.equal(await readFile(path.join(f.root, 'ordered.txt'), 'utf8'), 'A');
  assert.match(await f.workspace.undo('BUILD'), /No changes/);
});

test('separate workspace instances reject stale concurrent writes instead of overwriting them', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'PolonRLM-workspace-lock-'));
  const root = path.join(folder, 'workspace'); await mkdir(root);
  const permissions = new Permissions(defaultSettings()); permissions.approve = async () => true;
  const first = await Workspace.open(root, permissions), second = await Workspace.open(root, permissions);
  const firstStore = new SessionStore(folder), secondStore = new SessionStore(folder);
  const cipher = await RecoveryCipher.open(folder);
  first.attachRecovery(firstStore, cipher); second.attachRecovery(secondStore, cipher);
  t.after(async () => { firstStore.close(); secondStore.close(); cipher.close(); await rm(folder, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'shared.txt'), 'original');
  let postHashChecks = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const timer = setTimeout(release, 250);
  for (const workspace of [first, second]) {
    const originalResolve = workspace.resolve.bind(workspace);
    let calls = 0;
    workspace.resolve = async input => {
      const resolved = await originalResolve(input);
      if (++calls === 2) {
        postHashChecks++;
        if (postHashChecks === 2) { clearTimeout(timer); release(); }
        await gate;
      }
      return resolved;
    };
  }
  const edit = (workspace: Workspace, content: string) => workspace.change('write_file', 'shared.txt', before => {
    if (before !== 'original') throw new Error('File changed during the concurrent edit.');
    return content;
  }, 'BUILD');
  const results = await Promise.allSettled([edit(first, 'first'), edit(second, 'second')]);
  clearTimeout(timer);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'only one write based on the same stale contents may succeed');
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.ok(['first', 'second'].includes(await readFile(path.join(root, 'shared.txt'), 'utf8')));
});

test('stale undo is rejected without losing history; atomic replacement cannot modify outside hardlink', async t => {
  const f = await fixture(t, { permissions: 'workspace' });
  await writeFile(path.join(f.root, 'x'), 'old');
  await f.workspace.change('write_file', 'x', () => 'new', 'BUILD');
  await writeFile(path.join(f.root, 'x'), 'external');
  await assert.rejects(f.workspace.undo('BUILD'), /outside the change log/);
  await writeFile(path.join(f.root, 'x'), 'new');
  await f.workspace.undo('BUILD');
  assert.equal(await readFile(path.join(f.root, 'x'), 'utf8'), 'old');
  const outside = path.join(f.folder, 'hardlink-target.txt'); await writeFile(outside, 'outside');
  await link(outside, path.join(f.root, 'linked.txt'));
  await f.workspace.change('write_file', 'linked.txt', () => 'inside', 'BUILD');
  assert.equal(await readFile(outside, 'utf8'), 'outside');
  assert.equal(await readFile(path.join(f.root, 'linked.txt'), 'utf8'), 'inside');
});

test('atomic multi-file apply rolls back earlier and current files when a later recovery commit fails', async t => {
  const f = await fixture(t, {}, undefined, true);
  await writeFile(path.join(f.root, 'first.txt'), 'before first');
  await writeFile(path.join(f.root, 'second.txt'), 'before second');
  const cipher = await RecoveryCipher.open(f.folder);
  t.after(() => cipher.close());
  f.workspace.attachRecovery(f.projectStore!, cipher);
  const store = f.projectStore!;
  const setState = store.setRecoveryChangeState.bind(store);
  let failOnce = true;
  (store as any).setRecoveryChangeState = (workspace: string, id: string, state: string) => {
    if (state === 'applied' && store.recoveryChange(workspace, id)?.path === 'second.txt' && failOnce) {
      failOnce = false;
      throw new Error('injected recovery journal failure');
    }
    return setState(workspace, id, state);
  };

  const result = await f.workspace.applyChangesAtomically('agent_apply', [
    { path: 'first.txt', before: 'before first', after: 'after first' },
    { path: 'second.txt', before: 'before second', after: 'after second' },
  ], 'BUILD');

  assert.match(result.error ?? '', /injected recovery journal failure/);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.rolledBack, ['second.txt', 'first.txt']);
  assert.equal(await readFile(path.join(f.root, 'first.txt'), 'utf8'), 'before first');
  assert.equal(await readFile(path.join(f.root, 'second.txt'), 'utf8'), 'before second');
  const rows = f.projectStore!.recoveryChanges(f.workspace.root);
  assert.ok(rows.length === 2 && rows.every(change => change.state === 'rolled_back'), JSON.stringify({ result, rows }));
  assert.equal(f.projectStore!.recoveryGroup(f.workspace.root, rows[0]!.groupId!)?.state, 'rolled_back');
});

test('atomic multi-file apply restores files when the recovery group cannot commit', async t => {
  const f = await fixture(t, {}, undefined, true);
  await writeFile(path.join(f.root, 'first.txt'), 'before first');
  await writeFile(path.join(f.root, 'second.txt'), 'before second');
  const cipher = await RecoveryCipher.open(f.folder);
  t.after(() => cipher.close());
  f.workspace.attachRecovery(f.projectStore!, cipher);
  const store = f.projectStore!;
  const setGroupState = store.setRecoveryGroupState.bind(store);
  let failOnce = true;
  (store as any).setRecoveryGroupState = (workspace: string, id: string, state: string) => {
    if (state === 'committed' && failOnce) { failOnce = false; throw new Error('injected group commit failure'); }
    return setGroupState(workspace, id, state);
  };

  const result = await f.workspace.applyChangesAtomically('agent_apply', [
    { path: 'first.txt', before: 'before first', after: 'after first' },
    { path: 'second.txt', before: 'before second', after: 'after second' },
  ], 'BUILD');

  assert.match(result.error ?? '', /injected group commit failure/);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(result.rolledBack, ['second.txt', 'first.txt']);
  assert.equal(await readFile(path.join(f.root, 'first.txt'), 'utf8'), 'before first');
  assert.equal(await readFile(path.join(f.root, 'second.txt'), 'utf8'), 'before second');
  const rows = f.projectStore!.recoveryChanges(f.workspace.root);
  assert.ok(rows.length === 2 && rows.every(change => change.state === 'rolled_back'));
  assert.equal(f.projectStore!.recoveryGroup(f.workspace.root, rows[0]!.groupId!)?.state, 'rolled_back');
});

test('a file write is rolled back when its recovery journal cannot mark it applied', async t => {
  const f = await fixture(t, {}, undefined, true);
  await writeFile(path.join(f.root, 'single.txt'), 'before');
  const cipher = await RecoveryCipher.open(f.folder);
  t.after(() => cipher.close());
  f.workspace.attachRecovery(f.projectStore!, cipher);
  const store = f.projectStore!;
  const setState = store.setRecoveryChangeState.bind(store);
  (store as any).setRecoveryChangeState = (workspace: string, id: string, state: string) => {
    if (state === 'applied' && store.recoveryChange(workspace, id)?.path === 'single.txt') throw new Error('injected recovery journal failure');
    return setState(workspace, id, state);
  };

  await assert.rejects(f.workspace.change('write_file', 'single.txt', () => 'after', 'BUILD'), /recovery journal failure/i);
  assert.equal(await readFile(path.join(f.root, 'single.txt'), 'utf8'), 'before');
  const row = f.projectStore!.recoveryChanges(f.workspace.root).find(change => change.path === 'single.txt');
  assert.equal(row?.state, 'rolled_back');
});

test('ripgrep searches paths and literal content including dash-prefixed patterns', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'dir space')); await writeFile(path.join(f.root, 'dir space', 'sample.ts'), 'first\nneedle.* literal\n--dash\n');
  await mkdir(path.join(f.root, 'node_modules')); await writeFile(path.join(f.root, 'node_modules', 'hidden.ts'), 'needle.* literal');
  const files = await f.run('search_files', { pattern: '*.ts' }, 'PLAN');
  assert.match(files, /sample\.ts/); assert.ok(!files.includes('hidden.ts'));
  const content = await f.run('search_content', { pattern: 'needle.*', path: 'dir space' }, 'PLAN');
  assert.match(content, /:2:needle\.\* literal/);
  assert.match(await f.run('search_content', { pattern: '--dash' }), /--dash/);
  assert.equal(await f.run('search_content', { pattern: 'no matches' }), 'No results.');
});

test('shell uses real exit codes, Unicode output and alias-specific permissions', async t => {
  const f = await fixture(t);
  const command = process.platform === 'win32' ? "Write-Output 'żółć'; exit 7" : "printf 'żółć'; exit 7";
  const result = JSON.parse(await f.run('execute_command', { command }));
  assert.equal(result.exitCode, 7); assert.match(result.stdout, /żółć/);
  f.settings.allowTools = ['run_tests'];
  const allowed = JSON.parse(await f.run('run_tests', { command: process.platform === 'win32' ? "Write-Output 'allowed'" : "printf 'allowed'" }));
  assert.equal(allowed.exitCode, 0); assert.match(allowed.stdout, /allowed/);
  assert.equal(f.approvals.at(-1)?.tool, 'run_tests');
  await assert.rejects(f.run('execute_command', { command: 'exit 0' }), /allowlist/);
});

test('Python selection skips unavailable commands and accepts the first working interpreter', async () => {
  const selected = await firstUsablePython([
    { command: 'C:\\WindowsApps\\python.exe', prefixArgs: [] },
    { command: 'C:\\uv\\python.exe', prefixArgs: [] },
  ], async candidate => candidate.command.includes('uv'));
  assert.equal(selected.command, 'C:\\uv\\python.exe');
  await assert.rejects(firstUsablePython([{ command: 'missing-python', prefixArgs: [] }], async () => false), /Python 3\.8\+/);
});

test('execute_python runs through the discovered interpreter instead of the Windows Store alias', async t => {
  const f = await fixture(t, { permissions: 'all' });
  try { await resolvePythonCommand(); }
  catch (error) { t.skip(error instanceof Error ? error.message : 'Python 3.8+ is not installed on this test machine.'); return; }
  const result = JSON.parse(await f.run('execute_python', { code: "import sys; print(sys.executable); print('PYTHON_OK')" }));
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /PYTHON_OK/);
  assert.doesNotMatch(result.stdout, /\\WindowsApps\\/i);
});

test('Python and OCR setup failures explain the missing dependency', () => {
  assert.match(tesseractFailure({ exitCode: 9009 }) ?? '', /Tesseract OCR.*PATH.*pol.*eng/);
  assert.match(tesseractFailure({ stderr: "Error opening data file ... pol.traineddata" }) ?? '', /language data is missing/);
  assert.equal(tesseractFailure({ exitCode: 2, stderr: 'unrelated failure' }), undefined);
  const fallback = selectOcrLanguage('pol+eng', ['eng', 'osd']);
  assert.equal(fallback.language, 'eng');
  assert.match(fallback.warning ?? '', /missing languages pol.*using eng/i);
  assert.throws(() => selectOcrLanguage('pol', []), /No Tesseract language data/);
});

test('ocr_image runs on a local screenshot and discloses English fallback if Polish data is absent', async t => {
  const sample = 'C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\codex-clipboard-698a9666-934e-418b-88fe-13e077fafd75.png';
  try { await access(sample); } catch { t.skip('No local screenshot fixture on this machine.'); return; }
  const f = await fixture(t, { permissions: 'all' });
  await writeFile(path.join(f.root, 'ocr-sample.png'), await readFile(sample));
  const result = await f.run('ocr_image', { path: 'ocr-sample.png' });
  assert.match(result, /openrouter/i);
  assert.match(result, /OCR|recognized text/i);
});

test('shell cancellation terminates Windows PowerShell without Node IPC gracefulCancel', async t => {
  const f = await fixture(t);
  const abort = new AbortController();
  const started = Date.now();
  const promise = f.run('execute_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30' }, 'BUILD', abort.signal);
  setTimeout(() => abort.abort(), 200);
  await assert.rejects(promise, error => error instanceof Error && error.name === 'AbortError');
  assert.ok(Date.now() - started < 5000, 'cancellation should not wait for the 30 second command');
});
