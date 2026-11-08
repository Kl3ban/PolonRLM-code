import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSafeEgressProxy, fetchPage, isPublicAddress, publicFetch, publicURL, type PinnedRequester, type PublicResolver } from '../src/tools/web.js';
import { defaultSettings } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Workspace } from '../src/tools/workspace.js';
import { registerBrowserSessionTools, summarizeBrowserTab } from '../src/tools/browser-session.js';

const publicResolver: PublicResolver = async () => [{ address: '8.8.8.8', family: 4 }];

test('web fetch handles a successful response without a body', async () => {
  const request: PinnedRequester = async () => new Response(null, { status: 204 });
  const result = await fetchPage('https://empty.example/', new AbortController().signal, publicResolver, request);
  assert.match(result, /empty\.example/);
  assert.ok(result.endsWith('Untrusted web content:\n'));
});

test('web address policy blocks private, reserved, mapped and documentation addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.2', '192.0.2.1', '198.18.0.1', '198.51.100.2', '203.0.113.9', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('fetch pins DNS per request and rejects a public-to-private rebind', async () => {
  let lookups = 0;
  const rebinding: PublicResolver = async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
  await publicURL('https://rebind.example/', rebinding);
  await assert.rejects(publicFetch('https://rebind.example/', new AbortController().signal, undefined, rebinding), /blocks local, private/);
  assert.equal(lookups, 2);
});

test('cross-origin redirects do not forward custom authorization headers', async () => {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let count = 0;
  const requester: PinnedRequester = async (url, _signal, headers) => {
    requests.push({ url: url.href, headers });
    return count++ === 0
      ? new Response(null, { status: 302, headers: { location: 'https://other.example/next' } })
      : new Response('ok', { status: 200 });
  };
  const response = await publicFetch('https://trusted.example/start', new AbortController().signal, { 'X-Subscription-Token': 'test-secret' }, publicResolver, requester);
  assert.equal(await response.text(), 'ok');
  assert.equal(requests[0]?.headers['X-Subscription-Token'], 'test-secret');
  assert.equal(requests[1]?.headers['X-Subscription-Token'], undefined);
  assert.deepEqual(requests.map(value => value.url), ['https://trusted.example/start', 'https://other.example/next']);
});

test('browser egress proxy rejects loopback destinations before connecting', async t => {
  const resolutions: string[] = [];
  const resolver: PublicResolver = async hostname => { resolutions.push(hostname); return [{ address: hostname, family: 4 }]; };
  const proxy = await createSafeEgressProxy(resolver);
  t.after(() => proxy.close());
  const endpoint = new URL(proxy.url);
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: Number(endpoint.port), path: 'http://127.0.0.1/secret', headers: { host: '127.0.0.1' } }, result => {
      let body = ''; result.setEncoding('utf8'); result.on('data', chunk => body += chunk); result.on('end', () => resolve({ status: result.statusCode ?? 0, body }));
    });
    request.once('error', reject); request.end();
  });
  assert.equal(response.status, 403);
  assert.deepEqual(resolutions, ['127.0.0.1']);
});

test('browser reading is discoverable in review while page interactions remain blocked', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polon-browser-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = defaultSettings(); settings.permissions = 'ask';
  const permissions = new Permissions(settings); permissions.approve = async () => false;
  const workspace = await Workspace.open(root, permissions);
  const registry = new ToolRegistry(permissions, 20000);
  registerBrowserSessionTools(registry, workspace);
  t.after(() => registry.close());
  assert.ok(registry.specs('REVIEW').some(tool => tool.name === 'browser'));
  const context = { mode: 'REVIEW' as const, signal: new AbortController().signal };
  await assert.rejects(registry.execute('browser', { action: 'launch', url: 'https://public.example' }, context), /Approval denied/);
  await assert.rejects(registry.execute('browser', { action: 'click', sessionId: 'fixture', selector: '#button' }, context), /mode REVIEW/);
  await assert.rejects(registry.execute('browser', { action: 'launch' }, context), /url.*requires url/);
});

test('a closed browser tab does not prevent the remaining tabs from being summarized', async () => {
  const closed = await summarizeBrowserTab('closed', { url: () => 'https://example.test/path?secret=1', isClosed: () => true, title: async () => { throw new Error('page closed'); } }, true);
  assert.deepEqual(closed, { id: 'closed', url: 'https://example.test/path', title: '', active: true });
  const broken = await summarizeBrowserTab('broken', { url: () => { throw new Error('unavailable'); }, isClosed: () => false, title: async () => 'unused' }, false);
  assert.deepEqual(broken, { id: 'broken', url: '', title: '', active: false });
});
