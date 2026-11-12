import { randomUUID } from 'node:crypto';
import { type Browser, type BrowserContext, type Frame, type Locator, type Page, type Request } from 'playwright';
import { z } from 'zod';
import { browserSessionOptionsSchema, defaultBrowserOptions, type BrowserOptions } from '../core/browser-config.js';
import { launchBrowser, type BrowserEngine } from './browser-launcher.js';
import { BrowserSnapshots, DEFAULT_STYLES, inspectElement, inspectPerformance } from './browser-inspection.js';
import { browserReport, safeBrowserUrl, safeDiagnosticText } from './browser-output.js';
import type { ToolContext, ToolRegistry } from './registry.js';
import type { Workspace } from './workspace.js';
import { browserURL, createSafeEgressProxy, isLoopbackOrigin, publicURL, type SafeEgressProxy } from './web.js';
import type { BrowserAuthStore } from './browser-auth.js';
import { registerSecret } from '../core/secrets.js';

type Session = { id: string; engine: Exclude<BrowserEngine, 'auto'>; browser: Browser; proxy: SafeEgressProxy; context: BrowserContext; pages: Map<string, Page>; active: string; touched: number; options: BrowserOptions; pending: Promise<unknown> };
type ConsoleEntry = { id: number; type: string; text: string; url?: string; line?: number };
type NetworkEntry = { id: number; kind: 'response' | 'failed'; method: string; url: string; status?: number; error?: string; resourceType?: string; durationMs?: number };
type PageDiagnostics = { console: ConsoleEntry[]; network: NetworkEntry[]; sequence: number };
export interface BrowserSessionDependencies { launchBrowser: typeof launchBrowser; createSafeEgressProxy: typeof createSafeEgressProxy; publicURL: typeof publicURL; authStore?: BrowserAuthStore }
const maxSessions = 3, maxTabs = 8, maxAge = 30 * 60_000;
const mutating = ['click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'save_auth', 'delete_auth'];
function pushBounded<T>(items: T[], item: T): void { items.push(item); if (items.length > 200) items.splice(0, items.length - 200); }
function observePage(page: Page, diagnostics: WeakMap<Page, PageDiagnostics>, snapshots: BrowserSnapshots): void {
  const current: PageDiagnostics = { console: [], network: [], sequence: 0 };
  const requests = new WeakMap<Request, NetworkEntry>();
  diagnostics.set(page, current);
  page.on('framenavigated', () => snapshots.invalidate(page));
  page.on('console', message => {
    const location = message.location();
    pushBounded(current.console, { id: ++current.sequence, type: message.type(), text: safeDiagnosticText(message.text()).slice(0, 500), ...(location.url ? { url: safeBrowserUrl(location.url) } : {}), ...(location.lineNumber > 0 ? { line: location.lineNumber } : {}) });
  });
  page.on('pageerror', error => pushBounded(current.console, { id: ++current.sequence, type: 'pageerror', text: safeDiagnosticText(error.message).slice(0, 500) }));
  page.on('response', response => {
    const request = response.request();
    const item: NetworkEntry = { id: ++current.sequence, kind: 'response', method: request.method(), url: safeBrowserUrl(response.url()), status: response.status(), resourceType: request.resourceType?.() };
    requests.set(request, item); pushBounded(current.network, item);
  });
  page.on('requestfinished', request => {
    const item = requests.get(request); requests.delete(request);
    const timing = request.timing(); if (item && timing.responseEnd >= 0) item.durationMs = Math.round(timing.responseEnd);
  });
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText;
    pushBounded(current.network, { id: ++current.sequence, kind: 'failed', method: request.method(), url: safeBrowserUrl(request.url()), resourceType: request.resourceType?.(), ...(error ? { error: safeDiagnosticText(error).slice(0, 300) } : {}) });
  });
}
export async function summarizeBrowserTab(id: string, tab: Pick<Page, 'url' | 'isClosed' | 'title'>, active: boolean): Promise<{ id: string; url: string; title: string; active: boolean }> {
  try { return { id, url: safeBrowserUrl(tab.url()), title: tab.isClosed() ? '' : safeDiagnosticText(await tab.title()), active }; }
  catch { return { id, url: '', title: '', active }; }
}
export function checkboxStatus(action: 'check' | 'uncheck'): string { return action === 'check' ? 'Checkbox selected.' : 'Checkbox cleared.'; }
const targetFields = {
  ref: z.string().max(80).optional().describe('Element ref returned by snapshot; include snapshotId.'), snapshotId: z.string().max(40).optional(),
  selector: z.string().max(1000).optional(), frameId: z.string().max(80).optional().describe('ID from browser frames; omit for main document.'),
};
const maxCharsField = z.number().int().min(1000).max(30000).optional();

export function registerBrowserSessionTools(registry: ToolRegistry, workspace: Workspace, engine: () => BrowserEngine = () => 'auto', dependencies: Partial<BrowserSessionDependencies> = {}, defaults: () => BrowserOptions = defaultBrowserOptions): void {
  const openBrowser = dependencies.launchBrowser ?? launchBrowser, createProxy = dependencies.createSafeEgressProxy ?? createSafeEgressProxy;
  const checkPublicURL = (url: string, origins: readonly string[] = []) => dependencies.publicURL ? dependencies.publicURL(url) : browserURL(url, origins);
  const auth = () => { if (!dependencies.authStore) throw new Error('Saved browser auth is available in the main app. This browser session is temporary.'); return dependencies.authStore; };
  const sessions = new Map<string, Session>(), diagnostics = new WeakMap<Page, PageDiagnostics>();
  let launches = 0;
  const pageReady = new WeakMap<Page, Promise<unknown>>();
  const snapshots = new BrowserSnapshots(), frameIds = new WeakMap<Frame, string>();
  const close = async (id: string) => { const session = sessions.get(id); if (!session) return; sessions.delete(id); session.pages.clear(); try { await session.browser.close(); } finally { await session.proxy.close(); } };
  const pruneExpired = async () => Promise.all([...sessions.values()].filter(session => Date.now() - session.touched > maxAge).map(session => close(session.id)));
  const get = (id: string) => { const session = sessions.get(id); if (!session) throw new Error('Browser session not found. Run browser launch.'); if (Date.now() - session.touched > maxAge) { void close(id).catch(() => {}); throw new Error('Browser session expired after 30 minutes of inactivity.'); } session.touched = Date.now(); return session; };
  const page = (session: Session, tabId?: string) => { const id = tabId ?? session.active; const value = session.pages.get(id); if (!value || value.isClosed()) throw new Error('No active tab found. Use browser tabs.'); session.active = id; return value; };
  const frameId = (frame: Frame) => { let id = frameIds.get(frame); if (!id) { id = randomUUID().slice(0, 8); frameIds.set(frame, id); } return id; };
  const frame = (current: Page, id?: string): Frame => { const result = id ? current.frames().find(item => frameId(item) === id) : current.mainFrame(); if (!result || result.isDetached()) throw new Error('Frame no longer exists. Run browser frames.'); return result; };
  const target = (current: Page, args: { ref?: string; snapshotId?: string; selector?: string; frameId?: string; text?: string }): Locator => {
    if (args.ref) return snapshots.target(current, args.ref, args.snapshotId);
    const scope = args.frameId ? frame(current, args.frameId) : current;
    if (args.selector) return scope.locator(args.selector);
    if (args.text) return scope.getByText(args.text, { exact: true });
    throw new Error('Provide ref + snapshotId, a selector, or exact text. Run browser snapshot to find elements.');
  };
  // Stateful actions remain ordered even when called concurrently through the SDK.
  const withSession = <T>(id: string, signal: AbortSignal, run: (session: Session) => Promise<T>): Promise<T> => {
    const session = get(id);
    const next = session.pending.then(async () => { signal.throwIfAborted(); get(id); return run(session); });
    session.pending = next.catch(() => {}); return next;
  };
  const withPage = async <T>(current: Page, context: ToolContext, run: () => Promise<T>): Promise<T> => {
    const abort = () => { snapshots.invalidate(current); void current.close().catch(() => {}); };
    context.signal.throwIfAborted(); context.signal.addEventListener('abort', abort, { once: true });
    try { await pageReady.get(current); context.signal.throwIfAborted(); const result = await run(); context.signal.throwIfAborted(); return result; }
    catch (error) {
      context.signal.throwIfAborted(); const message = error instanceof Error ? error.message : String(error);
      if (/strict mode violation/i.test(message)) throw new Error('Browser target is ambiguous. Run snapshot and use one exact ref. No interaction was performed.');
      if (/Timeout|not attached|not found.*snapshot|ref.*not found/i.test(message)) throw new Error(`Browser action did not complete: ${safeDiagnosticText(message).slice(0, 700)}. Refresh snapshot; use browser_inspect for visibility, disabled state and overlays. Do not repeat the same call blindly.`);
      throw error;
    } finally { context.signal.removeEventListener('abort', abort); }
  };
  const approve = (name: string, description: string, context: ToolContext, writes = false) => workspace.permissions.check(name, 'external', description, undefined, context.mode, context.signal, writes);
  const trackPage = (session: Session, next: Page): string => {
    const known = [...session.pages].find(([, value]) => value === next); if (known) return known[0];
    const id = randomUUID().slice(0, 8); session.pages.set(id, next);
    next.setDefaultTimeout(session.options.timeoutMs); observePage(next, diagnostics, snapshots);
    const ready = Promise.all([
      next.setViewportSize?.({ width: session.options.viewportWidth, height: session.options.viewportHeight }),
      next.emulateMedia?.({ colorScheme: session.options.colorScheme, reducedMotion: 'reduce' }),
    ]);
    pageReady.set(next, ready); void ready.catch(() => {});
    next.on('close', () => { session.pages.delete(id); if (session.active === id) session.active = session.pages.keys().next().value ?? ''; snapshots.invalidate(next); });
    return id;
  };
  registry.onClose(async () => { await Promise.all([...sessions.keys()].map(close)); });
  registry.add('browser_sessions', 'List persistent browser sessions and tabs.', z.object({}), true, async () => {
    await pruneExpired(); return Promise.all([...sessions.values()].map(async session => ({ id: session.id, engine: session.engine, activeTab: session.active, tabs: await Promise.all([...session.pages].map(([id, p]) => summarizeBrowserTab(id, p, id === session.active))) })));
  });
  registry.add('browser_configure', 'Read browser defaults, or configure a session: viewport, theme, timeouts, compact output and optional image/media/font blocking. Locale/time zone defaults are user settings (browserOptions). No visible browser window.', z.object({
    sessionId: z.string().optional(), options: browserSessionOptionsSchema.optional(),
  }).refine(args => !args.options || !!args.sessionId, 'Changing options requires sessionId.'), true, async (args, context) => {
    if (!args.sessionId) return { defaults: defaults(), note: 'Change persistent defaults with /settings browserOptions JSON. Existing sessions retain their options.' };
    await approve('browser_configure', 'Read or change headless browser session configuration.', context);
    return withSession(args.sessionId, context.signal, async session => {
      if (args.options) {
        const next = { ...session.options, ...args.options };
        try {
          for (const current of session.pages.values()) {
            if (current.isClosed()) continue;
            await withPage(current, context, async () => { await current.setViewportSize({ width: next.viewportWidth, height: next.viewportHeight }); await current.emulateMedia({ colorScheme: next.colorScheme, reducedMotion: 'reduce' }); current.setDefaultTimeout(next.timeoutMs); snapshots.invalidate(current); });
          }
        } catch (error) {
          for (const current of [...session.pages.values()]) {
            if (current.isClosed()) continue;
            snapshots.invalidate(current);
            try { await current.setViewportSize({ width: session.options.viewportWidth, height: session.options.viewportHeight }); await current.emulateMedia({ colorScheme: session.options.colorScheme, reducedMotion: 'reduce' }); current.setDefaultTimeout(session.options.timeoutMs); }
            catch { await current.close().catch(() => {}); }
          }
          throw new Error(`Browser configuration failed; previous options restored to remaining tabs. ${safeDiagnosticText(String(error)).slice(0, 300)}`);
        }
        Object.assign(session.options, next);
      }
      return { sessionId: session.id, engine: session.engine, options: session.options };
    });
  });
  registry.add('browser_inspect', 'DevTools for AI. Inspect an element by snapshot ref, selector, or x/y viewport point without moving the cursor. Returns DOM, styles, bounds, states and overlay obstruction; snapshot provides native ARIA; performance returns page timings. Read-only; form values and scripts are omitted. Use narrow targets and optional CSS style names.', z.object({
    sessionId: z.string(), tabId: z.string().optional(), ...targetFields, view: z.enum(['element', 'dom', 'performance']).default('element'),
    x: z.number().min(0).max(100000).optional(), y: z.number().min(0).max(100000).optional(), depth: z.number().int().min(0).max(5).default(2), limit: z.number().int().min(1).max(100).default(20),
    styles: z.array(z.string().regex(/^[-a-z]+$/).max(70)).max(24).default(DEFAULT_STYLES), maxChars: maxCharsField,
    matchedRules: z.boolean().default(false).describe('Include matching readable CSS rules for the requested style names.'),
    probe: z.boolean().default(false).describe('Run Playwright click checks for up to 1.5s without clicking. May scroll the target into view; element view with ref/selector only.'),
  }).superRefine((args, ctx) => {
    if (args.ref && !args.snapshotId) ctx.addIssue({ code: 'custom', path: ['snapshotId'], message: 'A ref requires snapshotId from browser snapshot.' });
    if ((args.x === undefined) !== (args.y === undefined)) ctx.addIssue({ code: 'custom', path: ['x'], message: 'Provide both x and y.' });
    if (args.ref && args.selector || args.x !== undefined && (args.ref || args.selector)) ctx.addIssue({ code: 'custom', message: 'Choose one target: ref, selector, or x/y.' });
    if (args.probe && (args.view !== 'element' || args.x !== undefined || !args.ref && !args.selector)) ctx.addIssue({ code: 'custom', path: ['probe'], message: 'probe needs element view with ref or selector.' });
  }), true, async (args, context) => {
    await approve('browser_inspect', `Inspect browser ${args.view}; no page interaction.`, context);
    return withSession(args.sessionId, context.signal, async session => {
      const current = page(session, args.tabId);
      return withPage(current, context, async () => {
        let report: unknown;
        if (args.view === 'performance') report = await inspectPerformance(frame(current, args.frameId));
        else {
          const options = { view: args.view, depth: args.depth, limit: args.limit, styles: args.styles, matchedRules: args.matchedRules };
          if (args.x !== undefined && args.y !== undefined) {
            const handle = await frame(current, args.frameId).evaluateHandle(({ x, y }) => {
              let node = document.elementFromPoint(x, y);
              while (node?.shadowRoot) { const next = node.shadowRoot.elementFromPoint(x, y); if (!next || next === node) break; node = next; }
              return node;
            }, { x: args.x, y: args.y });
            try { const element = handle.asElement(); if (!element) throw new Error('No element at this viewport point.'); report = await element.evaluate(inspectElement, options); }
            finally { await handle.dispose(); }
          } else {
            const locator = args.ref || args.selector ? target(current, args) : frame(current, args.frameId).locator('body');
            let actionability: { clickable: boolean; reason?: string } | undefined;
            if (args.probe) {
              try { await locator.click({ trial: true, timeout: Math.min(1500, session.options.timeoutMs) }); actionability = { clickable: true }; }
              catch (error) { context.signal.throwIfAborted(); actionability = { clickable: false, reason: safeDiagnosticText(String(error)).slice(0, 700) }; }
            }
            report = { ...await locator.evaluate(inspectElement, options, { timeout: session.options.timeoutMs }) as Record<string, unknown>, ...(actionability ? { actionability } : {}) };
          }
        }
        return browserReport({ url: safeBrowserUrl(current.url()), view: args.view, data: report }, args.maxChars ?? session.options.maxChars);
      });
    });
  });
  registry.add('browser', 'Persistent headless browser. Start launch, then snapshot for compact ARIA elements; act with ref + snapshotId or an exact selector/text. since returns snapshot changes only. frames lists iframe IDs. console/network accept sinceId/filter; network defaults to errors, errorsOnly:false includes successful requests. Use browser_inspect for DOM/styles/performance and browser_configure for options. DOM actions need no screenshot or vision model. Interactions require BUILD and configured permission. Public HTTP(S) and explicitly approved loopback origins only. WebSockets use the same destination policy. Saved logins require the user command /browser-auth on.', z.object({
    action: z.enum(['launch', 'snapshot', 'frames', 'navigate', 'back', 'forward', 'reload', 'new_tab', 'activate_tab', 'close_tab', 'tabs', 'forms', 'links', 'console', 'network', 'click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'scroll', 'wait', 'text', 'screenshot', 'close', 'auth_states', 'save_auth', 'delete_auth']),
    allowLocal: z.boolean().default(false).describe('Launch only: allow exactly the supplied localhost/127.0.0.1/[::1] origin, including its port, after browser approval.'),
    authName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/).optional().describe('Opt-in encrypted project login state: load at launch, or save/delete by name. auth_states lists names only.'),
    indexedDB: z.boolean().default(false).describe('save_auth only: include IndexedDB if the site needs it for login; default cookies and localStorage only.'),
    secretEnv: z.string().regex(/^POLONRLM_BROWSER_SECRET_[A-Z0-9_]{1,70}$/).optional().describe('fill/type only: read this dedicated local environment variable instead of sending its value through the model.'),
    sessionId: z.string().optional(), tabId: z.string().optional(), url: z.string().max(4000).optional(), ...targetFields, text: z.string().max(10000).optional(), key: z.string().max(100).optional(), direction: z.enum(['up', 'down']).default('down'), amount: z.number().int().min(50).max(3000).default(700),
    timeoutMs: z.number().int().min(100).max(60000).optional(), limit: z.number().int().min(1).max(200).optional(), maxChars: maxCharsField,
    since: z.string().max(40).optional().describe('Previous snapshotId for compact changes.'), sinceId: z.number().int().nonnegative().optional().describe('Diagnostic cursor from previous console/network result.'), filter: z.string().max(100).optional(), errorsOnly: z.boolean().default(true),
  }).superRefine((args, context) => {
    const required = (field: 'url' | 'sessionId' | 'text' | 'key', condition: boolean) => { if (condition && (args[field] === undefined || args[field] === '')) context.addIssue({ code: 'custom', path: [field], message: `Action ${args.action} requires ${field}.` }); };
    required('sessionId', !['launch', 'auth_states', 'delete_auth'].includes(args.action)); required('url', ['launch', 'navigate'].includes(args.action));
    if (['fill', 'type', 'press', 'select', 'check', 'uncheck', 'wait', 'click'].includes(args.action) && !args.ref && !args.selector && !(args.action === 'click' && args.text)) context.addIssue({ code: 'custom', path: ['selector'], message: `${args.action} requires selector or ref + snapshotId${args.action === 'click' ? ' or exact text' : ''}.` });
    if (args.ref && !args.snapshotId) context.addIssue({ code: 'custom', path: ['snapshotId'], message: 'Provide snapshotId returned with the ref.' });
    if (args.ref && args.selector) context.addIssue({ code: 'custom', message: 'Use ref or selector, not both.' });
    required('text', ['fill', 'type', 'select'].includes(args.action) && args.text === undefined && !args.secretEnv); required('key', args.action === 'press');
    if (['save_auth', 'delete_auth'].includes(args.action) && !args.authName) context.addIssue({ code: 'custom', path: ['authName'], message: 'Provide the login state name.' });
    if (args.secretEnv && (!['fill', 'type'].includes(args.action) || args.text !== undefined)) context.addIssue({ code: 'custom', path: ['secretEnv'], message: 'Use secretEnv only for fill/type, without text.' });
  }), false, async (args, context) => {
    const action = args.action;
    const targetDescription = args.ref ?? args.selector ?? (action === 'click' ? args.text : undefined);
    await approve('browser', `Browser: ${action}${args.sessionId ? ` in session ${args.sessionId}` : ''}${targetDescription ? ` on ${safeDiagnosticText(targetDescription).slice(0, 200)}` : ''}${args.url ? ` ${safeBrowserUrl(args.url)}` : ''}${args.authName ? `; saved login state ${args.authName}` : ''}.${args.allowLocal ? ' This allows the exact local origin and port for this session.' : ''}${action === 'launch' ? ' A missing Playwright engine may be downloaded to the local cache.' : ''}`, context, mutating.includes(action));
    if (action === 'auth_states') return { available: !!dependencies.authStore, enabled: dependencies.authStore?.isEnabled() ?? false, states: dependencies.authStore?.isEnabled() ? await dependencies.authStore.list() : [], command: '/browser-auth on|off' };
    if (action === 'delete_auth') { await auth().remove(args.authName!); return 'Saved browser login state deleted. Active sessions remain signed in until closed or logged out.'; }
    if (action === 'launch') {
      const options = structuredClone(defaults());
      if (args.allowLocal) { if (!isLoopbackOrigin(args.url!)) throw new Error('allowLocal requires an exact localhost, 127.0.0.1 or [::1] HTTP(S) URL.'); if (!options.localOrigins.includes(new URL(args.url!).origin)) options.localOrigins.push(new URL(args.url!).origin); }
      await checkPublicURL(args.url!, options.localOrigins); await pruneExpired();
      const storageState = args.authName ? await auth().load(args.authName, options.localOrigins) : undefined;
      if (sessions.size + launches >= maxSessions) throw new Error(`Browser session limit reached (${maxSessions}).`);
      launches++;
      try {
      const proxy = await createProxy(undefined, options.localOrigins); let browser: Browser, selectedEngine: Exclude<BrowserEngine, 'auto'>;
      try { ({ browser, engine: selectedEngine } = await openBrowser(engine(), proxy.url, context.signal)); } catch (error) { await proxy.close(); throw error; }
      try {
        const browserContext = await browser.newContext({ acceptDownloads: false, serviceWorkers: options.serviceWorkers, ...(storageState ? { storageState } : {}), viewport: { width: options.viewportWidth, height: options.viewportHeight }, locale: options.locale, timezoneId: options.timezoneId, colorScheme: options.colorScheme, reducedMotion: 'reduce' });
        const session: Session = { id: randomUUID().slice(0, 10), engine: selectedEngine, browser, proxy, context: browserContext, pages: new Map(), active: '', touched: Date.now(), options, pending: Promise.resolve() };
        await browserContext.routeWebSocket('**/*', async socket => {
          try { if (!options.webSockets) throw new Error('WebSockets disabled.'); const url = new URL(socket.url()); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; await checkPublicURL(url.href, options.localOrigins); socket.connectToServer(); }
          catch { socket.close({ code: 1008, reason: 'Destination blocked by browser policy.' }); }
        });
        await browserContext.route('**/*', async route => {
          try {
            const request = route.request(), requestUrl = request.url();
            if (/^(data|blob|about):/i.test(requestUrl)) { await route.continue(); return; }
            await checkPublicURL(requestUrl, options.localOrigins);
            if (session.options.blockedResources.includes(request.resourceType() as 'image' | 'media' | 'font')) { await route.abort('blockedbyclient'); return; }
            await route.continue();
          } catch { await route.abort().catch(() => {}); }
        });
        const first = await browserContext.newPage(), tabId = trackPage(session, first); session.active = tabId;
        await withPage(first, context, () => first.goto(args.url!, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs }));
        browserContext.on?.('page', next => { if (session.pages.size >= maxTabs) { void next.close().catch(() => {}); return; } trackPage(session, next); });
        sessions.set(session.id, session);
        return JSON.stringify({ sessionId: session.id, tabId, engine: selectedEngine, url: safeBrowserUrl(first.url()), title: safeDiagnosticText(await first.title()) });
      } catch (error) { try { await browser.close(); } finally { await proxy.close(); } throw error; }
      } finally { launches--; }
    }
    return withSession(args.sessionId!, context.signal, async session => {
      if (action === 'save_auth') { const store = auth(); if (!store.isEnabled()) throw new Error('Persistent browser login is disabled. Ask the user to enable /browser-auth on; do not bypass this setting.'); await store.save(args.authName!, await session.context.storageState({ indexedDB: args.indexedDB }), session.options.localOrigins); return `Saved encrypted browser login state ${args.authName}. Use authName on a future launch; server expiry and MFA rules still apply.`; }
      if (action === 'close') { await close(session.id); return 'Browser session closed.'; }
      if (action === 'tabs') return JSON.stringify(await Promise.all([...session.pages].map(([id, p]) => summarizeBrowserTab(id, p, id === session.active))));
      if (action === 'new_tab') {
        if (session.pages.size >= maxTabs) throw new Error(`Tab limit reached for this session (${maxTabs}).`);
        if (args.url) await checkPublicURL(args.url, session.options.localOrigins);
        const next = await session.context.newPage(), id = trackPage(session, next);
        try {
          await withPage(next, context, async () => {
            if (args.url) await next.goto(args.url, { waitUntil: 'domcontentloaded', timeout: session.options.navigationTimeoutMs });
          });
          session.active = id; return JSON.stringify({ tabId: id, url: safeBrowserUrl(next.url()), title: safeDiagnosticText(await next.title()) });
        }
        catch (error) { session.pages.delete(id); await next.close().catch(() => {}); throw error; }
      }
      if (action === 'activate_tab') { page(session, args.tabId); return `Active tab: ${session.active}`; }
      if (action === 'close_tab') { const active = page(session, args.tabId), id = session.active; await active.close(); session.pages.delete(id); if (!session.pages.size) { await close(session.id); return 'Last tab closed; session ended.'; } session.active = session.pages.keys().next().value!; return `Tab closed. Active: ${session.active}`; }
      const current = page(session, args.tabId), timeout = args.timeoutMs ?? session.options.timeoutMs, maxChars = args.maxChars ?? session.options.maxChars;
      return withPage(current, context, async () => {
        if (['navigate', 'back', 'forward', 'reload'].includes(action)) {
          const options = { waitUntil: 'domcontentloaded' as const, timeout: args.timeoutMs ?? session.options.navigationTimeoutMs };
          if (action === 'navigate') { await checkPublicURL(args.url!, session.options.localOrigins); await current.goto(args.url!, options); } else if (action === 'back') await current.goBack(options); else if (action === 'forward') await current.goForward(options); else await current.reload(options);
          snapshots.invalidate(current); return JSON.stringify({ url: safeBrowserUrl(current.url()), title: safeDiagnosticText(await current.title()) });
        }
        if (action === 'frames') return browserReport({ frames: current.frames().map(item => ({ frameId: frameId(item), name: item.name(), url: safeBrowserUrl(item.url()), main: item === current.mainFrame(), parentId: item.parentFrame() ? frameId(item.parentFrame()!) : null })) }, maxChars);
        if (action === 'snapshot') { const root = args.frameId ? frame(current, args.frameId).locator(args.selector ?? 'body') : current.locator(args.selector ?? 'body'); return snapshots.capture(current, root, `${args.frameId ?? 'main'}:${args.selector ?? 'body'}`, args.limit ?? session.options.snapshotElements, maxChars, timeout, context.signal, args.since); }
        if (action === 'text') { const body = safeDiagnosticText(await (args.ref || args.selector ? target(current, args) : frame(current, args.frameId).locator('body')).innerText({ timeout })); return `${safeBrowserUrl(current.url())}\n${body.slice(0, maxChars)}${body.length > maxChars ? '\n[truncated; narrow selector or raise maxChars]' : ''}`; }
        if (action === 'console' || action === 'network') {
          const state = diagnostics.get(current);
          let entries: (ConsoleEntry | NetworkEntry)[] = action === 'console' ? state?.console ?? [] : state?.network ?? [];
          if (action === 'network' && args.errorsOnly) entries = entries.filter(item => 'error' in item || 'status' in item && (item.status ?? 0) >= 400 || 'kind' in item && item.kind === 'failed');
          if (args.sinceId !== undefined) entries = entries.filter(item => item.id > args.sinceId!);
          if (args.filter) entries = entries.filter(item => JSON.stringify(item).toLowerCase().includes(args.filter!.toLowerCase()));
          const limit = Math.min(args.limit ?? 30, 50);
          const incremental = args.sinceId !== undefined;
          let selected = incremental ? entries.slice(0, limit) : entries.slice(-limit);
          const report = () => ({ url: safeBrowserUrl(current.url()),
            cursor: selected.length && incremental && selected.length < entries.length ? selected.at(-1)!.id : state?.sequence ?? 0,
            total: entries.length, truncated: entries.length > selected.length, entries: selected,
          });
          while (selected.length && JSON.stringify(report()).length > maxChars) selected = incremental ? selected.slice(0, -1) : selected.slice(1);
          return JSON.stringify(report());
        }
        if (action === 'forms') return JSON.stringify((await current.locator('input, textarea, select, button').evaluateAll((elements: Element[]) => elements.slice(0, 100).map(element => { const field = element as HTMLInputElement; return { tag: element.tagName.toLowerCase(), type: field.type ?? '', name: field.name ?? '', id: field.id, label: (field.labels?.[0]?.innerText ?? field.getAttribute('aria-label') ?? '').slice(0, 200), placeholder: field.placeholder ?? '', required: field.required ?? false, options: element instanceof HTMLSelectElement ? Array.from(element.options).slice(0, 50).map(option => ({ label: option.label, value: option.value })) : undefined }; }))));
        if (action === 'links') return JSON.stringify(await current.locator('a[href]').evaluateAll((elements: HTMLAnchorElement[]) => elements.slice(0, 100).filter(anchor => /^https?:/.test(anchor.href)).map(anchor => { const url = new URL(anchor.href); url.search = ''; url.hash = ''; url.username = ''; url.password = ''; return { text: (anchor.innerText || anchor.getAttribute('aria-label') || '').trim().slice(0, 200), url: url.href }; })));
        if (action === 'screenshot') { if (context.vision === false) throw new Error('browser screenshot requires a vision model. Use snapshot and browser_inspect with a text-only model.'); const bytes = await current.screenshot({ type: 'jpeg', quality: 72, animations: 'disabled', timeout }); context.onImage?.({ data: bytes.toString('base64'), mediaType: 'image/jpeg' }); return `Screenshot of tab ${session.active}: ${safeBrowserUrl(current.url())} (${bytes.length} image bytes).`; }
        if (action === 'scroll') { await frame(current, args.frameId).evaluate(amount => window.scrollBy({ top: amount, behavior: 'instant' }), args.direction === 'down' ? args.amount : -args.amount); return `Scrolled ${args.direction}.`; }
        const locator = target(current, args);
        const inputText = args.secretEnv ? process.env[args.secretEnv] : args.text;
        if (args.secretEnv) { if (!inputText) throw new Error('Dedicated browser secret environment variable is empty or missing.'); registerSecret(inputText); }
        if (action === 'wait') { await locator.waitFor({ state: 'visible', timeout }); return 'Element is visible.'; }
        if (action === 'press') { await locator.press(args.key!, { timeout }); return 'Key sent.'; }
        if (action === 'click') { await locator.click({ timeout }); return 'Clicked element.'; }
        if (action === 'fill') { await locator.fill(inputText!, { timeout }); return 'Form field updated.'; }
        if (action === 'type') { await locator.pressSequentially(inputText!, { delay: 20, timeout }); return 'Text entered.'; }
        if (action === 'select') { await locator.selectOption(args.text!, { timeout }); return 'Option selected.'; }
        if (action === 'check') { await locator.check({ timeout }); return checkboxStatus(action); }
        if (action === 'uncheck') { await locator.uncheck({ timeout }); return checkboxStatus(action); }
        throw new Error('Unsupported browser action.');
      });
    });
  }, args => mutating.includes(args.action));
}
