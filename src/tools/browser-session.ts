import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { launchBrowser, type BrowserEngine } from './browser-launcher.js';
import { z } from 'zod';
import { safeText } from '../core/secrets.js';
import type { ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import { createSafeEgressProxy, publicURL, type SafeEgressProxy } from './web.js';

type Session = { id: string; engine: Exclude<BrowserEngine, 'auto'>; browser: Browser; proxy: SafeEgressProxy; context: BrowserContext; pages: Map<string, Page>; active: string; created: number; touched: number };
type ConsoleEntry = { type: string; text: string; url?: string; line?: number };
type NetworkEntry = { kind: 'response' | 'failed'; method: string; url: string; status?: number; error?: string };
type PageDiagnostics = { console: ConsoleEntry[]; network: NetworkEntry[] };
export interface BrowserSessionDependencies {
  launchBrowser: typeof launchBrowser;
  createSafeEgressProxy: typeof createSafeEgressProxy;
  publicURL: typeof publicURL;
}
const maxSessions = 3;
const maxTabs = 8;
const maxAge = 30 * 60_000;
const visibleUrl = (value: string) => { try { const url = new URL(value); url.search = ''; url.hash = ''; return url.href; } catch { return value; } };
function safeBrowserUrl(value: string): string {
  try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return safeText(url.href); }
  catch { return ''; }
}
function pushBounded<T>(items: T[], item: T): void { items.push(item); if (items.length > 200) items.splice(0, items.length - 200); }
function observePage(page: Page, diagnostics: WeakMap<Page, PageDiagnostics>): void {
  const current: PageDiagnostics = { console: [], network: [] };
  diagnostics.set(page, current);
  page.on('console', message => {
    const location = message.location();
    pushBounded(current.console, {
      type: message.type(), text: safeText(message.text()).slice(0, 500),
      ...(location.url ? { url: safeBrowserUrl(location.url) } : {}),
      ...(location.lineNumber > 0 ? { line: location.lineNumber } : {}),
    });
  });
  page.on('pageerror', error => pushBounded(current.console, { type: 'pageerror', text: safeText(error.message).slice(0, 500) }));
  page.on('response', response => {
    const status = response.status();
    if (status < 400) return;
    const request = response.request();
    pushBounded(current.network, { kind: 'response', method: request.method(), url: safeBrowserUrl(response.url()), status });
  });
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText;
    pushBounded(current.network, { kind: 'failed', method: request.method(), url: safeBrowserUrl(request.url()), ...(error ? { error: safeText(error).slice(0, 300) } : {}) });
  });
}
export async function summarizeBrowserTab(id: string, tab: Pick<Page, 'url' | 'isClosed' | 'title'>, active: boolean): Promise<{ id: string; url: string; title: string; active: boolean }> {
  try { return { id, url: visibleUrl(tab.url()), title: tab.isClosed() ? '' : await tab.title(), active }; }
  catch { return { id, url: '', title: '', active }; }
}

export function checkboxStatus(action: 'check' | 'uncheck'): string {
  return action === 'check' ? 'Checkbox selected.' : 'Checkbox cleared.';
}

export function registerBrowserSessionTools(registry: ToolRegistry, workspace: Workspace, engine: () => BrowserEngine = () => 'auto', dependencies: Partial<BrowserSessionDependencies> = {}): void {
  const openBrowser = dependencies.launchBrowser ?? launchBrowser;
  const createProxy = dependencies.createSafeEgressProxy ?? createSafeEgressProxy;
  const checkPublicURL = dependencies.publicURL ?? publicURL;
  const sessions = new Map<string, Session>();
  const diagnostics = new WeakMap<Page, PageDiagnostics>();
  const close = async (id: string) => { const session = sessions.get(id); if (!session) return; sessions.delete(id); session.pages.clear(); try { await session.browser.close(); } finally { await session.proxy.close(); } };
  const pruneExpired = async () => Promise.all([...sessions.values()].filter(session => Date.now() - session.touched > maxAge).map(session => close(session.id)));
  const get = (id: string) => { const session = sessions.get(id); if (!session) throw new Error('Browser session not found. Run browser launch.'); if (Date.now() - session.touched > maxAge) { void close(id).catch(() => {}); throw new Error('Browser session expired after 30 minutes of inactivity.'); } session.touched = Date.now(); return session; };
  const page = (session: Session, tabId?: string) => { const id = tabId ?? session.active; const value = session.pages.get(id); if (!value || value.isClosed()) throw new Error('No active tab found. Use browser tabs.'); session.active = id; return value; };
  registry.onClose(async () => { await Promise.all([...sessions.keys()].map(close)); });

  registry.add('browser_sessions', 'List open browser sessions and their tabs.', z.object({}), true, async () => {
    await pruneExpired();
    return Promise.all([...sessions.values()].map(async session => ({ id: session.id, engine: session.engine, activeTab: session.active, tabs: await Promise.all([...session.pages].map(([id, p]) => summarizeBrowserTab(id, p, id === session.active))) })));
  });
  registry.add('browser', 'Persistent headless browser. Read-only navigation and inspection work in PLAN/REVIEW. Inspect recent console messages and failed HTTP requests with console/network; logs are redacted and bounded. Clicks and form interactions require BUILD. Public HTTP(S) sites only; screenshots are sent to the vision model. Each action follows the configured permission policy.', z.object({
    action: z.enum(['launch', 'navigate', 'back', 'forward', 'reload', 'new_tab', 'activate_tab', 'close_tab', 'tabs', 'forms', 'links', 'console', 'network', 'click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'scroll', 'wait', 'text', 'screenshot', 'close']),
    sessionId: z.string().optional(), tabId: z.string().optional(), url: z.string().max(4000).optional(), selector: z.string().max(1000).optional(), text: z.string().max(10000).optional(), key: z.string().max(100).optional(), direction: z.enum(['up', 'down']).default('down'), amount: z.number().int().min(50).max(3000).default(700), timeoutMs: z.number().int().min(100).max(30000).default(10000), limit: z.number().int().min(1).max(50).default(30)
  }).superRefine((args, context) => {
    const required = (field: 'url' | 'sessionId' | 'selector' | 'text' | 'key', condition: boolean) => {
      if (condition && (args[field] === undefined || args[field] === '')) context.addIssue({ code: 'custom', path: [field], message: `Action ${args.action} requires ${field}.` });
    };
    required('sessionId', args.action !== 'launch');
    required('url', ['launch', 'navigate'].includes(args.action));
    required('selector', ['fill', 'type', 'press', 'select', 'check', 'uncheck', 'wait'].includes(args.action));
    required('text', ['fill', 'type', 'select'].includes(args.action) && args.text === undefined);
    required('key', args.action === 'press');
    if (args.action === 'click' && !args.selector && !args.text) context.addIssue({ code: 'custom', path: ['selector'], message: 'click requires selector or text.' });
  }), false, async (args, context) => {
    const action = args.action;
    context.signal.throwIfAborted();
    const description = action === 'fill' || action === 'type' ? `Browser: type text into field ${args.selector ?? ''}.` : action === 'screenshot' ? `Browser: capture ${args.sessionId ?? args.url ?? ''} and send it to the model.` : `Browser: ${action}${args.url ? ` ${args.url}` : ''}${args.selector ? ` ${args.selector}` : ''}.${action === 'launch' ? ' If the Playwright engine is missing, it will be downloaded to the local cache.' : ''}`;
    await workspace.permissions.check('browser', 'external', description, action === 'fill' || action === 'type' ? '[field input hidden]' : undefined, context.mode, context.signal, ["click", "fill", "type", "press", "select", "check", "uncheck"].includes(action));
    if (action === 'launch') {
      if (!args.url) throw new Error('Provide a public URL.');
      await checkPublicURL(args.url);
      await pruneExpired();
      if (sessions.size >= maxSessions) throw new Error(`Browser session limit reached (${maxSessions}).`);
       const proxy = await createProxy();
       let browser: Browser; let selectedEngine: Exclude<BrowserEngine, 'auto'>;
       try { ({ browser, engine: selectedEngine } = await openBrowser(engine(), proxy.url, context.signal)); }
       catch (error) { await proxy.close(); throw error; }
      try {
        const browserContext = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1365, height: 900 } });
        await browserContext.routeWebSocket('**/*', socket => socket.close());
        await browserContext.route('**/*', async route => {
          try {
            const requestUrl = route.request().url();
            if (/^(data|blob|about):/i.test(requestUrl)) { await route.continue(); return; }
            await checkPublicURL(requestUrl); await route.continue();
          } catch { await route.abort(); }
        });
        const first = await browserContext.newPage(); first.setDefaultTimeout(10000); observePage(first, diagnostics);
        await first.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const tabId = randomUUID().slice(0, 8), id = randomUUID().slice(0, 10);
         const session = { id, engine: selectedEngine, browser, proxy, context: browserContext, pages: new Map([[tabId, first]]), active: tabId, created: Date.now(), touched: Date.now() };
        sessions.set(id, session);
        return JSON.stringify({ sessionId: id, tabId, engine: selectedEngine, url: visibleUrl(first.url()), title: await first.title() });
       } catch (error) { try { await browser.close(); } finally { await proxy.close(); } throw error; }
    }
    if (!args.sessionId) throw new Error('Provide sessionId.');
    const session = get(args.sessionId);
    if (action === 'close') { await close(session.id); return 'Browser session closed.'; }
    if (action === 'tabs') return JSON.stringify(await Promise.all([...session.pages].map(([id, p]) => summarizeBrowserTab(id, p, id === session.active))));
    if (action === 'new_tab') {
      if (session.pages.size >= maxTabs) throw new Error(`Tab limit reached for this session (${maxTabs}).`);
      if (args.url) await checkPublicURL(args.url);
      const next = await session.context.newPage(); next.setDefaultTimeout(10000); observePage(next, diagnostics);
      try {
        if (args.url) await next.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        const url = visibleUrl(next.url()), title = await next.title(), id = randomUUID().slice(0, 8);
        session.pages.set(id, next); session.active = id;
        return JSON.stringify({ tabId: id, url, title });
      } catch (error) { await next.close().catch(() => {}); throw error; }
    }
    if (action === 'activate_tab') { page(session, args.tabId); return `Active tab: ${session.active}`; }
    if (action === 'close_tab') { const active = page(session, args.tabId); await active.close(); session.pages.delete(args.tabId ?? session.active); if (!session.pages.size) { await close(session.id); return 'Last tab closed; session ended.'; } session.active = session.pages.keys().next().value!; return `Tab closed. Active: ${session.active}`; }
    const current = page(session, args.tabId);
    if (action === 'navigate') { if (!args.url) throw new Error('Provide a URL.'); await checkPublicURL(args.url); await current.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); return JSON.stringify({ url: visibleUrl(current.url()), title: await current.title() }); }
    if (action === 'back') { await current.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }); return JSON.stringify({ url: visibleUrl(current.url()), title: await current.title() }); }
    if (action === 'forward') { await current.goForward({ waitUntil: 'domcontentloaded', timeout: 20000 }); return JSON.stringify({ url: visibleUrl(current.url()), title: await current.title() }); }
    if (action === 'reload') { await current.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }); return JSON.stringify({ url: visibleUrl(current.url()), title: await current.title() }); }
    if (action === 'text') return `${visibleUrl(current.url())}\n${(await current.locator('body').innerText({ timeout: args.timeoutMs })).slice(0, 30000)}`;
    if (action === 'console' || action === 'network') {
      const currentDiagnostics = diagnostics.get(current);
      const entries = action === 'console' ? currentDiagnostics?.console ?? [] : currentDiagnostics?.network ?? [];
      return JSON.stringify({ url: safeBrowserUrl(current.url()), total: entries.length, truncated: entries.length > args.limit, entries: entries.slice(-args.limit) });
    }
    if (action === 'forms') return JSON.stringify((await current.locator('input, textarea, select, button').evaluateAll((elements: Element[]) => elements.slice(0, 100).map(element => {
      const field = element as HTMLInputElement; const label = field.labels?.[0]?.innerText ?? field.getAttribute('aria-label') ?? '';
      return { tag: element.tagName.toLowerCase(), type: field.type ?? '', name: field.name ?? '', id: field.id, label: label.slice(0, 200), placeholder: field.placeholder ?? '', required: field.required ?? false, options: element instanceof HTMLSelectElement ? Array.from(element.options).slice(0, 50).map(option => ({ label: option.label, value: option.value })) : undefined };
    }))));
    if (action === 'links') return JSON.stringify(await current.locator('a[href]').evaluateAll((elements: HTMLAnchorElement[]) => elements.slice(0, 100).map(anchor => { const url = new URL(anchor.href); url.search = ''; url.hash = ''; return { text: (anchor.innerText || anchor.getAttribute('aria-label') || '').trim().slice(0, 200), url: url.href }; })));
    if (action === 'screenshot') {
      if (context.vision === false) throw new Error('browser screenshot requires a vision model.');
      const bytes = await current.screenshot({ type: 'jpeg', quality: 72, animations: 'disabled', timeout: args.timeoutMs });
      context.onImage?.({ data: bytes.toString('base64'), mediaType: 'image/jpeg' });
      return `Screenshot of tab ${session.active}: ${visibleUrl(current.url())} (${bytes.length} image bytes).`;
    }
    if (action === 'scroll') { await current.evaluate(amount => window.scrollBy({ top: amount, behavior: 'instant' }), args.direction === 'down' ? args.amount : -args.amount); return `Scrolled ${args.direction}.`; }
    if (action === 'wait') { if (!args.selector) throw new Error('Provide a selector.'); await current.locator(args.selector).waitFor({ state: 'visible', timeout: args.timeoutMs }); return 'Element is visible.'; }
    if (action === 'press') { if (!args.selector || !args.key) throw new Error('Provide a selector and key.'); await current.locator(args.selector).press(args.key); return 'Key sent.'; }
    if (action === 'click') { if (args.selector) await current.locator(args.selector).click(); else if (args.text) await current.getByText(args.text, { exact: true }).first().click(); else throw new Error('Provide a selector or exact text.'); return 'Clicked element.'; }
    if (!args.selector) throw new Error('Provide a form field selector.');
    const locator = current.locator(args.selector);
    if (action === 'fill') { if (args.text === undefined) throw new Error('Provide text.'); await locator.fill(args.text); return 'Form field updated.'; }
    if (action === 'type') { if (args.text === undefined) throw new Error('Provide text.'); await locator.pressSequentially(args.text, { delay: 20 }); return 'Text entered.'; }
    if (action === 'select') { if (args.text === undefined) throw new Error('Provide text with an option value.'); await locator.selectOption(args.text); return 'Option selected.'; }
    if (action === 'check') { await locator.check(); return checkboxStatus(action); }
    if (action === 'uncheck') { await locator.uncheck(); return checkboxStatus(action); }
    throw new Error('Unsupported browser action.');
  }, args => ['click', 'fill', 'type', 'press', 'select', 'check', 'uncheck'].includes(args.action));

}
