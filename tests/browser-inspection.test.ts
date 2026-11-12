import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium, type Browser } from 'playwright';
import { browserOptionsSchema, defaultBrowserOptions } from '../src/core/browser-config.js';
import { defaultSettings, settingsSchema } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { registerBrowserSessionTools } from '../src/tools/browser-session.js';
import { browserReport } from '../src/tools/browser-output.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Workspace } from '../src/tools/workspace.js';

test('browser settings validate defaults, merge partial config, and reject unsafe options', () => {
  assert.equal(defaultBrowserOptions().maxChars, 6000);
  assert.equal(settingsSchema.parse(defaultSettings()).browserOptions.viewportWidth, 1365);
  assert.equal(browserOptionsSchema.parse({ viewportWidth: 1440 }).timeoutMs, 10000);
  for (const options of [{ viewportWidth: 20 }, { locale: 'bad_locale' }, { timezoneId: 'Invalid/Zone' }, { timeoutMs: 0 }, { blockedResources: ['script'] }, { blockedResources: ['image', 'image'] }, { executablePath: 'custom.exe' }]) assert.equal(browserOptionsSchema.safeParse(options).success, false);
});

test('bounded browser output remains valid JSON and redacts diagnostic secrets', () => {
  const value = JSON.parse(browserReport({ sessionId: 'session', entries: Array.from({ length: 50 }, () => ({ text: 'password=hidden Bearer abcdefghijkl ' + 'x'.repeat(300), url: 'https://example.org/data?token=hidden' })) }, 1000));
  assert.equal(value.sessionId, 'session'); assert.equal(value.truncated, true);
  assert.ok(JSON.stringify(value).length <= 1000);
  assert.doesNotMatch(JSON.stringify(value), /hidden|abcdefghijkl/);
});

const html = `<!doctype html><html><head><title>Browser workbench</title><style>
body{font-family:Arial;margin:20px} iframe{display:block;margin-top:240px} #covered{position:absolute;top:180px;left:20px;width:140px;height:40px} #cover{position:absolute;top:180px;left:20px;width:140px;height:40px;background:gray;z-index:9}
</style></head><body>
<h1>Workbench</h1><label for="query">Search docs</label><input id="query" value="private-field-value">
<label>Password<input type="password" value="hidden-password-value"></label><textarea>private-textarea-value</textarea>
<button id="save" onclick="document.getElementById('result').textContent='Saved successfully'">Save changes</button><button disabled>Disabled action</button>
<button class="duplicate" onclick="window.duplicateClicks=(window.duplicateClicks||0)+1">Duplicate</button><button class="duplicate" onclick="window.duplicateClicks=(window.duplicateClicks||0)+1">Duplicate</button>
<button id="covered">Covered action</button><div id="cover">Overlay</div><output id="result"></output>
<a href="/popup" target="_blank">Open popup</a><div id="host"></div><iframe title="Embedded content" src="/frame"></iframe>
<script>document.getElementById('host').attachShadow({mode:'open'}).innerHTML='<button id="shadow">Shadow action</button>'; console.warn('api_key=fixture-secret');</script>
</body></html>`;

test('real headless browser supports compact snapshots, DevTools inspection and reliable actions', { timeout: 60000 }, async t => {
  try { const probe = await chromium.launch({ headless: true }); await probe.close(); }
  catch (error) {
    if (!/Executable doesn't exist/i.test(String(error)) || process.env.POLONRLM_BROWSER_TEST_REQUIRED === '1') throw error;
    t.skip('Playwright Chromium is not installed; no implicit download.'); return;
  }
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/failure')) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('Unavailable'); }
    else if (req.url === '/frame') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h2>Frame</h2><button onclick="this.textContent=\'Frame clicked\'">Frame action</button>'); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'polon-inspect-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const settings = { ...defaultSettings(), permissions: 'all' as const }, permissions = new Permissions(settings);
  const registry = new ToolRegistry(permissions, 0), workspace = await Workspace.open(root, permissions);
  let native: Browser;
  registerBrowserSessionTools(registry, workspace, () => 'chromium', {
    // This deterministic fixture alone bypasses public-address checks. Production remains protected.
    launchBrowser: async () => { native = await chromium.launch({ headless: true }); return { browser: native, engine: 'chromium' }; },
    createSafeEgressProxy: async () => ({ url: 'unused-fixture-proxy', close: async () => {} }), publicURL: async () => {},
  });
  t.after(() => registry.close());
  const context = { mode: 'BUILD' as const, signal: AbortSignal.timeout(50000), vision: false };
  const launch = JSON.parse(await registry.execute('browser', { action: 'launch', url: base }, context)), sessionId = launch.sessionId;
  const call = (action: string, args: Record<string, unknown> = {}) => registry.execute('browser', { sessionId, action, ...args }, context);
  const inspect = async (args: Record<string, unknown>) => JSON.parse(await registry.execute('browser_inspect', { sessionId, ...args }, context));
  let first: any;

  await t.test('native snapshot refs work without images and hide field values', async () => {
    first = JSON.parse(await call('snapshot'));
    assert.ok(first.elements.some((item: any) => item.role === 'button' && item.name === 'Save changes' && item.ref));
    assert.ok(first.elements.some((item: any) => item.name === 'Shadow action'));
    assert.doesNotMatch(JSON.stringify(first), /private-field-value|hidden-password-value|private-textarea-value/);
    const unchanged = await call('snapshot', { since: first.snapshotId });
    assert.equal(JSON.parse(unchanged).unchanged, true); assert.ok(unchanged.length < 100);
  });
  await t.test('inspector returns computed CSS, state and precise overlay information', async () => {
    const save = first.elements.find((item: any) => item.name === 'Save changes');
    const element = await inspect({ ref: save.ref, snapshotId: first.snapshotId, styles: ['font-family', 'display'] });
    assert.equal(element.data.tag, 'button'); assert.equal(element.data.state.visible, true);
    assert.match(element.data.styles['font-family'], /Arial/);
    const covered = await inspect({ selector: '#covered' });
    assert.equal(covered.data.state.receivesPointer, false); assert.equal(covered.data.blockedBy.attributes.id, 'cover');
    const rules = await inspect({ selector: '#covered', matchedRules: true, styles: ['position', 'width'] });
    assert.ok(rules.data.matchedRules.some((rule: any) => rule.selector === '#covered' && rule.properties.position === 'absolute'));
    const probe = await inspect({ selector: '#save', probe: true }); assert.equal(probe.data.actionability.clickable, true);
    assert.equal(await native!.contexts()[0]!.pages()[0]!.locator('#result').innerText(), '', 'trial actionability never clicks');
    const point = await inspect({ x: 30, y: 190 }); assert.equal(point.data.attributes.id, 'cover');
    const disabled = await inspect({ selector: 'button:disabled' }); assert.equal(disabled.data.state.disabled, true);
    const tree = await inspect({ view: 'dom', selector: '#host', depth: 3 }); assert.match(JSON.stringify(tree), /Shadow action/);
    const dom = await inspect({ view: 'dom', depth: 3, limit: 100, maxChars: 15000 });
    assert.doesNotMatch(JSON.stringify(dom), /private-field-value|hidden-password-value|private-textarea-value|onclick|attachShadow/);
  });
  await t.test('DOM inspection preserves actionable refs and deltas describe only changes', async () => {
    await inspect({ view: 'dom', selector: '#save', depth: 4 });
    const save = first.elements.find((item: any) => item.name === 'Save changes');
    await call('click', { ref: save.ref, snapshotId: first.snapshotId });
    const change = JSON.parse(await call('snapshot', { since: first.snapshotId }));
    assert.equal(change.delta, true); assert.match(JSON.stringify(change), /Saved successfully/);
    await assert.rejects(call('click', { ref: save.ref, snapshotId: first.snapshotId }), /Stale or unknown/);
  });
  await t.test('iframe scopes and their refs address the correct document', async () => {
    const frames = JSON.parse(await call('frames')).frames, child = frames.find((item: any) => !item.main);
    assert.ok(child?.frameId);
    const snapshot = JSON.parse(await call('snapshot', { frameId: child.frameId }));
    const button = snapshot.elements.find((item: any) => item.name === 'Frame action'); assert.ok(button?.ref);
    await call('click', { ref: button.ref, snapshotId: snapshot.snapshotId });
    assert.match(await call('text', { frameId: child.frameId }), /Frame clicked/);
    const childInspect = await inspect({ selector: 'button', frameId: child.frameId }); assert.equal(childInspect.data.tag, 'button');
  });
  await t.test('ambiguous text never silently selects the first element', async () => {
    await assert.rejects(call('click', { text: 'Duplicate', timeoutMs: 1000 }), /ambiguous/);
    assert.equal(await native!.contexts()[0]!.pages()[0]!.evaluate(() => (window as any).duplicateClicks ?? 0), 0);
  });
  await t.test('network and console support redaction, filtering and incremental cursors', async () => {
    const page = native!.contexts()[0]!.pages()[0]!;
    await page.evaluate(async () => { await fetch('/failure?token=network-secret'); console.error('Bearer confidential-value'); });
    const logs = JSON.parse(await call('console')); assert.ok(logs.total >= 2);
    assert.doesNotMatch(JSON.stringify(logs), /fixture-secret|confidential-value/);
    assert.equal(JSON.parse(await call('console', { sinceId: logs.cursor })).entries.length, 0);
    await page.evaluate(() => { for (let index = 0; index < 5; index++) console.log('incremental diagnostic ' + index); });
    let cursor = logs.cursor; const seen: string[] = [];
    for (let index = 0; index < 3; index++) { const batch = JSON.parse(await call('console', { sinceId: cursor, limit: 2 })); seen.push(...batch.entries.map((entry: any) => entry.text)); cursor = batch.cursor; }
    assert.equal(seen.length, 5); assert.equal(new Set(seen).size, 5, 'incremental pages neither repeat nor silently skip matching entries');
    const errors = JSON.parse(await call('network', { filter: 'failure' })); assert.equal(errors.entries[0].status, 503);
    assert.doesNotMatch(JSON.stringify(errors), /network-secret/);
    assert.ok(JSON.parse(await call('network', { errorsOnly: false })).entries.some((item: any) => item.status === 200));
    const performance = await inspect({ view: 'performance' }); assert.ok(performance.data.domElements > 5); assert.ok(performance.data.resources.count > 0);
  });
  await t.test('configuration applies and reloads invalidate old refs even on identical pages', async () => {
    const config = JSON.parse(await registry.execute('browser_configure', { sessionId, options: { viewportWidth: 900, viewportHeight: 700, blockedResources: ['image', 'media'], maxChars: 2000 } }, context));
    assert.equal(config.options.viewportWidth, 900);
    assert.equal((await inspect({ view: 'performance' })).data.viewport.width, 900);
    const tab = JSON.parse(await call('new_tab', { url: base }));
    assert.equal((await inspect({ view: 'performance' })).data.viewport.width, 900, 'new tabs inherit session overrides');
    const tabPage = native!.contexts()[0]!.pages()[1]!, setter = tabPage.setViewportSize.bind(tabPage);
    tabPage.setViewportSize = async size => { if (size.width === 901) throw new Error('Fixture configuration failure'); return setter(size); };
    try {
      await assert.rejects(registry.execute('browser_configure', { sessionId, options: { viewportWidth: 901 } }, context), /previous options restored/);
      for (const existing of native!.contexts()[0]!.pages()) assert.equal(existing.viewportSize()?.width, 900);
      assert.equal(JSON.parse(await registry.execute('browser_configure', { sessionId }, context)).options.viewportWidth, 900);
    } finally { tabPage.setViewportSize = setter; }
    await call('close_tab', { tabId: tab.tabId });
    const before = JSON.parse(await call('snapshot', { maxChars: 1000 })); assert.ok(JSON.stringify(before).length <= 1000);
    await call('reload');
    const after = JSON.parse(await call('snapshot', { maxChars: 1000 })); assert.notEqual(after.snapshotId, before.snapshotId);
    const ref = before.elements.find((item: any) => item.role === 'button');
    if (ref) await assert.rejects(call('click', { ref: ref.ref, snapshotId: before.snapshotId }), /Stale or unknown/);
  });
  await t.test('concurrent actions in a session run in their original order', async () => {
    await Promise.all([call('fill', { selector: '#query', text: 'first' }), call('fill', { selector: '#query', text: 'second' })]);
    assert.equal(await native!.contexts()[0]!.pages()[0]!.locator('#query').inputValue(), 'second');
  });
  await t.test('popups become managed tabs and cancellation closes the pending action tab', async () => {
    const current = native!.contexts()[0]!.pages()[0]!;
    const popup = current.waitForEvent('popup'); await call('click', { selector: 'a[target="_blank"]' }); await popup;
    assert.equal(JSON.parse(await call('tabs')).length, 2);
    const controller = new AbortController();
    const pending = registry.execute('browser', { sessionId, action: 'click', selector: '#not-present', timeoutMs: 30000 }, { ...context, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('Fixture cancellation')), 50);
    await assert.rejects(pending, /Fixture cancellation/);
    assert.equal(JSON.parse(await call('tabs')).length, 1, 'other tabs remain available');
  });
});
