import dns from 'node:dns/promises';
import net from 'node:net';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { launchBrowser, type BrowserEngine } from './browser-launcher.js';
import type { Workspace } from './workspace.js';
import type { Mode } from '../core/types.js';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type PublicResolver = (hostname: string) => Promise<ResolvedAddress[]>;
const systemResolver: PublicResolver = async hostname => net.isIP(hostname)
  ? [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }]
  : (await dns.lookup(hostname, { all: true, verbatim: true })).map(address => ({ address: address.address, family: address.family as 4 | 6 }));
function ipv4Number(address: string): number { return address.split('.').reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0); }
function ipv6Number(address: string): bigint {
  let value = address.split('%')[0]!.toLowerCase();
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':'); const n = ipv4Number(value.slice(colon + 1));
    value = `${value.slice(0, colon)}:${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [left = '', right = ''] = value.split('::');
  const a = left ? left.split(':') : [], b = right ? right.split(':') : [];
  const groups = value.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  if (groups.length !== 8) throw new Error('Invalid IPv6 address.');
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group || '0'}`), 0n);
}
function inV6Prefix(value: bigint, prefix: bigint, bits: number): boolean { return value >> BigInt(128 - bits) === prefix >> BigInt(128 - bits); }
function publicIpv4(address: string): boolean {
  if (!net.isIPv4(address)) return false;
  const value = ipv4Number(address);
  const blocked: [number, number][] = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16],
    [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16],
    [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
  ];
  return !blocked.some(([base, bits]) => value >>> (32 - bits) === base >>> (32 - bits));
}
export function isPublicAddress(address: string): boolean {
  if (net.isIPv4(address)) return publicIpv4(address);
  if (!net.isIPv6(address)) return false;
  const value = ipv6Number(address);
  if (value >> 32n === 0xffffn) {
    const n = Number(value & 0xffffffffn);
    return publicIpv4(`${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`);
  }
  if (value === 0n || value === 1n || value >> 32n === 0n) return false;
  // Only global-unicast IPv6 plus non-global carve-outs is accepted. This rejects ULA,
  // link-local, multicast, documentation, transition and IPv4-translation ranges.
  return inV6Prefix(value, 0x20000000000000000000000000000000n, 3)
    && !inV6Prefix(value, 0x20010000000000000000000000000000n, 23)
    && !inV6Prefix(value, 0x20010db8000000000000000000000000n, 32)
    && !inV6Prefix(value, 0x20020000000000000000000000000000n, 16)
    && !inV6Prefix(value, 0x0064ff9b000000000000000000000000n, 32);
}
export async function resolvePublicAddresses(hostname: string, resolver: PublicResolver = systemResolver): Promise<ResolvedAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const addresses = await resolver(host);
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('The web tool blocks local, private, and special-purpose addresses.');
  return addresses;
}
function parsePublicURL(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('A public HTTP(S) URL without credentials is required.');
  return url;
}
export async function publicURL(value: string, resolver: PublicResolver = systemResolver): Promise<URL> {
  const url = parsePublicURL(value);
  await resolvePublicAddresses(url.hostname, resolver);
  return url;
}
export type PinnedRequester = (url: URL, signal: AbortSignal, headers: Record<string, string>, resolver: PublicResolver) => Promise<Response>;
const pinnedRequest: PinnedRequester = async (url, signal, headers, resolver) => {
  const addresses = await resolvePublicAddresses(url.hostname, resolver);
  const pinned = addresses[0]!;
  const lookup = (_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    if (options?.all) callback(null, addresses.map(item => ({ address: item.address, family: item.family })));
    else callback(null, pinned.address, pinned.family);
  };
  const combined = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  const request = url.protocol === 'https:' ? https.request : http.request;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request(url, { headers, lookup: lookup as any, agent: false, signal: combined }, resolve);
    outgoing.once('error', reject); outgoing.end();
  });
  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item);
  }
  const status = response.statusCode ?? 502;
  const body = status === 204 || status === 304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
  if (body === null) response.resume();
  return new Response(body, { status, headers: responseHeaders });
};
export async function publicFetch(value: string, signal: AbortSignal, headers?: Record<string, string>, resolver: PublicResolver = systemResolver, request: PinnedRequester = pinnedRequest): Promise<Response> {
  let url = parsePublicURL(value);
  let requestHeaders = headers;
  for (let index = 0; index < 5; index++) {
    const response = await request(url, signal, requestHeaders ?? { 'User-Agent': 'PolonRLM/0.5' }, resolver);
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      await response.body?.cancel();
      const next = parsePublicURL(new URL(response.headers.get('location')!, url).href);
      if (next.origin !== url.origin) requestHeaders = undefined;
      url = next; continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }
  throw new Error('Too many redirects.');
}

export interface SafeEgressProxy { url: string; close(): Promise<void> }
function proxyError(response: ServerResponse, status: number): void { if (!response.headersSent) response.writeHead(status, { 'Connection': 'close', 'Content-Length': '0' }); response.end(); }
function remoteHeaders(input: http.IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = { ...input, host } as Record<string, string | string[]>;
  for (const key of ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer']) delete result[key];
  return result;
}
export async function createSafeEgressProxy(resolver: PublicResolver = systemResolver): Promise<SafeEgressProxy> {
  const sockets = new Set<Socket>();
  const server: Server = http.createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '', request.headers.host ? `http://${request.headers.host}` : undefined);
        if (url.protocol !== 'http:' || url.username || url.password) throw new Error('Only public HTTP requests are allowed.');
        const addresses = await resolvePublicAddresses(url.hostname, resolver), pinned = addresses[0]!;
        const outgoing = http.request({ hostname: pinned.address, family: pinned.family, port: Number(url.port || 80), path: `${url.pathname}${url.search}`, method: request.method ?? 'GET', headers: remoteHeaders(request.headers, url.host), agent: false, timeout: 20_000 }, incoming => {
          response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, incoming.headers); incoming.pipe(response);
        });
        outgoing.once('error', () => proxyError(response, 502));
        request.pipe(outgoing);
      } catch { proxyError(response, 403); }
    })();
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (request, client, head) => {
    void (async () => {
      let upstream: Socket | undefined;
      try {
        const url = new URL(`https://${request.url ?? ''}`);
        if (url.username || url.password) throw new Error('Proxy credentials are forbidden.');
        const addresses = await resolvePublicAddresses(url.hostname, resolver), pinned = addresses[0]!;
        upstream = net.connect({ host: pinned.address, family: pinned.family, port: Number(url.port || 443) });
        upstream.once('error', () => client.destroy());
        client.once('error', () => upstream?.destroy());
        client.once('close', () => upstream?.destroy());
        await new Promise<void>((resolve, reject) => { upstream!.once('connect', resolve); upstream!.once('error', reject); });
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      } catch {
        upstream?.destroy();
        if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') { await new Promise<void>(resolve => server.close(() => resolve())); throw new Error('Could not start the local security proxy.'); }
  return { url: `http://127.0.0.1:${address.port}`, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
async function boundedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 2_000_000) throw new Error('Page exceeds 2 MB.'); chunks.push(result.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
function plain(html: string): string { return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim(); }
export async function fetchPage(url: string, signal: AbortSignal, resolver: PublicResolver = systemResolver, request: PinnedRequester = pinnedRequest): Promise<string> { const response = await publicFetch(url, signal, undefined, resolver, request); return `Source: ${url}\nUntrusted web content:\n${plain(await boundedText(response))}`; }
export async function browserAction(args: { url: string; action: string; selector?: string; output: string }, workspace: Workspace, signal: AbortSignal, mode: Mode, engine: BrowserEngine = 'auto'): Promise<string> {
  await publicURL(args.url); signal.throwIfAborted();
  const proxy = await createSafeEgressProxy();
  let browser;
  try { ({ browser } = await launchBrowser(engine, proxy.url, signal)); }
  catch (error) { await proxy.close(); throw error; }
  const onAbort = () => { void browser.close(); }; signal.addEventListener('abort', onAbort, { once: true });
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await context.routeWebSocket('**/*', socket => { socket.close(); });
    await context.route('**/*', async route => { try { await publicURL(route.request().url()); await route.continue(); } catch { await route.abort(); } });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (args.action === 'click') { if (!args.selector) throw new Error('Provide a selector.'); await page.locator(args.selector).click(); }
    if (args.action === 'screenshot') {
      const output = await workspace.resolve(args.output);
      await workspace.permissions.check('browser_automation', 'write', `Save screenshot to ${args.output}`, undefined, mode, signal);
      await page.screenshot({ path: output }); return `Saved ${output}`;
    }
    return `${page.url()}\n${await page.locator('body').innerText()}`;
  } finally { signal.removeEventListener('abort', onAbort); try { await browser.close(); } finally { await proxy.close(); } }
}
