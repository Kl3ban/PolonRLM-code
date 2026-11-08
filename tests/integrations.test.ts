import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SkillsManager } from '../src/integrations/skills.js';
import { MCPManager, mcpConfigPreview } from '../src/integrations/mcp.js';
import { createTestMCPServer } from './fixtures/mcp-server.js';

async function temporary(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'polonrlm-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

test('MCP config previews redact raw env values, URL credentials and secret arguments', () => {
  const secret = 'mcp-preview-secret-12345';
  const preview = mcpConfigPreview({ type: 'stdio', command: 'node', args: ['--api-key', secret, '--header', `Authorization: Bearer ${secret}`], env: { AUTH: secret, LOG_LEVEL: 'debug' }, url: `https://user:${secret}@mcp.example.test/path?token=${secret}#fragment` });
  const text = JSON.stringify(preview);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('debug'), false);
  assert.deepEqual(preview.args, ['--api-key', '[REDACTED]', '--header', 'Authorization:[REDACTED]']);
  assert.deepEqual(preview.env, { AUTH: '[REDACTED]', LOG_LEVEL: '[REDACTED]' });
  assert.equal(preview.url, 'https://mcp.example.test/path');
});

test('MCP refuses a legacy plaintext secret before starting its process', async () => {
  const manager = new MCPManager({ legacy: { type: 'stdio', command: 'node', args: ['--api-key', 'mcp-inline-secret-12345'], env: { AUTH: 'mcp-inline-secret-12345' }, timeoutMs: 100 } });
  await assert.rejects(manager.connect('legacy'), /Unsafe MCP configuration/);
  await manager.close();
});

async function sourceSkill(root: string, name: string, license = true): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Diagnose regression failures and verify focused tests.\n${license ? 'license: MIT\n' : ''}---\n\nRead evidence before changing code.\n`);
  return directory;
}

test('skills create, disable, enable, task match, load and remove persist', async t => {
  const root = await temporary(t);
  const manager = new SkillsManager(join(root, 'home'), join(root, 'workspace'));
  await manager.create('regression-tests', 'Diagnose regression failures and verify focused tests.', 'Inspect actual failures. Run focused tests.');
  assert.match(await manager.load('regression-tests'), /Inspect actual failures/);
  assert.ok((await manager.match('Diagnose regression failures')).includes('regression-tests'));
  await manager.enable('regression-tests', false);
  await assert.rejects(manager.load('regression-tests'), /disabled/);
  const restored = new SkillsManager(join(root, 'home'), join(root, 'workspace'));
  assert.equal((await restored.list()).find(skill => skill.name === 'regression-tests')?.enabled, false);
  await restored.enable('regression-tests', true);
  assert.match(await restored.load('regression-tests'), /trust="untrusted-task-data"/);
  await restored.remove('regression-tests');
  assert.equal((await restored.list()).some(skill => skill.name === 'regression-tests'), false);
  await assert.rejects(restored.create('../escape', 'description', 'body'));
});

test('corrupt skill registry degrades safely, keeps installed skills disabled, and can be repaired', async t => {
  const root = await temporary(t);
  const home = join(root, 'home'), workspace = join(root, 'workspace');
  const manager = new SkillsManager(home, workspace);
  const directory = await sourceSkill(join(home, 'skills'), 'orphaned-helper');
  const registry = join(home, 'skills', '.registry.json');
  await writeFile(registry, '{broken json');

  const listed = await manager.list();
  assert.equal(listed.find(skill => skill.name === 'orphaned-helper')?.enabled, false);
  assert.match(manager.warnings().join('\n'), /Rejestr/);
  assert.equal((await manager.match('diagnose regression failures')).includes('orphaned-helper'), false);
  await assert.rejects(manager.remove('orphaned-helper'), /registry|rejestr/i);
  assert.match(await readFile(join(directory, 'SKILL.md'), 'utf8'), /orphaned-helper/);
  await assert.rejects(manager.enable('orphaned-helper'), /repair/);

  assert.match(await manager.repairRegistry(), /remain disabled/);
  assert.equal((await manager.list()).find(skill => skill.name === 'orphaned-helper')?.enabled, false);
  await manager.enable('orphaned-helper');
  assert.match(await manager.load('orphaned-helper'), /Read evidence/);
});

test('one invalid optional project skill does not prevent other skills from matching', async t => {
  const root = await temporary(t);
  const manager = new SkillsManager(join(root, 'home'), join(root, 'workspace'));
  await manager.create('healthy-helper', 'Diagnose regression failures and verify focused tests.', 'Use focused evidence.');
  const invalid = join(root, 'workspace', '.agents', 'skills', 'broken-helper');
  await mkdir(invalid, { recursive: true }); await writeFile(join(invalid, 'SKILL.md'), 'invalid metadata');
  assert.ok((await manager.match('diagnose regression failures')).includes('healthy-helper'));
  assert.match(manager.warnings().join('\n'), /broken-helper/);
});

test('GitHub skill source accepts the repository root but still rejects paths outside it', async t => {
  const root = await temporary(t);
  const manager = new SkillsManager(join(root, 'home'), join(root, 'workspace'));
  const within = (manager as any).within.bind(manager) as (base: string, target: string, allowEqual?: boolean) => boolean;
  assert.equal(within(root, root, true), true);
  assert.equal(within(root, join(root, 'skill')), true);
  assert.equal(within(root, join(root, '..', 'outside'), true), false);
});

test('local skill installation audits code, defaults disabled, updates and never runs scripts', async t => {
  const root = await temporary(t);
  const source = await sourceSkill(join(root, 'source'), 'diagnostic-helper');
  await mkdir(join(source, 'scripts'));
  const sentinel = join(root, 'script-executed');
  await writeFile(join(source, 'scripts', 'danger.mjs'), `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(sentinel)},'executed')`);
  const manager = new SkillsManager(join(root, 'home'), join(root, 'workspace'));
  assert.match(await manager.install(source), /scripts[\\/]danger\.mjs/);
  await assert.rejects(readFile(sentinel), { code: 'ENOENT' });
  await assert.rejects(manager.load('diagnostic-helper'), /disabled/);
  await manager.enable('diagnostic-helper');
  await writeFile(join(source, 'SKILL.md'), '---\nname: diagnostic-helper\ndescription: Diagnose regression failures.\nlicense: MIT\n---\n\nUpdated instructions.\n');
  assert.match(await manager.update('diagnostic-helper'), /Updated/);
  assert.match(await manager.load('diagnostic-helper'), /Updated instructions/);
  assert.equal((await manager.list()).find(skill => skill.name === 'diagnostic-helper')?.source, await realpath(source));
  await manager.remove('diagnostic-helper');
  assert.match(await readFile(join(source, 'SKILL.md'), 'utf8'), /Updated instructions/);
});

test('skill installation rejects missing license, symlinks and invalid YAML', async t => {
  const root = await temporary(t);
  const manager = new SkillsManager(join(root, 'home'), join(root, 'workspace'));
  const unlicensed = await sourceSkill(root, 'unlicensed', false);
  await assert.rejects(manager.install(unlicensed), /license/);
  const linked = await sourceSkill(root, 'linked-skill');
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(linked, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.install(linked), /symbolic link/);
  await unlink(join(linked, 'escape'));
  const invalid = await sourceSkill(root, 'bad-yaml');
  await writeFile(join(invalid, 'SKILL.md'), '---\nname: bad-yaml\nname: duplicate\ndescription: Test\nlicense: MIT\n---\nBody');
  await assert.rejects(manager.install(invalid), /YAML/);
});

test('MCP stdio performs real handshake, validates input, calls tools, cancels and disconnects', { timeout: 20_000 }, async t => {
  const fixture = fileURLToPath(new URL('./fixtures/mcp-server.ts', import.meta.url));
  const manager = new MCPManager({ local: { type: 'stdio', command: process.execPath, args: ['--import', 'tsx', fixture, '--stdio'], timeoutMs: 5_000 } });
  t.after(() => manager.close());
  assert.deepEqual(manager.tools(), []);
  const tools = await manager.connect('local');
  assert.equal(tools.length, 3);
  assert.ok(tools.some(tool => tool.name === 'mcp_local_sum'));
  assert.deepEqual(await manager.connect('local'), tools);
  assert.match(await manager.call('mcp_local_sum', { a: 20, b: 22 }), /42/);
  await assert.rejects(manager.call('mcp_local_sum', { a: '20', b: 22 }), /Invalid MCP arguments/);
  assert.equal(JSON.parse(await manager.call('mcp_local_failure', {})).isError, true);
  await assert.rejects(manager.call('mcp_local_slow', { milliseconds: 5_000 }, AbortSignal.timeout(30)), /abort|cancel|timeout/i);
  await manager.disconnect('local');
  assert.deepEqual(manager.tools(), []);
  await assert.rejects(manager.call('mcp_local_sum', { a: 1, b: 2 }), /Unknown MCP tool/);
});

test('MCP Streamable HTTP supports environment headers, errors and reconnect', { timeout: 20_000 }, async t => {
  const variable = `POLONRLM_MCP_TEST_${process.pid}`;
  process.env[variable] = 'Bearer secret-value-for-local-test';
  t.after(() => { delete process.env[variable]; });
  let requests = 0;
  const active = new Set<ReturnType<typeof createTestMCPServer>>();
  const http = createServer(async (request, response) => {
    if (request.headers.authorization !== process.env[variable]) {
      response.writeHead(401, { 'content-type': 'text/plain' }).end(`Unauthorized ${request.headers.authorization ?? ''}`);
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    requests++;
    const server = createTestMCPServer();
    active.add(server);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.on('close', () => { active.delete(server); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(request, response); }
    catch { if (!response.headersSent) response.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.all([...active].map(server => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  });
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  const manager = new MCPManager({ web: { type: 'http', url, headersEnv: { Authorization: variable }, timeoutMs: 3_000 } });
  t.after(() => manager.close());
  await manager.connect('web');
  assert.match(await manager.call('mcp_web_sum', { a: 12, b: 30 }), /42/);
  await manager.disconnect('web');
  await manager.connect('web');
  assert.match(await manager.call('mcp_web_sum', { a: 1, b: 2 }), /3/);
  assert.ok(requests >= 8);
  const missing = new MCPManager({ broken: { type: 'http', url, headersEnv: { Authorization: `${variable}_MISSING` } } });
  await assert.rejects(missing.connect('broken'), /Missing MCP environment variable/);
  await missing.close();
});

test('MCP event stream survives longer than an individual request timeout', { timeout: 10000 }, async t => {
  let streamOpened = false, streamClosed = false;
  const http = createServer(async (request, response) => {
    if (request.method === 'GET') {
      streamOpened = true;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': keep-alive\n\n');
      response.on('close', () => { streamClosed = true; }); return;
    }
    if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
    let text = ''; for await (const piece of request) text += piece;
    const message = JSON.parse(text);
    if (!('id' in message)) { response.writeHead(202).end(); return; }
    const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stream-test', version: '1' } } : { tools: [] };
    response.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'stream-test' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const manager = new MCPManager({ stream: { type: 'http', url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, timeoutMs: 500 } });
  t.after(async () => { await manager.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  await manager.connect('stream');
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(streamOpened, true);
  assert.equal(streamClosed, false);
});
