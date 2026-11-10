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
import type { Browser, BrowserContext, Page } from 'playwright';
import { checkboxStatus, registerBrowserSessionTools, summarizeBrowserTab } from '../src/tools/browser-session.js';

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

test('new browser tabs validate destinations first and discard failed navigations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polon-browser-tabs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { ...defaultSettings(), permissions: 'all' as const };
  const permissions = new Permissions(settings), workspace = await Workspace.open(root, permissions);
  const registry = new ToolRegistry(permissions, 20000);
  let createdPages = 0, closedPages = 0;
  const makePage = (): Page => {
    let currentUrl = 'about:blank', closed = false;
    return {
      url: () => currentUrl,
      isClosed: () => closed,
      title: async () => currentUrl === 'about:blank' ? 'Blank' : 'Fixture',
      setDefaultTimeout: () => {},
      on: () => {},
      goto: async (url: string) => { if (url === 'https://fail.example/') throw new Error('navigation failed'); currentUrl = url; },
      close: async () => { closed = true; closedPages++; },
    } as unknown as Page;
  };
  const browserContext = {
    routeWebSocket: async () => {}, route: async () => {},
    newPage: async () => { createdPages++; return makePage(); },
  } as unknown as BrowserContext;
  const browser = { newContext: async () => browserContext, close: async () => {} } as unknown as Browser;
  const proxy = { url: 'http://127.0.0.1:0', close: async () => {} };
  registerBrowserSessionTools(registry, workspace, () => 'chromium', {
    launchBrowser: async () => ({ browser, engine: 'chromium' }),
    createSafeEgressProxy: async () => proxy,
    publicURL: async (url: string) => { if (url.startsWith('http://127.0.0.1')) throw new Error('Private address blocked.'); },
  });
  t.after(() => registry.close());
  const context = { mode: 'BUILD' as const, signal: new AbortController().signal };
  const opened = JSON.parse(await registry.execute('browser', { action: 'launch', url: 'https://public.example/' }, context));
  const countTabs = async () => JSON.parse(await registry.execute('browser', { action: 'tabs', sessionId: opened.sessionId }, context)).length;

  await assert.rejects(registry.execute('browser', { action: 'new_tab', sessionId: opened.sessionId, url: 'http://127.0.0.1/private' }, context), /Private address blocked/);
  assert.equal(createdPages, 1, 'private destinations are rejected before opening a page');
  await assert.rejects(registry.execute('browser', { action: 'new_tab', sessionId: opened.sessionId, url: 'https://fail.example/' }, context), /navigation failed/);
  assert.equal(closedPages, 1, 'a page is closed if its initial navigation fails');
  assert.equal(await countTabs(), 1, 'failed pages are not retained in the session');
  const session = JSON.parse(await registry.execute('browser_sessions', {}, context))[0];
  assert.equal(session.activeTab, opened.tabId, 'failed tabs do not change the active tab');

  const tab = JSON.parse(await registry.execute('browser', { action: 'new_tab', sessionId: opened.sessionId, url: 'https://success.example/' }, context));
  assert.match(tab.title, /Fixture/);
  assert.equal(await countTabs(), 2);
});

test('expired browser sessions are closed before enforcing the session limit', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polon-browser-expiry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { ...defaultSettings(), permissions: 'all' as const };
  const permissions = new Permissions(settings), workspace = await Workspace.open(root, permissions);
  const registry = new ToolRegistry(permissions, 20000);
  t.after(() => registry.close());

  const originalNow = Date.now;
  let now = originalNow(), browserCloses = 0, proxyCloses = 0;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const makePage = (): Page => {
    let url = 'about:blank';
    return { url: () => url, isClosed: () => false, title: async () => 'Fixture', setDefaultTimeout: () => {}, goto: async (next: string) => { url = next; }, on: () => {} } as unknown as Page;
  };
  const makeBrowser = (): Browser => {
    const context = { routeWebSocket: async () => {}, route: async () => {}, newPage: async () => makePage() } as unknown as BrowserContext;
    return { newContext: async () => context, close: async () => { browserCloses++; } } as unknown as Browser;
  };
  registerBrowserSessionTools(registry, workspace, () => 'chromium', {
    launchBrowser: async () => ({ browser: makeBrowser(), engine: 'chromium' }),
    createSafeEgressProxy: async () => ({ url: 'http://127.0.0.1:0', close: async () => { proxyCloses++; } }),
    publicURL: async () => {},
  });
  const context = { mode: 'BUILD' as const, signal: new AbortController().signal };
  const launch = async () => JSON.parse(await registry.execute('browser', { action: 'launch', url: 'https://public.example/' }, context));
  await launch(); await launch(); await launch();
  now += 30 * 60_000 + 1;

  const fourth = await launch();
  assert.ok(fourth.sessionId);
  assert.equal(browserCloses, 3);
  assert.equal(proxyCloses, 3);
});

test('browser console and network diagnostics are bounded, redacted, and read-only', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'polon-browser-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = { ...defaultSettings(), permissions: 'all' as const };
  const permissions = new Permissions(settings), workspace = await Workspace.open(root, permissions);
  const registry = new ToolRegistry(permissions, 20000);
  const events = new Map<string, (event: any) => void>();
  let currentUrl = 'about:blank';
  const page = {
    url: () => currentUrl, isClosed: () => false, title: async () => 'Fixture', setDefaultTimeout: () => {},
    goto: async (url: string) => { currentUrl = url; },
    on: (name: string, listener: (event: any) => void) => { events.set(name, listener); return page; },
  } as unknown as Page;
  const browserContext = { routeWebSocket: async () => {}, route: async () => {}, newPage: async () => page } as unknown as BrowserContext;
  const browser = { newContext: async () => browserContext, close: async () => {} } as unknown as Browser;
  const proxy = { url: 'http://127.0.0.1:0', close: async () => {} };
  registerBrowserSessionTools(registry, workspace, () => 'chromium', {
    launchBrowser: async () => ({ browser, engine: 'chromium' }),
    createSafeEgressProxy: async () => proxy,
    publicURL: async () => {},
  });
  t.after(() => registry.close());
  const context = { mode: 'REVIEW' as const, signal: new AbortController().signal };
  const opened = JSON.parse(await registry.execute('browser', { action: 'launch', url: 'https://public.example/' }, context));
  events.get('console')!({ type: () => 'error', text: () => 'api_key=page-secret', location: () => ({ url: 'https://public.example/app.js?token=private', lineNumber: 8 }) });
  events.get('pageerror')!(new Error('Script crashed with nvapi-' + 'x'.repeat(24)));
  const failedRequest = { method: () => 'GET', url: () => 'https://public.example/asset.js?access_token=private' };
  events.get('response')!({ status: () => 503, request: () => failedRequest, url: () => failedRequest.url() });
  events.get('requestfailed')!({ ...failedRequest, failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) });

  const logs = JSON.parse(await registry.execute('browser', { action: 'console', sessionId: opened.sessionId, limit: 1 }, context));
  const network = JSON.parse(await registry.execute('browser', { action: 'network', sessionId: opened.sessionId, limit: 10 }, context));
  assert.equal(logs.total, 2);
  assert.equal(logs.entries.length, 1);
  assert.equal(logs.truncated, true);
  assert.match(JSON.stringify(logs.entries), /\[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(logs), /page-secret|token=private|nvapi-x/);
  assert.equal(network.total, 2);
  assert.equal(network.entries[0].status, 503);
  assert.equal(network.entries[1].error, 'net::ERR_CONNECTION_RESET');
  assert.doesNotMatch(JSON.stringify(network), /access_token=private/);
  assert.equal(registry.isReadOnly('browser', { action: 'network' }), true);
  assert.ok(registry.specs('REVIEW').some(tool => tool.name === 'browser'));

  for (let index = 0; index < 205; index++) events.get('console')!({ type: () => 'log', text: () => `overflow ${index}`, location: () => ({ url: '', lineNumber: 0 }) });
  const bounded = JSON.parse(await registry.execute('browser', { action: 'console', sessionId: opened.sessionId, limit: 50 }, context));
  assert.equal(bounded.total, 200);
  assert.equal(bounded.entries.length, 50);
  assert.equal(bounded.entries[0].text, 'overflow 155');
  assert.equal(bounded.entries.at(-1).text, 'overflow 204');
});

test('a closed browser tab does not prevent the remaining tabs from being summarized', async () => {
  const closed = await summarizeBrowserTab('closed', { url: () => 'https://example.test/path?secret=1', isClosed: () => true, title: async () => { throw new Error('page closed'); } }, true);
  assert.deepEqual(closed, { id: 'closed', url: 'https://example.test/path', title: '', active: true });
  const broken = await summarizeBrowserTab('broken', { url: () => { throw new Error('unavailable'); }, isClosed: () => false, title: async () => 'unused' }, false);
  assert.deepEqual(broken, { id: 'broken', url: '', title: '', active: false });
});

test('browser checkbox actions report status in English', () => {
  assert.equal(checkboxStatus('check'), 'Checkbox selected.');
  assert.equal(checkboxStatus('uncheck'), 'Checkbox cleared.');
});
