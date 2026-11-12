import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium, type Browser } from 'playwright';
import { browserOptionsSchema, defaultBrowserOptions } from '../src/core/browser-config.js';
import { defaultSettings } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { BrowserAuthStore } from '../src/tools/browser-auth.js';
import { registerBrowserSessionTools } from '../src/tools/browser-session.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Workspace } from '../src/tools/workspace.js';
import { browserURL, createSafeEgressProxy, publicURL } from '../src/tools/web.js';

function testCipher() {
  const key = randomBytes(32);
  return {
    sealJson(value: unknown) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'); },
    openJson(value: string) { const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString()); },
  };
}
async function listen(server: Server): Promise<string> { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`; }

test('loopback browser policy allows exact explicit origins without weakening ordinary web fetch or DNS pinning', async () => {
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(publicURL('http://localhost:5173', resolver), /blocks/);
  await assert.rejects(browserURL('http://localhost:5173', [], resolver), /blocks/);
  assert.equal((await browserURL('http://localhost:5173/app', ['http://localhost:5173'], resolver)).port, '5173');
  await assert.rejects(browserURL('http://localhost:5174', ['http://localhost:5173'], resolver), /blocks/);
  await assert.rejects(browserURL('http://localhost:5173', ['http://localhost:5173'], async () => [{ address: '8.8.8.8', family: 4 }]), /exclusively to loopback/);
  for (const origin of ['http://192.168.1.1', 'file:///tmp', 'http://localhost:5173/path', 'http://user:pass@localhost:5173']) assert.equal(browserOptionsSchema.safeParse({ localOrigins: [origin] }).success, false);
});

test('auth snapshots are encrypted, project scoped and bind local cookies to saved origins', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-auth-')), cipher = testCipher();
  t.after(() => rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const auth = new BrowserAuthStore(home, 'project', cipher, () => true);
  const state = { cookies: [{ name: 'session', value: 'auth-fixture-private-value', domain: 'localhost', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' as const }], origins: [] };
  const disabled = new BrowserAuthStore(home, 'project', cipher);
  await assert.rejects(disabled.save('work', state), /Only the user.*browser-auth on/);
  await auth.save('work', state, ['http://localhost:5173']);
  await assert.rejects(disabled.load('work'), /disabled/);
  assert.equal((await auth.load('work', ['http://localhost:5173'])).cookies[0]?.value, state.cookies[0]!.value);
  assert.equal((await auth.list())[0]?.name, 'work');
  await assert.rejects(auth.load('work', ['http://localhost:5174']), /local origin/);
  await assert.rejects(auth.load('work', ['http://localhost:5173', 'http://localhost:5174']), /local origin/);
  await assert.rejects(auth.save('../escape', state), /auth name/);
  await assert.rejects(new BrowserAuthStore(home, 'other-project', cipher, () => true).load('work'), /ENOENT/);
  for (const scope of await readdir(path.join(home, 'browser-auth'))) for (const file of await readdir(path.join(home, 'browser-auth', scope))) assert.doesNotMatch(await readFile(path.join(home, 'browser-auth', scope, file), 'utf8'), /auth-fixture-private-value|"cookies"/);
  await auth.remove('work'); assert.deepEqual(await auth.list(), []);
});

test('proxy reaches IPv4-only localhost servers when DNS returns IPv6 first', async t => {
  const server = createServer((_req, res) => res.end('reachable')), address = await listen(server);
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const origin = address.replace('127.0.0.1', 'localhost');
  const proxy = await createSafeEgressProxy(async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }], [origin]);
  t.after(() => proxy.close()); const endpoint = new URL(proxy.url);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: Number(endpoint.port), path: origin + '/', method: 'GET' }, res => { let body = ''; res.setEncoding('utf8'); res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode ?? 0, body })); });
    request.on('error', reject); request.end();
  });
  assert.equal(response.status, 200); assert.equal(response.body, 'reachable');
});

test('real browser reaches allowed localhost, receives WebSockets, restricts service workers and restores opt-in login', { timeout: 60000 }, async t => {
  try { const probe = await chromium.launch({ headless: true }); await probe.close(); }
  catch (error) { if (!/Executable doesn't exist/i.test(String(error)) || process.env.POLONRLM_BROWSER_TEST_REQUIRED === '1') throw error; t.skip('Chromium absent; no implicit download.'); return; }
  let forbiddenRequests = 0;
  const forbidden = createServer((_req, res) => { forbiddenRequests++; res.end('private server data'); }), forbiddenOrigin = await listen(forbidden);
  t.after(() => new Promise<void>(resolve => { forbidden.close(() => resolve()); forbidden.closeAllConnections(); }));
  const serverSockets = new Set<Socket>();
  const server = createServer((req, res) => {
    if (req.url === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(`self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/sw-probe')e.respondWith(fetch('${forbiddenOrigin}/private').then(r=>r.text()).then(x=>new Response(x)).catch(()=>new Response('blocked-from-worker')))});`);
    } else {
      if (req.url === '/login') res.setHeader('Set-Cookie', 'fixture_session=browser-login-private; HttpOnly; SameSite=Lax; Path=/');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<h1>Local development app</h1><p>${req.headers.cookie?.includes('fixture_session=') ? 'Signed in' : 'Guest'}</p><label>Password<input type="password" id="password"></label><a href="/login">Sign in</a>`);
    }
  });
  server.on('connection', socket => { serverSockets.add(socket); socket.once('close', () => serverSockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const message = Buffer.from('websocket-ready'); socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message])); socket.on('error', () => {}); socket.on('data', () => socket.destroy());
  });
  const origin = await listen(server);
  t.after(() => new Promise<void>(resolve => { for (const socket of serverSockets) socket.destroy(); server.close(() => resolve()); server.closeAllConnections(); }));
  const root = await mkdtemp(path.join(os.tmpdir(), 'polon-browser-network-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const permissions = new Permissions({ ...defaultSettings(), permissions: 'all' }), registry = new ToolRegistry(permissions, 0), workspace = await Workspace.open(root, permissions);
  let native: Browser, authEnabled = false, launches = 0;
  const auth = new BrowserAuthStore(root, workspace.root, testCipher(), () => authEnabled);
  registerBrowserSessionTools(registry, workspace, () => 'chromium', { launchBrowser: async (_engine, proxy) => { launches++; native = await chromium.launch({ headless: true, proxy: { server: proxy } }); return { browser: native, engine: 'chromium' }; }, authStore: auth }, () => ({ ...defaultBrowserOptions(), serviceWorkers: 'allow' }));
  t.after(() => registry.close());
  const context = { mode: 'BUILD' as const, signal: AbortSignal.timeout(45000), vision: false };
  const launch = (extra: Record<string, unknown> = {}) => registry.execute('browser', { action: 'launch', url: origin, ...extra }, context);
  await assert.rejects(launch(), /blocks/);
  const session = JSON.parse(await launch({ allowLocal: true })), sessionId = session.sessionId;
  const call = (action: string, args: Record<string, unknown> = {}) => registry.execute('browser', { action, sessionId, ...args }, context);
  const page = native!.contexts()[0]!.pages()[0]!;
  const socketErrors: string[] = []; page.on('websocket', socket => socket.on('socketerror', error => socketErrors.push(error)));
  assert.match(await call('text'), /Guest/);
  await assert.rejects(call('navigate', { url: forbiddenOrigin }), /blocks/);
  const ws = await page.evaluate(url => new Promise<string>((resolve, reject) => { const socket = new WebSocket(url.replace('http:', 'ws:') + '/socket'); const timer = setTimeout(() => { socket.close(); reject(Error('WebSocket timeout')); }, 5000); socket.onmessage = event => { clearTimeout(timer); resolve(event.data); socket.close(); }; socket.onerror = () => { clearTimeout(timer); reject(Error('WebSocket failed')); }; }), origin).catch(error => { throw new Error(String(error) + '\n' + socketErrors.join('\n')); });
  assert.equal(ws, 'websocket-ready');
  const workerResult = await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    return (await fetch('/sw-probe')).text();
  });
  assert.equal(workerResult, 'blocked-from-worker'); assert.equal(forbiddenRequests, 0, 'service worker traffic cannot bypass the local origin allowlist');
  const secretName = 'POLONRLM_BROWSER_SECRET_FIXTURE', previousSecret = process.env[secretName]; process.env[secretName] = 'browser-password-private-fixture';
  t.after(() => { if (previousSecret === undefined) delete process.env[secretName]; else process.env[secretName] = previousSecret; });
  assert.equal(await call('fill', { selector: '#password', secretEnv: secretName }), 'Form field updated.');
  await assert.rejects(call('fill', { selector: '#password', secretEnv: 'OPENAI_API_KEY' }), /Invalid arguments/);
  assert.doesNotMatch(await call('snapshot'), /browser-password-private-fixture/);
  await call('navigate', { url: origin + '/login' });
  await assert.rejects(call('save_auth', { authName: 'work' }), /disabled/);
  authEnabled = true;
  await call('save_auth', { authName: 'work' }); await call('close');
  authEnabled = false; const previousLaunches = launches;
  await assert.rejects(launch({ allowLocal: true, authName: 'work' }), /disabled/);
  assert.equal(launches, previousLaunches, 'disabled auth must fail before starting or installing a browser');
  const hiddenStates = JSON.parse(await registry.execute('browser', { action: 'auth_states' }, context));
  assert.equal(hiddenStates.enabled, false); assert.deepEqual(hiddenStates.states, []);
  authEnabled = true;
  const restored = JSON.parse(await launch({ allowLocal: true, authName: 'work' }));
  assert.match(await registry.execute('browser', { action: 'text', sessionId: restored.sessionId }, context), /Signed in/);
  const listed = await registry.execute('browser', { action: 'auth_states' }, context); assert.match(listed, /work/); assert.doesNotMatch(listed, /browser-login-private|cookies/);
  await registry.execute('browser', { action: 'close', sessionId: restored.sessionId }, context);
});
