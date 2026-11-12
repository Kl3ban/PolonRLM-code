import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { Workspace } from '../dist/tools/workspace.js';
import { Permissions } from '../dist/core/permissions.js';
import { ToolRegistry } from '../dist/tools/registry.js';
import { registerBuiltins } from '../dist/tools/builtin.js';
import { defaultSettings } from '../dist/core/config.js';
import { redact } from '../dist/core/secrets.js';

const reportPath = path.resolve('docs/tool-audit-report.json');
const root = await mkdtemp(path.join(tmpdir(), 'polonrlm-tool-audit-'));
const settings = { ...defaultSettings(), permissions: 'all', sandboxMode: 'off', verificationMode: 'manual', toolOutputLimit: 200_000 };
const permissions = new Permissions(settings);
const workspace = await Workspace.open(root, permissions);
const registry = new ToolRegistry(permissions, () => settings.toolOutputLimit);
registerBuiltins(registry, workspace, settings, {});

function walk(schema, tool, trail, problems) {
  if (!schema || typeof schema !== 'object') return;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const name of Array.isArray(schema.required) ? schema.required : []) {
    if (!properties[name]) problems.push({ tool, problem: `required property ${trail}${name} is not declared` });
    else if (Object.prototype.hasOwnProperty.call(properties[name], 'default')) problems.push({ tool, problem: `default property ${trail}${name} is required in JSON Schema` });
  }
  for (const [name, value] of Object.entries(properties)) walk(value, tool, `${trail}${name}.`, problems);
  if (schema.items) walk(schema.items, tool, `${trail}[].`, problems);
  for (const key of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(schema[key])) schema[key].forEach((value, index) => walk(value, tool, `${trail}${key}[${index}].`, problems));
}

const specs = registry.specs('BUILD');
const seen = new Set();
const schemaProblems = [];
for (const spec of specs) {
  if (!/^[a-z][a-z0-9_]+$/.test(spec.name)) schemaProblems.push({ tool: spec.name, problem: 'invalid tool name' });
  if (!spec.description || spec.description.trim().length < 10) schemaProblems.push({ tool: spec.name, problem: 'description is too short' });
  if (!spec.parameters || typeof spec.parameters !== 'object' || Array.isArray(spec.parameters)) schemaProblems.push({ tool: spec.name, problem: 'parameters is not a JSON Schema object' });
  else walk(spec.parameters, spec.name, '', schemaProblems);
  if (seen.has(spec.name)) schemaProblems.push({ tool: spec.name, problem: 'duplicate tool name' });
  seen.add(spec.name);
}

const probes = [];
const skipped = [];
async function probe(name, args, check) {
  const started = Date.now();
  try {
    const output = await registry.execute(name, args, { mode: 'BUILD', signal: AbortSignal.timeout(20_000) });
    const text = typeof output === 'string' ? output : JSON.stringify(output);
    if (check) await check(output);
    probes.push({ tool: name, status: 'PASS', durationMs: Date.now() - started, bytes: Buffer.byteLength(text ?? '') });
    return output;
  } catch (error) {
    probes.push({ tool: name, status: 'FAIL', durationMs: Date.now() - started, error: redact(String(error?.message ?? error)).slice(0, 500) });
    return undefined;
  }
}
function skip(name, reason) { skipped.push({ tool: name, reason }); }

try {
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'sample.ts'), 'export function add(a: number, b: number) { return a + b; }\nexport const value = add(1, 2);\n', 'utf8');
  await writeFile(path.join(root, 'README.md'), '# Audit fixture\n', 'utf8');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'audit-fixture', version: '1.0.0', type: 'module' }, null, 2), 'utf8');
  await execa('git', ['init', '-q'], { cwd: root });
  await execa('git', ['config', 'user.email', 'audit@example.invalid'], { cwd: root });
  await execa('git', ['config', 'user.name', 'Audit'], { cwd: root });
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-qm', 'fixture'], { cwd: root });

  await probe('read_file', { path: 'src/sample.ts', start: 1, lines: 5 });
  await probe('read_files', { files: [{ path: 'src/sample.ts' }, { path: 'README.md' }] });
  await probe('list_directory', { path: '.' });
  await probe('search_files', { pattern: '*.ts' });
  await probe('search_content', { pattern: 'export' });
  await probe('search_batch', { queries: [{ pattern: 'export' }, { pattern: '*.ts', files: true }] });
  await probe('inspect_project', {});
  await probe('detect_project_type', {});
  await probe('analyze_dependencies', {});
  await probe('project_map', {});
  await probe('code_outline', { path: 'src/sample.ts' });
  await probe('code_diagnostics', { path: 'src/sample.ts' });
  await probe('code_diagnostics_batch', { paths: ['src/sample.ts'] });
  await probe('symbol_definition', { path: 'src/sample.ts', line: 1, column: 17 });
  await probe('symbol_hover', { path: 'src/sample.ts', line: 1, column: 17 });
  await probe('symbol_references', { path: 'src/sample.ts', line: 1, column: 17 });
  await probe('rename_symbol', { path: 'src/sample.ts', line: 1, column: 17, newName: 'sum', apply: false });
  await probe('ast_search', { path: 'src/sample.ts', kind: 'FunctionDeclaration' });
  const ast = await registry.execute('ast_search', { path: 'src/sample.ts', kind: 'FunctionDeclaration' }, { mode: 'BUILD', signal: AbortSignal.timeout(20_000) });
  const astData = JSON.parse(String(ast));
  if (astData?.matches?.[0]) await probe('ast_edit', { path: 'src/sample.ts', hash: astData.hash, start: astData.matches[0].start, end: astData.matches[0].end, replacement: astData.matches[0].text });
  await probe('write_file', { path: 'src/generated.ts', content: 'export const generated = 1;\n' });
  await probe('edit_file', { path: 'src/generated.ts', old: '1', replacement: '2' });
  const beforePatch = await readFile(path.join(root, 'src', 'generated.ts'), 'utf8');
  const afterPatch = beforePatch.replace('2', '3');
  await probe('apply_patch', { path: 'src/generated.ts', patch: (await import('diff')).createTwoFilesPatch('src/generated.ts', 'src/generated.ts', beforePatch, afterPatch) });
  await probe('delete_file', { path: 'src/generated.ts' });
  await probe('git_status', {});
  await probe('git_diff', {});
  await probe('git_log', {});
  await probe('git_show', { revision: 'HEAD' });
  await probe('git_blame', { path: 'src/sample.ts' });
  await writeFile(path.join(root, 'src', 'committed.ts'), 'export const committed = true;\n', 'utf8');
  await probe('execute_command', { command: 'git add src/committed.ts' });
  await probe('git_commit', { message: 'audit commit' });
  await probe('read_document', { path: 'README.md' });
  await probe('plan_update', { steps: [{ step: 'audit', status: 'in_progress' }] });
  await probe('plan_status', {});
  await probe('execute_command', { command: 'node -e "console.log(42)"' });
  if (process.platform === 'win32') await probe('execute_powershell', { command: 'Write-Output 42' });
  else skip('execute_powershell', 'Windows-only tool');
  await probe('run_tests', { command: 'node -e "process.exit(0)"' });
  await probe('execute_python', { code: 'print(42)' }).catch(() => {});
  await probe('install_dependencies', { command: 'node -e "process.exit(0)"' });
  await probe('inspect_errors', { command: 'node -e "console.error(\'audit error\'); process.exit(1)"' });
  await probe('inspect_process', {});
  await probe('process_list', {});
  const startedProcess = await probe('process_start', { command: 'node -e "console.log(42)"' });
  let processId;
  try { processId = JSON.parse(String(startedProcess))?.id; } catch { /* no id */ }
  if (processId) {
    await probe('process_output', { id: processId });
    await probe('process_wait', { id: processId, text: '42', timeoutMs: 5000 });
    await probe('process_stop', { id: processId });
  } else skip('process_output/process_wait/process_stop', 'process id not returned');
  const interactive = await probe('process_start', { command: 'node -e "process.stdin.once(\'data\',d=>{console.log(\'got:\'+d.toString().trim());process.exit(0)})"', interactive: true });
  let interactiveId;
  try { interactiveId = JSON.parse(String(interactive))?.id; } catch { /* no id */ }
  if (interactiveId) {
    await probe('process_input', { id: interactiveId, input: 'hello\n' });
    await probe('process_wait', { id: interactiveId, text: 'got:hello', timeoutMs: 5000 });
    await probe('process_stop', { id: interactiveId });
  } else skip('process_input', 'interactive process id not returned');
  const checkpoint = await probe('checkpoint_create', { name: 'audit', paths: ['src/sample.ts'] });
  let checkpointId;
  try { checkpointId = JSON.parse(String(checkpoint))?.id ?? String(checkpoint).match(/[0-9a-f-]{8,}/)?.[0]; } catch { /* no id */ }
  if (checkpointId) {
    await probe('checkpoint_list', {});
    await probe('checkpoint_diff', { id: checkpointId });
    await probe('checkpoint_drop', { id: checkpointId });
  } else skip('checkpoint_list/checkpoint_diff/checkpoint_drop', 'checkpoint id not returned');
  const transaction = await probe('transaction_begin', { name: 'audit' });
  let transactionId;
  try { transactionId = JSON.parse(String(transaction))?.id; } catch { /* no id */ }
  await probe('transaction_status', {});
  if (transactionId) {
    await probe('write_file', { path: 'src/transaction.ts', content: 'export const transaction = true;\n' });
    await probe('transaction_commit', { id: transactionId });
  } else skip('transaction_commit', 'transaction id not returned');
  const rollbackTransaction = await probe('transaction_begin', { name: 'audit rollback' });
  let rollbackId;
  try { rollbackId = JSON.parse(String(rollbackTransaction))?.id; } catch { /* no id */ }
  if (rollbackId) {
    await probe('write_file', { path: 'src/rolled-back.ts', content: 'export const rolledBack = true;\n' });
    await probe('transaction_rollback', { id: rollbackId });
  } else skip('transaction_rollback', 'transaction id not returned');

  for (const [name, reason] of [
    ['browser', 'requires a real browser and is covered by tests/browser-*.test.ts'],
    ['browser_automation', 'requires a real browser'],
    ['browser_inspect', 'requires a real browser'],
    ['browser_configure', 'requires a real browser'],
    ['browser_sessions', 'requires a real browser'],
    ['computer_use', 'native Windows desktop only'],
    ['web_search', 'network-dependent; covered by local-web fixtures'],
    ['read_webpage', 'network-dependent; covered by web tests'],
    ['fetch_webpage', 'network-dependent; covered by web tests'],
    ['fetch_documentation', 'network-dependent'],
    ['download_to_disk', 'network-dependent'],
    ['github_repo_inspector', 'network-dependent'],
    ['lsp_request', 'needs an installed language server'],
    ['ocr_image', 'needs Tesseract language data'],
    ['delegate', 'needs a model and subagent workspace'],
    ['agent_resume', 'needs a persisted model run'],
    ['agent_message', 'needs a live team'],
    ['agent_changes', 'needs a live team'],
    ['agent_apply', 'needs a live team'],
    ['request_tool', 'needs a model permission flow'],
    ['ask_question', 'needs an interactive client'],
    ['get_goal', 'needs active goal state'],
    ['update_goal', 'needs active goal state'],
    ['search_history', 'needs archived history'],
    ['update_plan', 'alias covered by plan_update'],
    ['transaction_commit', 'mutating transaction path covered by tests'],
    ['checkpoint_restore', 'mutating restore path covered by tests'],
  ]) skip(name, reason);
} finally {
  const summary = {
    tools: specs.length,
    schemaPassed: schemaProblems.length === 0,
    probes: probes.length,
    passed: probes.filter(probe => probe.status === 'PASS').length,
    failed: probes.filter(probe => probe.status === 'FAIL').length,
    skipped: skipped.length,
  };
  const report = { date: new Date().toISOString(), summary, schemaProblems, probes, skipped };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ reportPath, summary, failures: probes.filter(probe => probe.status === 'FAIL') }, null, 2));
  await registry.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  if (summary.failed || !summary.schemaPassed) process.exitCode = 1;
}
