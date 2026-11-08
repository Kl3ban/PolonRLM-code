import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, access, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTwoFilesPatch } from 'diff';
import { defaultSettings } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltins } from '../src/tools/builtin.js';
import { firstUsablePython, resolvePythonCommand } from '../src/tools/python-runtime.js';
import { selectOcrLanguage, tesseractFailure } from '../src/tools/documents.js';
import type { ApprovalRequest, Settings } from '../src/core/types.js';

async function fixture(t: TestContext, changes: Partial<Settings> = {}) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'PolonRLM-tools-'));
  const root = path.join(folder, 'workspace'); await mkdir(root);
  const settings = { ...defaultSettings(), ...changes };
  const permissions = new Permissions(settings);
  const approvals: ApprovalRequest[] = [];
  permissions.approve = async request => { approvals.push(request); return true; };
  const workspace = await Workspace.open(root, permissions);
  const registry = new ToolRegistry(permissions, 20000); registerBuiltins(registry, workspace, settings);
  t.after(async () => {
    const target = path.resolve(folder);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('PolonRLM-tools-'));
    await registry.close();
    // Remove Windows junctions before walking their targets during recursive fixture cleanup.
    for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isSymbolicLink()) await unlink(path.join(root, entry.name));
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const run = (name: string, args: Record<string, unknown>, mode: 'BUILD' | 'PLAN' | 'REVIEW' = 'BUILD', signal = new AbortController().signal) => registry.execute(name, args, { mode, signal });
  return { folder, root, settings, permissions, approvals, workspace, registry, run };
}

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

test('file tools perform exact unique edits, literal replacements, patch and delete with diffs', async t => {
  const f = await fixture(t, { permissions: 'workspace' });
  const initial = await f.run('write_file', { path: 'dir/żółć.txt', content: 'first\nunique\nlast\n' });
  assert.match(initial, /\+unique/);
  assert.equal(await f.run('read_file', { path: 'dir/żółć.txt', start: 2, lines: 1 }), '2: unique');
  await f.run('edit_file', { path: 'dir/żółć.txt', old: 'unique', replacement: '$& literal' });
  assert.match(await readFile(path.join(f.root, 'dir/żółć.txt'), 'utf8'), /\$& literal/);
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
