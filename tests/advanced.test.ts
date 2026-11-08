import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltins } from '../src/tools/builtin.js';
import { ProcessOutputBuffer } from '../src/tools/processes.js';
import ExcelJS from 'exceljs';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polon-advanced-')); const settings = defaultSettings(); settings.permissions = 'workspace'; settings.toolOutputLimit = 100000;
  const permissions = new Permissions(settings); permissions.approve = async () => true;
  const workspace = await Workspace.open(root, permissions); const registry = new ToolRegistry(permissions, 100000); registerBuiltins(registry, workspace, settings);
  t.after(async () => { await registry.close(); assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const run = async (name: string, args: Record<string, unknown>) => { const text = await registry.execute(name, args, { mode: 'BUILD', signal: new AbortController().signal }); try { return JSON.parse(text); } catch { return text; } };
  return { root, registry, permissions, run };
}

test('batch tools preserve independent results and filesystem boundaries', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a.txt'), 'hello\nworld');
  const result = await f.run('read_files', { files: [{ path: 'a.txt', start: 2, lines: 1 }, { path: '../private.txt' }] });
  assert.equal(result[0].content, '2: world'); assert.match(result[1].error, /outside the workspace/);
  const found = await f.run('search_batch', { queries: [{ pattern: 'world' }, { pattern: '*.txt', files: true }] });
  assert.match(found[0].content, /a.txt:2:world/); assert.match(found[1].content, /a.txt/);
});

test('read_document extracts XLSX values and does not evaluate formula cells', async t => {
  const f = await fixture(t);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Summary');
  sheet.addRow(['Item', 'Value']);
  sheet.addRow(['Count', 3]);
  sheet.getCell('B3').value = { formula: '1+1' };
  await workbook.xlsx.writeFile(path.join(f.root, 'report.xlsx'));

  const result = await f.run('read_document', { path: 'report.xlsx', from: 1, count: 3 });
  assert.match(result, /## Arkusz: Summary/);
  assert.match(result, /2:\s*Count\t3/);
  assert.match(result, /3:\s*\t\[formula\]/);
});

test('checkpoint detects conflicts and restores edits and missing files through normal writes', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a.txt'), 'before');
  const cp = await f.run('checkpoint_create', { name: 'before', paths: ['a.txt', 'new.txt'] });
  await f.run('write_file', { path: 'a.txt', content: 'after' }); await f.run('write_file', { path: 'new.txt', content: 'new' });
  const diff = await f.run('checkpoint_diff', { id: cp.id }); const expected = Object.fromEntries(diff.files.map((file: any) => [file.path, file.currentHash]));
  await writeFile(path.join(f.root, 'a.txt'), 'external');
  await assert.rejects(f.run('checkpoint_restore', { id: cp.id, expected }), /changed/);
  assert.equal(await readFile(path.join(f.root, 'new.txt'), 'utf8'), 'new');
  const fresh = await f.run('checkpoint_diff', { id: cp.id });
  const restored = await f.run('checkpoint_restore', { id: cp.id, expected: Object.fromEntries(fresh.files.map((file: any) => [file.path, file.currentHash])) });
  assert.deepEqual(restored.restored, ['a.txt', 'new.txt']); assert.equal(await readFile(path.join(f.root, 'a.txt'), 'utf8'), 'before'); await assert.rejects(readFile(path.join(f.root, 'new.txt')));
});

test('semantic tools diagnose, find references and rename a real TypeScript symbol', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a.ts'), 'export const amount: number = "bad";\nconsole.log(amount);');
  const diagnostics = await f.run('code_diagnostics', { path: 'a.ts' }); assert.ok(diagnostics.some((d: any) => d.code === 2322));
  const refs = await f.run('symbol_references', { path: 'a.ts', line: 1, column: 15 }); assert.equal(refs.length, 2);
  const definition = await f.run('symbol_definition', { path: 'a.ts', line: 2, column: 14 }); assert.equal(definition[0].line, 1);
  const result = await f.run('rename_symbol', { path: 'a.ts', line: 1, column: 15, newName: 'total', apply: true }); assert.deepEqual(result.applied, ['a.ts']);
  assert.match(await readFile(path.join(f.root, 'a.ts'), 'utf8'), /console.log\(total\)/);
});

test('AST edits require fresh hashes and exact nodes and reject broken syntax', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a.ts'), 'const answer = 1 + 2;');
  const found = await f.run('ast_search', { path: 'a.ts', kind: 'BinaryExpression' }); assert.equal(found.matches.length, 1);
  const range = found.matches[0];
  await assert.rejects(f.run('ast_edit', { path: 'a.ts', hash: found.hash, start: range.start, end: range.end, replacement: '(' }), /syntax error/);
  await f.run('ast_edit', { path: 'a.ts', hash: found.hash, start: range.start, end: range.end, replacement: '40 + 2' });
  assert.equal(await readFile(path.join(f.root, 'a.ts'), 'utf8'), 'const answer = 40 + 2;');
  await assert.rejects(f.run('ast_edit', { path: 'a.ts', hash: found.hash, start: range.start, end: range.end, replacement: '0' }), /hash/);
});

test('semantic rename preserves shorthand object keys and rejects reserved names', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'a.ts'), 'const amount = 1;\nconst result = { amount };');
  await assert.rejects(f.run('rename_symbol', { path: 'a.ts', line: 1, column: 8, newName: 'class', apply: true }), /syntax error/);
  await f.run('rename_symbol', { path: 'a.ts', line: 1, column: 8, newName: 'total', apply: true });
  assert.match(await readFile(path.join(f.root, 'a.ts'), 'utf8'), /\{ amount: total \}/);
});

test('background jobs return output and exit code; denial never starts a job', async t => {
  const f = await fixture(t);
  f.permissions.approve = async () => false; await assert.rejects(f.run('process_start', { command: 'echo should-not-run' }), /Approval denied/); assert.deepEqual(await f.run('process_list', {}), []);
  f.permissions.approve = async () => true;
  const job = await f.run('process_start', { command: 'echo hello-background', timeoutMs: 10000 });
  const output = await f.run('process_output', { id: job.id, waitMs: 10000 }); assert.equal(output.running, false); assert.equal(output.exitCode, 0); assert.match(output.output, /hello-background/);
  await assert.rejects(f.run('process_stop', { id: 'unowned-process' }), /Unknown/);
});

test('background process decoding preserves split UTF-8 and truncates on Unicode boundaries', async t => {
  const split = new ProcessOutputBuffer();
  split.write('stdout', Buffer.from([0xe2]));
  assert.equal(split.output, '');
  split.write('stdout', Buffer.from([0x82, 0xac])); split.end('stdout');
  assert.equal(split.output, '€');
  const bounded = new ProcessOutputBuffer();
  bounded.write('stdout', Buffer.from('😀' + 'x'.repeat(63999))); bounded.end('stdout');
  assert.equal(bounded.output.length, 63999);
  assert.equal(bounded.output, 'x'.repeat(63999));
  assert.equal(bounded.truncated, true);
});

test('background process output preserves a multibyte character split across real stream chunks', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'split-utf8.mjs'), "process.stdout.write(Buffer.from([0xe2]));\nsetTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 25);\n");
  const job = await f.run('process_start', { command: 'node split-utf8.mjs', timeoutMs: 5000 });
  const result = await f.run('process_output', { id: job.id, waitMs: 5000 });
  assert.equal(result.output, '€');
  assert.equal(result.exitCode, 0);
});

test('stdio LSP performs real framing, initialize and request, then stops its server', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'test.py'), 'hello = 1');
  const source = `let buffer=Buffer.alloc(0);process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;const n=Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0,end).toString())[1]);if(buffer.length<end+4+n)return;const m=JSON.parse(buffer.subarray(end+4,end+4+n));buffer=buffer.subarray(end+4+n);if(m.id===undefined)continue;const result=m.method==='initialize'?{capabilities:{hoverProvider:true}}:{contents:'fixture-hover'};const body=JSON.stringify({jsonrpc:'2.0',id:m.id,result});process.stdout.write('Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body)}});`;
  const result = await f.run('lsp_request', { command: process.execPath, args: ['-e', source], path: 'test.py', languageId: 'python', action: 'hover', timeoutMs: 5000 }); assert.equal(result.contents, 'fixture-hover');
});

test('background stop and registry shutdown terminate owned jobs', async t => {
  const f = await fixture(t);
  const command = 'node -e "setTimeout(function(){},30000)"';
  const first = await f.run('process_start', { command, timeoutMs: 10000 });
  const stopped = await f.run('process_stop', { id: first.id }); assert.equal(stopped.running, false);
  const second = await f.run('process_start', { command, timeoutMs: 10000 });
  await f.registry.close();
  const state = await f.run('process_output', { id: second.id }); assert.equal(state.running, false);
});
