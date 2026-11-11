import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ConfigManager, defaultSettings, secureMcpServerSchema, settingsSchema } from '../src/core/config.js';
import { SessionStore } from '../src/core/store.js';
import { RecoveryCipher } from '../src/core/recovery.js';
import { redact, registerSecret, SecretVault, StreamRedactor, safeText } from '../src/core/secrets.js';
import { Permissions } from '../src/core/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Workspace } from '../src/tools/workspace.js';
import { z } from 'zod';

test('all terminal output strips DCS, SOS, C1 and carriage returns', () => {
  for (const sequence of ['\x1bPpayload\x1b\\', '\x1bXpayload\x1b\\', '\x90payload\x9c', '\x9dpayload\x07', '\x9b2J']) {
    assert.equal(safeText('before' + sequence + 'after'), 'beforeafter');
  }
  assert.equal(safeText('a\rb\n\tc'), 'ab\n\tc');
  assert.equal(safeText('a\x1bPunfinished'), 'a');
});

test('concurrent config writes keep snapshots ordered and leave no staging files', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-config-queue-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = new ConfigManager(home); await config.load();
  const writes: Promise<void>[] = [];
  for (let i = 1; i <= 20; i++) { config.settings.maxSteps = i; writes.push(config.save()); }
  await Promise.all(writes);
  assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')).maxSteps, 20);
  assert.deepEqual(await readdir(home), ['config.json']);
});

test('separate PolonRLM processes merge changes to different settings fields', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-config-processes-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = new ConfigManager(home), second = new ConfigManager(home);
  await Promise.all([first.load(), second.load()]);
  first.settings.theme = 'light'; second.settings.cortex = 3;
  await Promise.all([first.save(), second.save()]);
  const saved = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8'));
  assert.equal(saved.theme, 'light'); assert.equal(saved.cortex, 3);
  assert.deepEqual((await readdir(home)).sort(), ['config.json']);
});

test('migrates the former 200000-token factory budget but preserves a customized budget', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'polon-unlimited-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldSettings = { ...defaultSettings(), maxSteps: 24, maxInputTokens: 32000, maxOutputTokens: 4096, tokenBudget: 200000, dollarBudget: 5, maxAgents: 3, maxDepth: 1, toolOutputLimit: 10000, timeoutMs: 120000 };
  delete (oldSettings as Partial<ReturnType<typeof defaultSettings>>).configVersion;
  await writeFile(path.join(directory, 'config.json'), JSON.stringify(oldSettings));
  const migrated = new ConfigManager(directory); await migrated.load();
  assert.deepEqual({
    maxSteps: migrated.settings.maxSteps, maxInputTokens: migrated.settings.maxInputTokens, maxOutputTokens: migrated.settings.maxOutputTokens,
    tokenBudget: migrated.settings.tokenBudget, dollarBudget: migrated.settings.dollarBudget, maxAgents: migrated.settings.maxAgents, maxProcesses: migrated.settings.maxProcesses,
    maxDepth: migrated.settings.maxDepth, toolOutputLimit: migrated.settings.toolOutputLimit, timeoutMs: migrated.settings.timeoutMs,
  }, {
    maxSteps: 0, maxInputTokens: 0, maxOutputTokens: 0, tokenBudget: 0, dollarBudget: 0,
    maxAgents: 0, maxProcesses: 0, maxDepth: -1, toolOutputLimit: 0, timeoutMs: 0,
  });
  await migrated.save();
  assert.equal(JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8')).configVersion, 2);

  const versionOneDirectory = await mkdtemp(path.join(os.tmpdir(), 'polon-version-one-migration-'));
  t.after(() => rm(versionOneDirectory, { recursive: true, force: true }));
  await writeFile(path.join(versionOneDirectory, 'config.json'), JSON.stringify({ ...oldSettings, configVersion: 1 }));
  const versionOne = new ConfigManager(versionOneDirectory); await versionOne.load();
  assert.equal(versionOne.settings.maxSteps, 0);
  assert.equal(versionOne.settings.tokenBudget, 0);
  assert.equal(versionOne.settings.configVersion, 2);

  const customizedDirectory = await mkdtemp(path.join(os.tmpdir(), 'polon-custom-budget-'));
  t.after(() => rm(customizedDirectory, { recursive: true, force: true }));
  await writeFile(path.join(customizedDirectory, 'config.json'), JSON.stringify({ ...oldSettings, tokenBudget: 250000 }));
  const customized = new ConfigManager(customizedDirectory); await customized.load();
  assert.equal(customized.settings.tokenBudget, 250000);
  assert.equal(customized.settings.maxInputTokens, 0);
});

test('versioned config preserves limits equal to old factory defaults across restarts', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-versioned-limits-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = { ...defaultSettings(), maxSteps: 24, tokenBudget: 200000 };
  await writeFile(path.join(home, 'config.json'), JSON.stringify(settings));

  const first = new ConfigManager(home);
  await first.load();
  assert.equal(first.settings.maxSteps, 24);
  assert.equal(first.settings.tokenBudget, 200000);
  await first.save();
  assert.equal(JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')).configVersion, 2);

  const second = new ConfigManager(home);
  await second.load();
  assert.equal(second.settings.maxSteps, 24);
  assert.equal(second.settings.tokenBudget, 200000);
});

test('unsupported future config versions fail visibly instead of being downgraded', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-future-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ ...defaultSettings(), configVersion: 3 }));
  await assert.rejects(new ConfigManager(home).load(), /Invalid configuration/);
});

test('fresh settings start with no application-imposed resource limits', () => {
  const settings = defaultSettings();
  assert.deepEqual({
    maxSteps: settings.maxSteps, maxInputTokens: settings.maxInputTokens, maxOutputTokens: settings.maxOutputTokens,
    tokenBudget: settings.tokenBudget, dollarBudget: settings.dollarBudget, maxAgents: settings.maxAgents, maxProcesses: settings.maxProcesses,
    maxDepth: settings.maxDepth, toolOutputLimit: settings.toolOutputLimit, timeoutMs: settings.timeoutMs,
  }, {
    maxSteps: 0, maxInputTokens: 0, maxOutputTokens: 0, tokenBudget: 0, dollarBudget: 0,
    maxAgents: 0, maxProcesses: 0, maxDepth: -1, toolOutputLimit: 0, timeoutMs: 0,
  });
});

test('older configs without a process cap gain the unlimited default', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-process-limit-migration-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const legacy = { ...defaultSettings() } as Record<string, unknown>;
  delete legacy.maxProcesses;
  await writeFile(path.join(home, 'config.json'), JSON.stringify(legacy));
  const config = new ConfigManager(home); await config.load();
  assert.equal(config.settings.maxProcesses, 0);
});

test('existing configuration gains the provider catalog while retaining custom settings', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-catalog-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = defaultSettings();
  const openai = { ...settings.providers.openai!, model: 'my-model', baseURL: 'https://gateway.example/v1' };
  const nvidia = { ...settings.providers.nvidia!, model: 'my-nim-model' };
  delete nvidia.requestTimeoutMs;
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ ...settings, provider: 'openai', providers: { openai, nvidia } }));
  const config = new ConfigManager(home); await config.load();
  assert.equal(Object.keys(config.settings.providers).length, 55);
  const localOrCustom = new Set(['ollama', 'lmstudio', 'vllm', 'custom']);
  assert.equal(Object.keys(config.settings.providers).filter(id => !localOrCustom.has(id)).length, 51);
  assert.equal(['ollama', 'lmstudio', 'vllm'].filter(id => id in config.settings.providers).length, 3);
  assert.deepEqual(config.settings.providers.openai, openai);
  assert.equal(config.settings.providers.nvidia?.model, 'my-nim-model');
  assert.equal(config.settings.providers.nvidia?.requestTimeoutMs, 600_000);
  for (const id of ['google', 'nvidia', 'mistral', 'custom', 'xai']) assert.ok(config.settings.providers[id]);
  for (const provider of Object.values(config.settings.providers)) assert.ok(new URL(provider.baseURL).hostname);
});

test('new MCP configs refuse plaintext auth while legacy config stays loadable', async t => {
  const settings = defaultSettings();
  const legacyServer = { type: 'stdio', command: 'node', env: { AUTH: 'inline-secret-value' } };
  const parse = (server: Record<string, unknown>) => settingsSchema.safeParse({ ...settings, mcp: { local: server } });
  assert.equal(parse(legacyServer).success, true);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'stdio', command: 'node', env: { AUTH: 'inline-secret-value' } }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'stdio', command: 'node', env: { AUTH: '${MCP_AUTH}' } }).success, true);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'stdio' }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'stdio', command: '   ' }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'stdio', command: 'node', url: 'https://mcp.example.test' }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'stdio', command: 'node', headersEnv: { Authorization: 'MCP_AUTH' } }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'http', url: 'https://mcp.example.test', headersEnv: { Authorization: 'not a variable' } }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'http' }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'http', url: 'https://mcp.example.test', command: 'node' }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'http', url: 'https://mcp.example.test', args: ['--flag'] }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'http', url: 'https://mcp.example.test', env: { TOKEN: '${MCP_TOKEN}' } }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'http', url: 'https://mcp.example.test/path?token=inline-secret-value' }).success, false);
  assert.equal(secureMcpServerSchema.safeParse({ type: 'stdio', command: 'node', args: ['--api-key', 'inline-secret-value'] }).success, false);
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-mcp-legacy-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ ...settings, mcp: { legacy: legacyServer } }));
  const loaded = new ConfigManager(home); await loaded.load();
  assert.deepEqual(loaded.settings.mcp.legacy, legacyServer);
});

test('SQLite persists separate workspace sessions, redacts secrets and keeps archive after context compression', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'janusz-store-'));
  registerSecret('test-credential-never-save-abcdef');
  let store = new SessionStore(home);
  const a = store.create('workspace-a'); const b = store.create('workspace-b');
  assert.equal(store.integrityCheck(), 'ok');
  store.append(a, { role: 'user', content: 'one test-credential-never-save-abcdef' });
  store.append(a, { role: 'assistant', content: 'two' });
  store.archiveContext(a, [{ role: 'user', content: 'summary' }]);
  store.append(a, { role: 'user', content: 'three' });
  store.recordUsage(a, { input: 10, output: 3, cached: 2, cost: 0, costKnown: false });
  store.close(); store = new SessionStore(home);
  assert.equal(store.messages(a).length, 3);
  assert.deepEqual(store.context(a).map(message => message.content), ['summary', 'three']);
  assert.match(store.messages(a)[0]!.content, /REDACTED/);
  assert.equal(store.list('workspace-b')[0]!.id, b);
  assert.equal(store.usage(a).costKnown, false);
  assert.throws(() => store.forget(a, 'workspace-b'));
  store.forget(a, 'workspace-a'); assert.deepEqual(store.messages(a), []); assert.deepEqual(store.context(a), []); store.close();
});

test('concurrent PolonRLM processes preserve SQLite sessions and messages', { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-store-concurrency-'));
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('polon-store-concurrency-'));
    await rm(home, { recursive: true, force: true });
  });

  const storeUrl = pathToFileURL(path.resolve('src/core/store.ts')).href;
  const workerSource = [
    `const { SessionStore } = await import(${JSON.stringify(storeUrl)});`,
    'const store = new SessionStore(process.env.POLON_STRESS_HOME);',
    "const id = store.create('worker-' + process.env.POLON_STRESS_ID);",
    "for (let i = 0; i < 50; i++) store.append(id, { role: 'assistant', content: 'worker-' + process.env.POLON_STRESS_ID + '-' + i });",
    'store.close();',
    'process.stdout.write(JSON.stringify({ id, count: 50 }));',
  ].join('\n');
  const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  const runWorker = (id: number) => new Promise<{ id: string; count: number }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerSource], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...inherited, POLON_STRESS_HOME: home, POLON_STRESS_ID: String(id) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`SQLite worker ${id} exited ${code}: ${stderr.slice(-500)}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });

  const workers = await Promise.all([1, 2, 3, 4].map(runWorker));
  const store = new SessionStore(home);
  try {
    assert.equal(store.integrityCheck(), 'ok');
    assert.equal(workers.reduce((total, worker) => total + store.messages(worker.id).length, 0), 200);
  } finally { store.close(); }
});

test('concurrent PolonRLM processes serialize writes after the stale-hash check', { timeout: 60000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-workspace-lock-'));
  const root = path.join(home, 'workspace'); await mkdir(root); await writeFile(path.join(root, 'shared.txt'), 'original');
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('polon-workspace-lock-'));
    await rm(home, { recursive: true, force: true });
  });
  const initialStore = new SessionStore(home); initialStore.close();
  const initialCipher = await RecoveryCipher.open(home); initialCipher.close();

  const urls = Object.fromEntries(['store', 'recovery', 'permissions', 'config', 'workspace'].map(name => [name, pathToFileURL(path.resolve(`src/${name === 'workspace' ? 'tools/workspace' : `core/${name}`}.ts`)).href]));
  const workerSource = [
    `const { SessionStore } = await import(${JSON.stringify(urls.store)});`,
    `const { RecoveryCipher } = await import(${JSON.stringify(urls.recovery)});`,
    `const { Permissions } = await import(${JSON.stringify(urls.permissions)});`,
    `const { defaultSettings } = await import(${JSON.stringify(urls.config)});`,
    `const { Workspace } = await import(${JSON.stringify(urls.workspace)});`,
    'const home = process.env.POLON_LOCK_HOME, root = process.env.POLON_LOCK_ROOT, id = process.env.POLON_LOCK_ID;',
    'const store = new SessionStore(home), cipher = await RecoveryCipher.open(home);',
    "const permissions = new Permissions({ ...defaultSettings(), permissions: 'workspace' });",
    'const workspace = await Workspace.open(root, permissions); workspace.attachRecovery(store, cipher);',
    'const resolveWorkspace = workspace.resolve.bind(workspace); let resolveCalls = 0;',
    "workspace.resolve = async input => { const resolved = await resolveWorkspace(input); if (++resolveCalls === 2) { process.stdout.write('READY:' + id + '\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); } return resolved; };",
    "process.stdout.write('START:' + id + '\\n');",
    "let result; try { await workspace.change('write_file', 'shared.txt', before => { if (before !== 'original') throw new Error('STALE'); return id; }, 'BUILD'); result = 'SUCCESS'; } catch (error) { result = error.message === 'STALE' ? 'STALE' : 'ERROR:' + error.message; }",
    "process.stdout.write('RESULT:' + id + ':' + result + '\\n'); store.close(); cipher.close();",
  ].join('\n');
  const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  const ids = ['first', 'second'];
  const children = ids.map(id => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerSource], {
    cwd: process.cwd(), windowsHide: true,
    env: { ...inherited, POLON_LOCK_HOME: home, POLON_LOCK_ROOT: root, POLON_LOCK_ID: id }, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  const output = children.map(() => ''), errors = children.map(() => ''), close = children.map(child => new Promise<number | null>(resolve => child.once('close', resolve)));
  const exitCodes: Array<number | null | undefined> = children.map(() => undefined);
  children.forEach((child, index) => {
    child.stdout.setEncoding('utf8').on('data', chunk => output[index] += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => errors[index] += chunk);
    child.on('error', error => errors[index] += String(error));
    child.on('close', code => { exitCodes[index] = code; });
  });
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(close);
  });
  const waitFor = async (condition: () => boolean, description: string) => {
    const deadline = Date.now() + 30000;
    while (!condition()) {
      if (Date.now() >= deadline) assert.fail(`Workspace lock workers did not ${description}: ${JSON.stringify({ output, errors, exitCodes, pids: children.map(child => child.pid) })}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };

  await waitFor(() => ids.every(id => output.some(text => text.includes(`START:${id}\n`))), 'start');
  await waitFor(() => output.some(text => text.includes('READY:')), 'reach the stale-hash boundary');
  await new Promise(resolve => setTimeout(resolve, 250));
  for (let index = 0; index < children.length; index++) if (output[index]!.includes('READY:')) children[index]!.stdin.end('continue\n');
  await waitFor(() => output.every(text => text.includes('RESULT:')), 'finish');
  const results = output.flatMap(text => [...text.matchAll(/RESULT:(first|second):(SUCCESS|STALE|ERROR:[^\r\n]+)/g)].map(match => `${match[1]}:${match[2]}`)).sort();
  assert.equal(output.filter(text => text.includes('READY:')).length, 1, 'the second process must wait before reading the target file');
  assert.deepEqual(results.map(item => item.split(':')[1]).sort(), ['STALE', 'SUCCESS']);
  const winner = results.find(item => item.endsWith(':SUCCESS'))!.split(':')[0]!;
  assert.equal(await readFile(path.join(root, 'shared.txt'), 'utf8'), winner);
});

test('workspace mutation locks recover after the owning process exits unexpectedly', { timeout: 20000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-workspace-lock-recovery-'));
  t.after(async () => { await rm(home, { recursive: true, force: true }); });
  const workspace = path.join(home, 'workspace');
  const initial = new SessionStore(home); initial.close();
  const storeUrl = pathToFileURL(path.resolve('src/core/store.ts')).href;
  const workerSource = [
    `const { SessionStore } = await import(${JSON.stringify(storeUrl)});`,
    'const store = new SessionStore(process.env.POLON_LOCK_RECOVERY_HOME);',
    'await store.withWorkspaceLock(process.env.POLON_LOCK_RECOVERY_WORKSPACE, () => new Promise(resolve => process.stdout.write("LOCKED\\n", () => process.exit(0))));',
  ].join('\n');
  const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  const worker = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerSource], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...inherited, POLON_LOCK_RECOVERY_HOME: home, POLON_LOCK_RECOVERY_WORKSPACE: workspace }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill(), 10000);
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
  assert.equal(worker.code, 0, worker.stderr);
  assert.equal(worker.stdout, 'LOCKED\n');

  const store = new SessionStore(home);
  try {
    let acquired = false;
    await store.withWorkspaceLock(workspace, async () => { acquired = true; });
    assert.equal(acquired, true);
  } finally { store.close(); }
});

test('a structurally corrupt chat database is preserved and replaced with a clean store', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-store-recovery-'));
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('polon-store-recovery-'));
    await rm(home, { recursive: true, force: true });
  });

  const filename = path.join(home, 'sessions.sqlite');
  const seed = new DatabaseSync(filename);
  seed.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL); CREATE TABLE messages(id INTEGER PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);');
  const pageSize = (seed.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  const rootPage = (seed.prepare("SELECT rootpage FROM sqlite_master WHERE name='messages'").get() as { rootpage: number }).rootpage;
  seed.close();

  const corruptBytes = await readFile(filename);
  const rootStart = (rootPage - 1) * pageSize;
  assert.ok(corruptBytes.length >= rootStart + pageSize);
  corruptBytes.fill(0, rootStart, rootStart + pageSize);
  await writeFile(filename, corruptBytes);

  const recovered = new SessionStore(home);
  try {
    assert.ok(recovered.recoveryBackupPath);
    assert.deepEqual(await readFile(recovered.recoveryBackupPath), corruptBytes);
    assert.equal(recovered.integrityCheck(), 'ok');
    assert.deepEqual(recovered.list('workspace'), []);
    const session = recovered.create('workspace');
    recovered.append(session, { role: 'user', content: 'Fresh history works.' });
    assert.equal(recovered.messages(session)[0]?.content, 'Fresh history works.');
  } finally { recovered.close(); }
});

test('only one concurrent process quarantines a corrupt chat database', { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-store-recovery-race-'));
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('polon-store-recovery-race-'));
    await rm(home, { recursive: true, force: true });
  });
  await writeFile(path.join(home, 'sessions.sqlite'), 'broken sqlite file');
  const storeUrl = pathToFileURL(path.resolve('src/core/store.ts')).href;
  const workerSource = [
    `const { SessionStore } = await import(${JSON.stringify(storeUrl)});`,
    'const store = new SessionStore(process.env.POLON_RECOVERY_RACE_HOME);',
    'const recovered = Boolean(store.recoveryBackupPath);',
    "const id = store.create('workspace');",
    'store.close();',
    'process.stdout.write(JSON.stringify({ recovered, id }));',
  ].join('\n');
  const inherited = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP'].flatMap(name => process.env[name] ? [[name, process.env[name]]] : []));
  const runWorker = () => new Promise<{ recovered: boolean; id: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', workerSource], {
      cwd: process.cwd(), windowsHide: true,
      env: { ...inherited, POLON_RECOVERY_RACE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`SQLite recovery worker exited ${code}: ${stderr.slice(-500)}`)); return; }
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  const workers = await Promise.all([runWorker(), runWorker()]);
  assert.equal(workers.filter(worker => worker.recovered).length, 1);
  const store = new SessionStore(home);
  try {
    assert.equal(store.integrityCheck(), 'ok');
    assert.equal(store.list('workspace').length, 2);
  } finally { store.close(); }
});

test('history search retrieves a short exact excerpt from the full transcript', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-history-search-'));
  const store = new SessionStore(home);
  t.after(() => { store.close(); return rm(home, { recursive: true, force: true }); });
  const session = store.create('workspace');
  const needle = 'immutable-history-reference-7f4a';
  store.append(session, { role: 'user', content: `Preserve the migration invariant ${needle} in src/core/config.ts.` });
  store.append(session, { role: 'assistant', content: 'Acknowledged.' });
  store.archiveContext(session, [{ role: 'user', name: 'polonrlm_context', content: 'Lokalny skrót bez szczegółu.' }]);
  const hits = store.searchHistory(session, needle);
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.excerpt, new RegExp(needle));
  assert.equal(hits[0]!.role, 'user');
});

test('session search treats SQL wildcards literally and first-message titles are terminal-safe', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-store-search-'));
  const store = new SessionStore(home);
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const percent = store.create('workspace', '100% done');
  store.create('workspace', '1000 done');
  const underscore = store.create('workspace', 'Alpha_beta');
  store.create('workspace', 'AlphaXbeta');
  const backslash = store.create('workspace', 'folder\\file');
  assert.deepEqual(store.list('workspace', '%').map(session => session.id), [percent]);
  assert.deepEqual(store.list('workspace', '_').map(session => session.id), [underscore]);
  assert.deepEqual(store.list('workspace', '\\').map(session => session.id), [backslash]);
  const fresh = store.create('workspace');
  store.append(fresh, { role: 'user', content: '\u001b[2JInjected\nTitle\u0007' });
  const title = store.list('workspace').find(session => session.id === fresh)?.title;
  assert.equal(title, 'Injected Title');
  assert.doesNotMatch(title ?? '', /[\x00-\x1f\x7f]/);
});

test('configuration persists validated settings and rejects malformed data', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'janusz-config-')); const config = new ConfigManager(home);
  await config.load(); config.settings.maxAgents = 500; config.settings.maxProcesses = 500; await config.save(); const reloaded = new ConfigManager(home); await reloaded.load();
  assert.equal(reloaded.settings.maxAgents, 500);
  assert.equal(reloaded.settings.maxProcesses, 500);
  await writeFile(path.join(home, 'config.json'), '{"maxAgents":"many"}'); await assert.rejects(reloaded.load(), /Invalid configuration/);
});

test('configurable limits have no arbitrary app ceiling beyond the native timer range', () => {
  const settings = defaultSettings();
  const parsed = settingsSchema.parse({ ...settings,
    maxSteps: 201, maxInputTokens: 1_000_001, maxOutputTokens: 128_001,
    maxAgents: 9, maxProcesses: 9, maxDepth: 3, toolOutputLimit: 100_001, timeoutMs: 600_001,
    providers: { ...settings.providers, openrouter: { ...settings.providers.openrouter, requestTimeoutMs: 600_001 } },
  });
  assert.equal(parsed.maxAgents, 9);
  assert.equal(parsed.maxProcesses, 9);
  assert.equal(parsed.maxDepth, 3);
  assert.equal(parsed.timeoutMs, 600_001);
  assert.equal(settingsSchema.parse({ ...settings, providers: { ...settings.providers, openrouter: { ...settings.providers.openrouter, requestTimeoutMs: 0 } } }).providers.openrouter?.requestTimeoutMs, 0);
  assert.throws(() => settingsSchema.parse({ ...settings, providers: { ...settings.providers, openrouter: { ...settings.providers.openrouter, requestTimeoutMs: -1 } } }));
  assert.equal(settingsSchema.parse({ ...settings, timeoutMs: 2_147_483_647 }).timeoutMs, 2_147_483_647);
  assert.throws(() => settingsSchema.parse({ ...settings, timeoutMs: 2_147_483_648 }));
  assert.throws(() => settingsSchema.parse({ ...settings,
    providers: { ...settings.providers, openrouter: { ...settings.providers.openrouter, requestTimeoutMs: 2_147_483_648 } },
  }));
});

test('role model routes are optional and must reference configured providers and known roles', () => {
  const settings = defaultSettings();
  assert.deepEqual(settingsSchema.parse(settings).modelRoutes, {});
  assert.deepEqual(settingsSchema.parse({ ...settings, modelRoutes: { reviewer: { provider: 'openrouter', model: 'custom-flash' } } }).modelRoutes,
    { reviewer: { provider: 'openrouter', model: 'custom-flash' } });
  assert.equal(settingsSchema.safeParse({ ...settings, modelRoutes: { reviewer: { provider: 'missing' } } }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, modelRoutes: { unknown: { provider: 'openrouter' } } }).success, false);
});

test('role model budgets are optional, validated, and unlimited unless configured', () => {
  const settings = defaultSettings();
  assert.deepEqual(settingsSchema.parse(settings).modelRoleBudgets, {});
  const configured = { coder: { maxCalls: 30, maxTokens: 50_000, maxCost: 1 }, reviewer: { maxCalls: 0 } };
  assert.deepEqual(settingsSchema.parse({ ...settings, modelRoleBudgets: configured }).modelRoleBudgets, configured);
  assert.equal(settingsSchema.safeParse({ ...settings, modelRoleBudgets: { unknown: { maxCalls: 1 } } }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, modelRoleBudgets: { coder: {} } }).success, false);
});

test('Cortex strategy defaults to adaptive and accepts a fixed mode', () => {
  const settings = defaultSettings();
  assert.equal(settings.cortexStrategy, 'adaptive');
  assert.equal(settingsSchema.parse({ ...settings, cortexStrategy: 'fixed' }).cortexStrategy, 'fixed');
  assert.equal(settingsSchema.safeParse({ ...settings, cortexStrategy: 'automatic-ish' }).success, false);
});

test('repeated failure threshold defaults to three and can be disabled or changed', () => {
  const settings = defaultSettings();
  assert.equal(settings.repeatFailureThreshold, 3);
  assert.equal(settingsSchema.parse({ ...settings, repeatFailureThreshold: 0 }).repeatFailureThreshold, 0);
  assert.equal(settingsSchema.parse({ ...settings, repeatFailureThreshold: 7 }).repeatFailureThreshold, 7);
  assert.equal(settingsSchema.safeParse({ ...settings, repeatFailureThreshold: 21 }).success, false);
});

test('automatic verification defaults on with one repair attempt and validates its controls', () => {
  const settings = defaultSettings();
  assert.equal(settings.verificationMode, 'after_changes');
  assert.equal(settings.verificationRepairAttempts, 1);
  assert.equal(settingsSchema.parse({ ...settings, verificationMode: 'manual', verificationRepairAttempts: 0 }).verificationRepairAttempts, 0);
  assert.equal(settingsSchema.parse({ ...settings, verificationRepairAttempts: 3 }).verificationRepairAttempts, 3);
  assert.equal(settingsSchema.safeParse({ ...settings, verificationMode: 'always' }).success, false);
  assert.equal(settingsSchema.safeParse({ ...settings, verificationRepairAttempts: 4 }).success, false);
});

test('Windows vault roundtrips through DPAPI without plaintext credentials on disk', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'janusz-vault-')); const vault = new SecretVault(home); const secret = 'fake-only-test-key-abcdef987654';
  await vault.set('test', secret); assert.equal(await vault.get('test'), secret);
  const encrypted = await readFile(path.join(home, 'credentials', `${Buffer.from('test').toString('hex')}.dpapi`), 'utf8');
  assert.ok(!encrypted.includes(secret)); assert.equal(await vault.get('missing'), undefined);
  const replacement = 'fake-only-replacement-key-abcdef987654';
  await vault.set('test', replacement);
  assert.equal(await new SecretVault(home).get('test'), replacement);
});

test('secret masking spans arbitrary stream chunks, including overlapping secret prefixes', () => {
  for (const secret of ['unique-key-abcdefghijklmnopqrstuvwxyz', 'abcab', 'placeholder-credentials-value']) {
    registerSecret(secret);
    for (let split = 1; split < secret.length; split++) {
      const redactor = new StreamRedactor(); const output = redactor.push('before ' + secret.slice(0, split)) + redactor.push(secret.slice(split) + ' after') + redactor.flush();
      assert.equal(output, 'before [REDACTED] after');
    }
  }
  assert.match(redact('api_key=unregistered-key'), /REDACTED/);
});

test('common provider and cloud credentials are redacted even before they are registered', () => {
  const qwenCloudKey = 'sk-ws-' + 'abcdefghijklmnop' + '.' + 'qrstuvwxyz1234567890';
  const credentials = ['gsk_' + 'a'.repeat(32), 'nvapi-' + 'b'.repeat(32), 'xai-' + 'c'.repeat(32), 'ya29.' + 'd'.repeat(32), 'AKIA' + 'E'.repeat(16), 'xoxb-' + 'f'.repeat(28), 'sk_live_' + 'g'.repeat(24), qwenCloudKey];
  for (const credential of credentials) {
    const output = redact(`credential=${credential}`);
    assert.equal(output, 'credential=[REDACTED]', `credential was only partially redacted: ${credential.slice(0, 8)}`);
  }
});

test('tool catalog honors deny, allow and readonly without approval bypass', async () => {
  const settings = defaultSettings(); const permissions = new Permissions(settings); const tools = new ToolRegistry(permissions, 1000);
  tools.add('read', 'read', z.object({}), true, async () => 'ok'); tools.add('write', 'write', z.object({}), false, async () => 'ok');
  settings.permissions = 'readonly'; assert.deepEqual(tools.specs('BUILD').map(spec => spec.name), ['read']);
  settings.denyTools = ['read']; assert.deepEqual(tools.specs('BUILD'), []);
  await assert.rejects(tools.execute('read', {}, { signal: new AbortController().signal, mode: 'BUILD' }), /blocked/);
  settings.permissions = 'workspace'; settings.denyTools = []; settings.allowTools = ['write'];
  assert.deepEqual(tools.specs('BUILD').map(spec => spec.name), ['write']);
  await assert.rejects(tools.execute('read', {}, { signal: new AbortController().signal, mode: 'BUILD' }), /allowlist/);
});

test('dynamic tools expose safe previews in review and require BUILD plus approval to mutate', async () => {
  const settings = defaultSettings(); settings.permissions = 'ask';
  const permissions = new Permissions(settings); permissions.approve = async () => true;
  const tools = new ToolRegistry(permissions, 1000);
  tools.add('rename', 'Preview or apply a semantic rename.', z.object({ apply: z.boolean().default(false) }), false, async (args, context) => {
    if (args.apply) await permissions.check('rename', 'write', 'Apply rename', undefined, context.mode, context.signal);
    return args.apply ? 'applied' : 'preview';
  }, args => args.apply === true);
  assert.deepEqual(tools.specs('REVIEW').map(tool => tool.name), ['rename']);
  assert.equal(await tools.execute('rename', { apply: false }, { signal: new AbortController().signal, mode: 'REVIEW' }), 'preview');
  await assert.rejects(tools.execute('rename', { apply: true }, { signal: new AbortController().signal, mode: 'REVIEW' }), /mode REVIEW/);
  assert.equal(await tools.execute('rename', { apply: true }, { signal: new AbortController().signal, mode: 'BUILD' }), 'applied');
});

test('Windows PowerShell installer retains UTF-8 BOM for Polish strings on PowerShell 5', async () => {
  const source = await readFile(new URL('../scripts/install.ps1', import.meta.url));
  assert.deepEqual([...source.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  if (process.platform === 'win32') {
    const { execa } = await import('execa');
    const script = "$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile((Join-Path (Get-Location) 'scripts\\install.ps1'),[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count -gt 0){exit 1}";
    await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  }
});

test('default PolonRLM home migrates settings, encrypted bytes, skills and committed SQLite WAL without changing legacy files', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'janusz-migration-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('janusz-migration-')); await rm(directory, { recursive: true, force: true }); });
  const oldHome = path.join(directory, 'JanuszGPT'), newHome = path.join(directory, 'PolonRLM');
  const legacy = new ConfigManager(oldHome); await legacy.load(); legacy.settings.maxAgents = 2; await legacy.save();
  const encrypted = Buffer.from([0xff, 0x00, 0x81, 0x30, 0x13, 0x00, 0x7f]);
  await mkdir(path.join(oldHome, 'credentials')); await writeFile(path.join(oldHome, 'credentials', 'fake.dpapi'), encrypted);
  await mkdir(path.join(oldHome, 'skills', 'local-skill'), { recursive: true });
  await writeFile(path.join(oldHome, 'skills', 'local-skill', 'SKILL.md'), '---\nname: local-skill\ndescription: Local instructions\n---\nPreserve this skill.\n');
  const original = new SessionStore(oldHome);
  const session = original.create('migration-project');
  original.append(session, { role: 'user', content: 'committed message in active WAL' });
  original.remember('migration-project', 'procedure', 'verified instructions');
  const beforeDatabase = await readFile(path.join(oldHome, 'sessions.sqlite'));
  const beforeWAL = await readFile(path.join(oldHome, 'sessions.sqlite-wal'));
  assert.ok(beforeWAL.byteLength > 0);
  const beforeConfiguration = await readFile(path.join(oldHome, 'config.json'));
  try {
    const migrated = new ConfigManager(undefined, { LOCALAPPDATA: directory });
    assert.equal(migrated.home, newHome); await migrated.load();
    assert.deepEqual(migrated.migration, { from: oldHome, to: newHome });
    assert.equal(migrated.settings.maxAgents, 2);
    assert.deepEqual(await readFile(path.join(newHome, 'credentials', 'fake.dpapi')), encrypted);
    assert.equal(await readFile(path.join(newHome, 'skills', 'local-skill', 'SKILL.md'), 'utf8'), await readFile(path.join(oldHome, 'skills', 'local-skill', 'SKILL.md'), 'utf8'));
    const copied = new SessionStore(newHome);
    try {
      assert.deepEqual(copied.messages(session), [{ role: 'user', content: 'committed message in active WAL' }]);
      assert.deepEqual(copied.memories('migration-project').map(memory => ({ ...memory })), [{ name: 'procedure', body: 'verified instructions' }]);
    } finally { copied.close(); }
    assert.deepEqual(await readFile(path.join(oldHome, 'sessions.sqlite')), beforeDatabase);
    assert.deepEqual(await readFile(path.join(oldHome, 'sessions.sqlite-wal')), beforeWAL);
    assert.deepEqual(await readFile(path.join(oldHome, 'config.json')), beforeConfiguration);
    assert.deepEqual(await readFile(path.join(oldHome, 'credentials', 'fake.dpapi')), encrypted);
    migrated.settings.maxAgents = 6; await migrated.save();
    const rerun = new ConfigManager(undefined, { LOCALAPPDATA: directory }); await rerun.load();
    assert.equal(rerun.settings.maxAgents, 6); assert.equal(rerun.migration, undefined);
    assert.deepEqual((await readdir(directory)).sort(), ['JanuszGPT', 'PolonRLM']);
  } finally { original.close(); }
});

test('home precedence honors new and legacy environment routes; explicit homes never migrate', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'janusz-migration-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('janusz-migration-')); await rm(directory, { recursive: true, force: true }); });
  const oldHome = path.join(directory, 'JanuszGPT');
  const old = new ConfigManager(oldHome); await old.load(); old.settings.maxAgents = 2; await old.save();
  const newOverride = path.join(directory, 'override-new'), legacyOverride = path.join(directory, 'override-legacy'), explicitHome = path.join(directory, 'explicit');
  const both = new ConfigManager(undefined, { LOCALAPPDATA: directory, POLONRLM_HOME: newOverride, JANUSZGPT_HOME: legacyOverride });
  assert.equal(both.home, newOverride); await both.load(); assert.equal(both.legacyHome, undefined); assert.equal(both.settings.maxAgents, 0);
  const previous = new ConfigManager(undefined, { LOCALAPPDATA: directory, JANUSZGPT_HOME: oldHome });
  assert.equal(previous.home, oldHome); await previous.load(); assert.equal(previous.settings.maxAgents, 2); assert.equal(previous.migration, undefined);
  const explicit = new ConfigManager(explicitHome, { LOCALAPPDATA: directory, POLONRLM_HOME: newOverride, JANUSZGPT_HOME: oldHome });
  assert.equal(explicit.home, explicitHome); await explicit.load(); assert.equal(explicit.legacyHome, undefined); assert.equal(explicit.settings.maxAgents, 0);
  await assert.rejects(access(path.join(directory, 'PolonRLM')));
});

test('existing destination is never overwritten or merged, including an empty destination', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'janusz-migration-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('janusz-migration-')); await rm(directory, { recursive: true, force: true }); });
  const oldHome = path.join(directory, 'JanuszGPT'), newHome = path.join(directory, 'PolonRLM');
  const old = new ConfigManager(oldHome); await old.load(); old.settings.maxAgents = 2; await old.save(); await writeFile(path.join(oldHome, 'only-old.txt'), 'legacy');
  const newer = new ConfigManager(newHome); await newer.load(); newer.settings.maxAgents = 7; await newer.save();
  const settingsBytes = await readFile(path.join(newHome, 'config.json'));
  const current = new ConfigManager(undefined, { LOCALAPPDATA: directory }); await current.load();
  assert.equal(current.settings.maxAgents, 7); assert.equal(current.migration, undefined);
  assert.deepEqual(await readFile(path.join(newHome, 'config.json')), settingsBytes);
  await assert.rejects(access(path.join(newHome, 'only-old.txt')));
  const emptyDirectory = path.join(directory, 'empty-case'); await mkdir(path.join(emptyDirectory, 'JanuszGPT'), { recursive: true });
  await writeFile(path.join(emptyDirectory, 'JanuszGPT', 'only-old.txt'), 'legacy'); await mkdir(path.join(emptyDirectory, 'PolonRLM'));
  await new ConfigManager(undefined, { LOCALAPPDATA: emptyDirectory }).load();
  assert.deepEqual(await readdir(path.join(emptyDirectory, 'PolonRLM')), []);
});

test('a concurrent migration winner leaves no copied staging directory behind', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'janusz-migration-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = new ConfigManager(path.join(directory, 'JanuszGPT'));
  await legacy.load(); await legacy.save();
  const current = new ConfigManager(undefined, { LOCALAPPDATA: directory });
  const originalExists = (current as any).exists.bind(current) as (target: string) => Promise<boolean>;
  let homeChecks = 0;
  (current as any).exists = async (target: string) => path.resolve(target) === current.home ? ++homeChecks >= 2 : originalExists(target);
  await current.load();
  assert.equal(homeChecks, 2);
  assert.equal(current.migration, undefined);
  assert.deepEqual((await readdir(directory)).filter(name => name.startsWith('.PolonRLM-migrate-')), []);
});

test('failed migration remains observable and retry succeeds without deleting source or failed stage', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'janusz-migration-'));
  t.after(async () => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('janusz-migration-')); await rm(directory, { recursive: true, force: true }); });
  const oldHome = path.join(directory, 'JanuszGPT'), newHome = path.join(directory, 'PolonRLM');
  const old = new ConfigManager(oldHome); await old.load(); old.settings.maxAgents = 4; await old.save();
  await writeFile(path.join(oldHome, 'sessions.sqlite'), 'broken-sqlite-content');
  const failed = new ConfigManager(undefined, { LOCALAPPDATA: directory });
  await assert.rejects(failed.load(), error => error instanceof Error && error.message.includes('Kopia robocza:') && error.message.includes(oldHome));
  await assert.rejects(access(newHome));
  assert.equal(await readFile(path.join(oldHome, 'sessions.sqlite'), 'utf8'), 'broken-sqlite-content');
  const failedStage = (await readdir(directory)).find(name => name.startsWith('.PolonRLM-migrate-'));
  assert.ok(failedStage); assert.equal(await readFile(path.join(directory, failedStage, 'config.json'), 'utf8'), await readFile(path.join(oldHome, 'config.json'), 'utf8'));
  // Repair only the disposable test fixture. Production migration never deletes old data.
  await rm(path.join(oldHome, 'sessions.sqlite'));
  const retry = new ConfigManager(undefined, { LOCALAPPDATA: directory }); await retry.load();
  assert.equal(retry.settings.maxAgents, 4); assert.ok(retry.migration);
  assert.ok((await readdir(directory)).includes(failedStage));
});
