import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { ConfigManager } from '../src/core/config.js';
import { SecretVault, redact } from '../src/core/secrets.js';
import { SessionStore } from '../src/core/store.js';
import { Permissions } from '../src/core/permissions.js';
import { AgentRuntime } from '../src/core/runtime.js';
import { SkillsManager } from '../src/integrations/skills.js';
import { MCPManager } from '../src/integrations/mcp.js';
import { Workspace } from '../src/tools/workspace.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { registerBuiltins } from '../src/tools/builtin.js';
import { createProvider } from '../src/providers/provider.js';
import type { RuntimeEvent } from '../src/core/types.js';

if (process.env.POLONRLM_LIVE_TOOL_REVIEW !== '1') throw new Error("This spends Google API tokens. Set POLONRLM_LIVE_TOOL_REVIEW=1 after the user's explicit authorization.");

const projectRoot = process.cwd();
const reportPath = path.resolve('docs/tool-review-live.json');
const resume = process.env.POLONRLM_LIVE_TOOL_REVIEW_RESUME === '1';
const requestedCase = process.env.POLONRLM_LIVE_TOOL_REVIEW_CASE;
const liveCaseNames = [
  'workspace-read-and-inspection', 'file-edits-and-transactions', 'transaction-commit-smoke', 'checkpoint-lifecycle',
  'typescript-and-ast', 'lsp-protocol', 'documents-and-ocr', 'background-process-tools', 'git-read-and-commit',
  'git-commit-smoke', 'local-web-tools', 'browser-and-browser-automation', 'browser-automation-smoke', 'mcp-fixture',
  'skills-memory-question', 'history-and-goal', 'request-tool-approval-readonly', 'shell-and-system-commands',
  'test-and-dependency-commands', 'subagents-and-reviewed-apply', 'interview-finish',
];
const requestedCases = requestedCase?.split(',').map(name => name.trim()).filter(Boolean);
if (requestedCases) {
  const unknown = requestedCases.filter(name => !liveCaseNames.includes(name));
  if (!requestedCases.length || unknown.length) throw new Error(`Invalid live review case${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ') || '(empty)'}. Available: ${liveCaseNames.join(', ')}.`);
}
const isolated = await mkdtemp(path.join(os.tmpdir(), 'polon-tools-review-'));
const home = path.join(isolated, 'home');
const project = path.join(isolated, 'workspace');
await mkdir(home); await mkdir(project); await mkdir(path.join(project, 'src'));
const gitTemplate = path.join(home, 'git-templates');
await mkdir(gitTemplate);
await writeFile(path.join(home, 'gitconfig'), '', 'utf8');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(home, 'gitconfig');
process.env.GIT_CONFIG_COUNT = '0';
process.env.GIT_TEMPLATE_DIR = gitTemplate;
for (const name of ['GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete process.env[name];

const config = new ConfigManager(); await config.load();
const google = structuredClone(config.settings.providers.google!);
const key = await new SecretVault(config.home).get('google', google.apiKeyEnv);
if (!key) throw new Error('Google API key not found in the local secret vault.');
const catalog = await createProvider(google, key, 800).listModels();
const selected = catalog.find(model => model.id === google.model && model.toolCalling !== false)
  ?? catalog.find(model => /flash/i.test(model.id) && !/audio|tts|live|image|preview/i.test(model.id) && model.toolCalling !== false);
if (!selected) throw new Error('No listed Google model supports tool calls.');
google.model = selected.id;

const settings = {
  ...config.settings, provider: 'google', providers: { ...config.settings.providers, google }, mode: 'BUILD' as const,
  cortex: 1, maxSteps: 24, maxAgents: 2, maxDepth: 1, maxInputTokens: 20_000,
  maxOutputTokens: 1200, tokenBudget: 0, dollarBudget: 1000, timeoutMs: 20_000,
  permissions: 'all' as const, toolPermissions: {}, allowTools: [], denyTools: [],
};
const permissions = new Permissions(settings);
const workspace = await Workspace.open(project, permissions);
const store = new SessionStore(home);
const registry = new ToolRegistry(permissions, settings.toolOutputLimit);
registerBuiltins(registry, workspace, settings, { computer: false });
const mcp = new MCPManager({ fixture: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', path.join(projectRoot, 'tests/fixtures/mcp-server.ts'), '--stdio'], timeoutMs: 15_000 } });
const events: RuntimeEvent[] = [];
const baseProvider = createProvider(google, key, settings.maxOutputTokens);
let requestQueue = Promise.resolve(); let lastGoogleRequest = 0;
const throttledProvider = { ...baseProvider, async complete(...args: Parameters<typeof baseProvider.complete>) {
  let release!: () => void; const previous = requestQueue; requestQueue = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try {
    const wait = Math.max(0, lastGoogleRequest + 5_000 - Date.now());
    if (wait) await delay(wait, undefined, { signal: args[3] });
    lastGoogleRequest = Date.now();
    return await baseProvider.complete(...args);
  } finally { release(); }
} };
const runtime = new AgentRuntime(settings, store, registry, workspace, new SkillsManager(home, workspace.root), mcp, async () => throttledProvider, event => events.push(event));
runtime.askQuestion = async question => question.options[question.recommended]!.label;
const inventory = registry.discovery('BUILD').map(item => item.name).filter(name => name !== 'computer_use').sort();
assert.equal(inventory.includes('computer_use'), false);
assert.equal(registry.getSpec('computer_use'), undefined);

let priorChecks: any[] = [];
if (resume) {
  try { priorChecks = JSON.parse(await readFile(reportPath, 'utf8')).checks ?? []; } catch { priorChecks = []; }
}
const checks: any[] = priorChecks;
const usage = { input: 0, output: 0, cost: 0 };
const lspFixture = `let buffer=Buffer.alloc(0);const send=value=>{const body=Buffer.from(JSON.stringify(value));process.stdout.write('Content-Length: '+body.length+'\\r\\n\\r\\n');process.stdout.write(body)};process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(true){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)break;const match=/content-length:\\s*(\\d+)/i.exec(buffer.subarray(0,end).toString('ascii'));if(!match)process.exit(2);const length=Number(match[1]);if(buffer.length<end+4+length)break;const msg=JSON.parse(buffer.subarray(end+4,end+4+length).toString('utf8'));buffer=buffer.subarray(end+4+length);if(msg.id===undefined)continue;let result=null;if(msg.method==='initialize')result={capabilities:{documentSymbolProvider:true,textDocumentSync:1}};else if(msg.method==='textDocument/documentSymbol')result=[{name:'lspFixtureSymbol',kind:13,range:{start:{line:0,character:0},end:{line:0,character:20}},selectionRange:{start:{line:0,character:0},end:{line:0,character:10}}}];send({jsonrpc:'2.0',id:msg.id,result})}});`;
await seedWorkspace();
await mcp.connect('fixture');
const mcpNames = mcp.tools().map(tool => tool.name).sort();

async function runCase(name: string, prompt: string, required: string[], options: { prepare?: (session: string) => void; verify?: () => Promise<string> } = {}): Promise<void> {
  if (requestedCases && !requestedCases.includes(name)) return;
  events.length = 0;
  const session = store.create(workspace.root, `QA ${name}`);
  options.prepare?.(session);
  const start = Date.now();
  let answer = '';
  let fatal: string | undefined;
  try { answer = await runtime.run(session, prompt, AbortSignal.timeout(240_000)); }
  catch (error) { fatal = safe(error); }
  const operations = events.filter((event): event is Extract<RuntimeEvent, { type: 'tool' }> => event.type === 'tool' && event.state !== 'running');
  const called = [...new Set(operations.map(event => event.name!).filter(Boolean))];
  const errors = operations.filter(event => event.state === 'error').map(event => ({ name: event.name, detail: event.toolDetail, error: event.text }));
  const toolResults = store.messages(session).filter(message => message.role === 'tool').map(message => ({ name: message.name, isError: !!message.isError, result: redact(message.content).slice(0, 1200) }));
  const unsubstantiatedClaim = called.length === 0 && /urucham\w*|wykon\w*|sprawdz\w*|zadzia\w*|exit code|wynik:/i.test(answer);
  const evidence = options.verify ? await options.verify().catch(error => `verification failed: ${safe(error)}`) : undefined;
  const entry = { name, durationMs: Date.now() - start, required, called, missing: required.filter(tool => !called.includes(tool)),
    errors, fatal, unsubstantiatedClaim, evidence, answer: redact(answer), operations: operations.map(event => ({ name: event.name, detail: event.toolDetail, state: event.state, ms: event.durationMs, ...(event.state === 'error' ? { error: safe(event.text) } : {}) })), toolResults, usage: store.usage(session) };
  const old = checks.findIndex(check => check.name === name); if (old >= 0) checks.splice(old, 1);
  checks.push(entry);
  const current = store.usage(session); usage.input += current.input; usage.output += current.output; usage.cost += current.cost;
  await writeReport();
  console.log(`${name}: ${required.length - entry.missing.length}/${required.length} expected tools; ${errors.length} tool errors; ${entry.durationMs}ms`);
}

async function writeReport(): Promise<void> {
  const tested = new Set(checks.flatMap(entry => entry.called));
  const findings = [
    { severity: 'high', area: 'execute_python', status: 'failed on this PC', evidence: 'The tool returned exit code 9009 because PATH resolves python.exe to the WindowsApps install alias. A managed Python 3.11 executable exists, but execute_python does not use it.', impact: 'Python code cannot run through this tool until interpreter selection is fixed.' },
    { severity: 'high', area: 'model tool-use fidelity', status: 'failed once, then targeted retries passed', evidence: 'In the broad shell task the model claimed commands ran while it made zero tool calls. Separate short tasks did invoke the tools and their results matched the reported outputs.', impact: 'The model can report unverified actions; final answers need to be checked against tool results.' },
    { severity: 'medium', area: 'browser screenshot loop', status: 'repeated without progress', evidence: 'One browser task invoked the same screenshot action 10 times without a navigation or input action between screenshots, then hit the test-only 100000-token cap.', impact: 'Repeated screenshots waste context and can prevent the rest of a task from completing.' },
    { severity: 'medium', area: 'schema discovery', status: 'recovered after validation errors', evidence: 'The model attempted checkpoint_create once and four TypeScript symbol tools before their schemas were active. The runtime rejected those calls; later discovered calls succeeded.', impact: 'Schema-blind retries add errors and consume extra model requests.' },
    { severity: 'environment', area: 'ocr_image', status: 'unavailable on this PC', evidence: 'Tesseract is not installed or on PATH; OCR returned the operating-system command-not-found error.', impact: 'The OCR tool needs Tesseract and its Polish/English language data installed.' },
    { severity: 'note', area: 'test limits', status: 'Google Free Tier rate limit encountered', evidence: 'The API limits generation requests to 15 per minute; the rerun script now spaces requests. Initial long cases also hit a 100000-token test-harness budget; focused retests used the app default of unlimited tokens.', impact: 'The incomplete initial cases are retained in the report; targeted retests completed missing tools.' },
  ];
  const report = { date: new Date().toISOString(), model: google.model, permissions: 'all in disposable workspace; user data untouched', computerUse: 'excluded and not registered', inventory,
    runtimeTools: ['discover_tools','request_tool','ask_question','finish_interview','load_skill','remember','search_history','get_goal','update_goal','delegate','agent_message','agent_changes','agent_apply'],
    findings,
    mcpFixtureTools: mcpNames, tested: [...tested].sort(), untested: [...inventory.filter(name => !tested.has(name)), ...mcpNames.filter(name => !tested.has(name))].sort(),
    usage: { input: checks.reduce((sum, item) => sum + item.usage.input, 0), output: checks.reduce((sum, item) => sum + item.usage.output, 0), costKnown: false }, checks };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

try {
  console.log(`Google live review: ${google.model}; ${inventory.length} registry tools; ${mcpNames.length} fixture MCP tools.`);
  await runCase('workspace-read-and-inspection',
    'This is a disposable QA workspace. Use the tools named here, via discover_tools when needed. Call list_directory and read_file on README.md; find *.ts with search_files and the literal QA_MARKER_731 with search_content; inspect the project with inspect_project, detect_project_type, and analyze_dependencies; batch-read README.md and src/sample.ts using read_files; run search_batch for QA_MARKER_731 and *.ts; then set a 2-step plan with plan_update and read it with plan_status. Do not edit files. Report which checks worked.',
    ['list_directory','read_file','search_files','search_content','inspect_project','detect_project_type','analyze_dependencies','read_files','search_batch','plan_update','plan_status']);

  await runCase('file-edits-and-transactions',
    'In this disposable workspace, exercise these tools in order and inspect each result: write_file new-note.txt with two lines; edit_file to replace exactly `draft` with `final`; apply_patch patch-note.txt changing old-line to new-line with a standard unified diff; delete_file delete-me.txt. First call discover_tools with `transaction` and wait for the returned schemas. Then use transaction_begin, transaction_status, write_file on tx-note.txt, transaction_status, transaction_rollback using its returned id; start a second transaction, write tx-commit.txt, check status and transaction_commit. Never touch any path outside this workspace. Summarize only completed calls.',
    ['write_file','edit_file','apply_patch','delete_file','transaction_begin','transaction_status','transaction_rollback','transaction_commit']);

  await runCase('transaction-commit-smoke',
    'Use discover_tools first with `transaction`, then wait for its returned schemas. Start one transaction named `commit-smoke`, create `commit-probe.txt` with write_file, inspect transaction_status, and call transaction_commit with the exact returned id. Report only the tool results.',
    ['discover_tools','transaction_begin','write_file','transaction_status','transaction_commit']);

  await runCase('checkpoint-lifecycle',
    'First call discover_tools with `checkpoint` and wait for all returned checkpoint schemas. Then use checkpoint_create on checkpoint.txt. Change the file with write_file. Call checkpoint_diff and use the returned currentHash for checkpoint_restore. Verify with read_file. Then checkpoint_list and checkpoint_drop. All paths are in this disposable workspace. Report only actions confirmed by tool results.',
    ['checkpoint_create','checkpoint_diff','checkpoint_restore','checkpoint_list','checkpoint_drop','write_file','read_file']);

  await runCase('typescript-and-ast',
    'First call discover_tools with `symbol`, `code`, and `ast`; wait for those results before attempting any named tool. Then analyze src/sample.ts using code_diagnostics, code_outline, symbol_definition, symbol_references, and symbol_hover at line 1 column 14. Preview then apply rename_symbol changing `sampleValue` to `renamedValue` at line 1 column 14. Use ast_search for a VariableDeclaration containing renamedValue, then ast_edit that exact range/hash to change its initializer from 41 to 42. Finally call code_diagnostics again. Use only arguments accepted by schemas and report only confirmed results.',
    ['code_diagnostics','code_outline','symbol_definition','symbol_references','symbol_hover','rename_symbol','ast_search','ast_edit']);

  await runCase('lsp-protocol',
    'Use lsp_request on src/sample.ts with command `node`, args [`lsp-fixture.cjs`], languageId `typescript`, action `symbols`, line 1, column 1, timeoutMs 8000. Return the symbol names from the LSP result. This workspace contains a tiny fixture server implementing the LSP handshake.',
    ['lsp_request']);

  await runCase('documents-and-ocr',
    'Read qa.pdf, qa.xlsx, and qa.txt using read_document. Then attempt ocr_image on qa.png with language `eng`. Report the exact document markers you can read and whether OCR is available; do not claim OCR succeeded if its dependency is missing.',
    ['read_document','ocr_image']);

  await runCase('background-process-tools',
    'Exercise process_start, process_list, process_wait, process_output, process_input, and process_stop in this disposable workspace. Start `node ready.cjs`; use its returned id to wait for `READY`, inspect output and list jobs. Then start `node interactive.cjs` with interactive=true, send `hello` plus newline using process_input with closeStdin=true, and verify `ACK:hello` with process_output. Finally start `node wait.cjs`, stop that owned process with process_stop, and report its final state. Discover process tools by keyword; do not start any other command.',
    ['process_start','process_list','process_wait','process_output','process_input','process_stop']);

  await runCase('git-read-and-commit',
    'Use write_file to create git-marker.txt containing `committed marker`. Stage only that file by calling execute_command with `git add -- git-marker.txt`. Use git_status and git_diff with staged=true to verify the staged diff, then git_commit with message `QA: verify git tools`. Finally use git_log, git_show with revision HEAD, and git_blame on README.md line 1 for 1 line. Only modify the disposable repository. Report the commit hash and status.',
    ['write_file','execute_command','git_status','git_diff','git_commit','git_log','git_show','git_blame']);

  await runCase('git-commit-smoke',
    'Create `commit-probe.txt` with write_file, stage only it using execute_command `git add -- commit-probe.txt`, then use discover_tools with `git_commit`. Wait for the schema and commit the staged file with message `QA commit smoke`. Verify with git_status that the worktree is clean. This is the disposable repo only. Do not claim success without the commit result.',
    ['write_file','execute_command','discover_tools','git_commit','git_status']);

  await runCase('local-web-tools',
    'Research one public internet question: search for `Python programming language official website`, read one useful source with read_webpage and a second with fetch_webpage, use fetch_documentation for `https://docs.python.org/3/`, inspect `https://github.com/python/cpython` subpath `Include` with github_repo_inspector, and download `https://raw.githubusercontent.com/python/cpython/main/LICENSE` as `python-license.txt` using download_to_disk. Give a compact report based only on returned results. This is public online research; do not use browser tools.',
    ['web_search','read_webpage','fetch_webpage','fetch_documentation','github_repo_inspector','download_to_disk']);

  await runCase('browser-and-browser-automation',
    'Use the persistent browser once to launch https://example.com. Call browser_sessions once and confirm that the launched session is listed. Use browser text once to read the page. Then close the persistent session. Finally call browser_automation exactly once with action `text` and URL https://example.com. This is read-only: do not click links, submit forms, take screenshots, or repeat an action. Report the page title and confirm the session was closed.',
    ['browser','browser_sessions','browser_automation']);

  await runCase('browser-automation-smoke',
    'Call discover_tools with `browser_automation` and wait for that schema. Then invoke browser_automation exactly once with action `screenshot`, URL `https://example.com`, and output `browser-smoke.png`. Do not use the persistent browser or interact with the page. Report only whether the screenshot was saved.',
    ['discover_tools','browser_automation'], { verify: async () => {
      const image = await readFile(await workspace.resolve('browser-smoke.png'));
      assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      return `PNG screenshot saved (${image.length} bytes)`;
    } });

  await runCase('mcp-fixture',
    'Use the connected fixture MCP tools: mcp_fixture_sum with a=20 and b=22; mcp_fixture_slow with milliseconds=10; and mcp_fixture_failure once to inspect its deliberate error response. Do not retry failures. Report 42, completion, and the expected error without exposing server internals.',
    mcpNames);

  await runCase('skills-memory-question',
    'Use load_skill to read the enabled skill `qa-fixture` when relevant. Use remember to store the nonsecret procedure `QA marker is QA_MARKER_731`. Then ask one clear user question with ask_question and two choices; this test runner will choose the recommended option. Report the skill marker, saved memory name, and answer.',
    ['load_skill','remember','ask_question']);

  await runCase('history-and-goal',
    'Use search_history to find the exact QA color recorded in the prior conversation. Then use get_goal to inspect the disposable test goal and update_goal to mark only that test goal complete with evidence from this test. Tell me the color and saved goal status.',
    ['search_history','get_goal','update_goal'], { prepare: session => {
      store.append(session, { role: 'user', content: 'For QA history, the secret-free marker color is copper-amber.' });
      store.append(session, { role: 'assistant', content: 'Confirmed: the review marker color is copper-amber.' });
      store.archiveContext(session, [{ role: 'assistant', name: 'polonrlm_context', content: 'Older conversation compacted; search the archived transcript for the QA marker color.' }]);
      store.saveWorkflow(session, { goal: { objective: 'Verify that temporary QA workflow tools work.', status: 'active', tokenBudget: 0, usedTokens: 0 } });
    } });

  settings.permissions = 'readonly';
  permissions.approve = async () => true;
  await runCase('request-tool-approval-readonly',
    'Create approval-probe.txt containing exactly `approved once` with write_file. First discover the exact write_file schema. Since readonly policy blocks it, request one-time approval for the same exact arguments and wait for this harness to approve. Execute only once.',
    ['discover_tools','request_tool'], { verify: async () => (await readFile(path.join(project, 'approval-probe.txt'), 'utf8')).trim() });
  settings.permissions = 'all';

  await runCase('shell-and-system-commands',
    'This is an execution test, not a request for a plan. First call discover_tools with `execute_powershell execute_python inspect_process` and wait for the schemas. Then use execute_command `Write-Output EXEC_OK`, execute_powershell `[System.Environment]::OSVersion.Platform`, execute_python with `print("PY_OK")`, and inspect_process once. Do not claim a command ran without its tool result. Report actual outputs and Python availability.',
    ['discover_tools','execute_command','execute_powershell','execute_python','inspect_process']);

  await runCase('test-and-dependency-commands',
    'This is an execution test, not a request for a plan. First call discover_tools with `run_tests install_dependencies inspect_errors` and wait for those schemas. Then call run_tests with `node --test review.test.cjs`, install_dependencies with `npm install --package-lock-only --ignore-scripts --offline`, and inspect_errors with `Write-Output NO_ERRORS`. All commands run in the disposable workspace. Report only actual exit codes and outputs; never invent a result.',
    ['discover_tools','run_tests','install_dependencies','inspect_errors']);

  await runCase('subagents-and-reviewed-apply',
    'Delegate two small independent QA tasks: a coder must create `subagent-note.txt` containing `reviewed change` in its isolated copy using write_file; a reviewer must send a short agent_message to the coder confirming the exact expected text, then report. After delegation, inspect the coder changes with agent_changes, apply only `subagent-note.txt` using agent_apply, and read it with read_file to verify. Do not alter any other file.',
    ['delegate','agent_message','agent_changes','agent_apply','write_file','read_file']);

  await runCase('interview-finish',
    'This is only a disposable interview-tool smoke test. Ask one concise question using ask_question with two options. After the test runner answers, call finish_interview with a one-sentence summary of the selected option. Do not make project changes.',
    ['ask_question','finish_interview'], { prepare: session => store.saveWorkflow(session, { grill: { task: 'choose a harmless QA label', active: true } }) });

  assert.ok(checks.length > 0, 'No live smoke cases were selected.');
  await writeReport();
  const finalReport = JSON.parse(await readFile(reportPath, 'utf8'));
  const missing = finalReport.untested;
  const targetNames = new Set([...inventory, ...mcpNames]); const targetCovered = [...targetNames].filter(name => finalReport.tested.includes(name)).length;
  console.log(`Live review finished. ${targetCovered}/${targetNames.size} registered tools exercised; ${missing.length} untested; token usage ${finalReport.usage.input} in / ${finalReport.usage.output} out.`);
} finally {
  await registry.close().catch(() => {}); await mcp.close().catch(() => {}); store.close();
  await rm(isolated, { recursive: true, force: true, maxRetries: 0 }).catch(async () => {
    try {
      await unlinkReparsePoints(isolated);
      await rm(isolated, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (error) { console.warn(`Test workspace cleanup failed; isolated workspace retained at ${isolated}: ${safe(error)}`); }
  });
}

async function unlinkReparsePoints(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try { await unlink(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    else if (entry.isDirectory()) await unlinkReparsePoints(target);
  }
}

function safe(value: unknown): string { return redact(value instanceof Error ? value.message : String(value)); }

async function seedWorkspace(): Promise<void> {
  await writeFile(path.join(project, 'README.md'), 'Review baseline.\nSecond line.\n', 'utf8');
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'polonrlm-tool-review', version: '1.0.0', private: true, scripts: { test: 'node --test review.test.cjs' }, dependencies: {} }, null, 2), 'utf8');
  await writeFile(path.join(project, 'review.test.cjs'), "const test = require('node:test'); const assert = require('node:assert/strict'); test('isolated QA fixture', () => assert.equal(2 + 2, 4));\n", 'utf8');
  await writeFile(path.join(project, 'src/sample.ts'), 'export const sampleValue = 41;\nexport function getSample(){ return sampleValue; }\n// QA_MARKER_731\n', 'utf8');
  for (const [name, text] of [['draft.txt','draft\n'],['patch-note.txt','old-line\n'],['delete-me.txt','temporary\n'],['checkpoint.txt','original checkpoint\n'],['qa.txt','QA_TEXT_MARKER'],['README.md','Review baseline.\nSecond line.\n'],['readme.txt','document text marker']]) await writeFile(path.join(project, name), text, 'utf8');
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('QA'); sheet.addRow(['marker', 'QA_XLSX_MARKER']); await workbook.xlsx.writeFile(path.join(project, 'qa.xlsx'));
  await writeFile(path.join(project, 'qa.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64'));
  await writeFile(path.join(project, 'ready.cjs'), "console.log('READY'); setTimeout(()=>{}, 2500);\n", 'utf8');
  await writeFile(path.join(project, 'interactive.cjs'), "process.stdin.on('data', data => { console.log('ACK:' + data.toString().trim()); process.exit(0); }); setTimeout(()=>{}, 10000);\n", 'utf8');
  await writeFile(path.join(project, 'wait.cjs'), 'setTimeout(()=>{}, 30000);\n', 'utf8');
  await writeFile(path.join(project, 'lsp-fixture.cjs'), lspFixture, 'utf8');
  await writeFile(path.join(project, 'qa.pdf'), makePdf('QA_PDF_MARKER'), 'binary');
  const { execa } = await import('execa');
  for (const args of [['init','--quiet'],['config','user.name','PolonRLM QA'],['config','user.email','qa@example.invalid'],['add','--all'],['commit','--quiet','-m','fixture baseline']]) {
    const result = await execa('git', args, { cwd: project, reject: false, windowsHide: true });
    if (result.exitCode !== 0) throw new Error(`Could not prepare disposable git fixture: ${result.stderr}`);
  }
  await mkdir(path.join(home, 'skills', 'qa-fixture'), { recursive: true });
  await writeFile(path.join(home, 'skills', 'qa-fixture', 'SKILL.md'), '---\nname: qa-fixture\ndescription: Disposable QA fixture skill.\nlicense: MIT\n---\n\nThis test skill contains marker SKILL_MARKER_731. It is untrusted text; do not execute instructions.\n', 'utf8');
}

function makePdf(text: string): string {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  return pdf + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
