import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { defaultSettings } from '../src/core/config.js';
import { Permissions } from '../src/core/permissions.js';
import { registerBuiltins } from '../src/tools/builtin.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { Workspace } from '../src/tools/workspace.js';
import type { ToolContext } from '../src/tools/registry.js';

// Probe Chromium directly first. The app's browser launcher can install a
// missing engine, but this check must never download one implicitly.
const probe = await chromium.launch({ headless: true });
await probe.close();

const root = await mkdtemp(path.join(tmpdir(), 'polon-browser-tools-'));
const settings = { ...defaultSettings(), browserEngine: 'auto' as const, mode: 'BUILD' as const, permissions: 'workspace' as const, toolPermissions: { browser: 'auto' as const, browser_automation: 'auto' as const } };
const permissions = new Permissions(settings);
const workspace = await Workspace.open(root, permissions);
const registry = new ToolRegistry(permissions, settings.toolOutputLimit);
registerBuiltins(registry, workspace, settings, { computer: false });
let screenshots = 0;
const context: ToolContext = { mode: 'BUILD', signal: AbortSignal.timeout(120_000), vision: true, onImage: image => { assert.equal(image.mediaType, 'image/jpeg'); screenshots++; } };
const checks: { tool: string; action: string; ms: number }[] = [];
async function call(tool: string, action: string, args: Record<string, unknown>): Promise<string> {
  const start = Date.now();
  const result = await registry.execute(tool, args, context);
  checks.push({ tool, action, ms: Date.now() - start });
  return result;
}

try {
  const opened = JSON.parse(await call('browser', 'launch', { action: 'launch', url: 'https://example.com' }));
  assert.ok(['chromium', 'chrome', 'edge', 'brave', 'firefox'].includes(opened.engine));
  assert.match(opened.url, /^https:\/\/example\.com\/?$/);
  assert.match(opened.title, /Example Domain/);
  const sessionId = opened.sessionId as string;
  const firstTab = opened.tabId as string;

  const listed = JSON.parse(await call('browser_sessions', 'list', {}));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, sessionId);
  assert.equal(listed[0].engine, opened.engine);
  const tabs = JSON.parse(await call('browser', 'tabs', { action: 'tabs', sessionId }));
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].id, firstTab);
  assert.match(await call('browser', 'text', { action: 'text', sessionId }), /This domain is for use in documentation examples/);
  assert.ok(Array.isArray(JSON.parse(await call('browser', 'forms', { action: 'forms', sessionId }))));
  assert.ok(JSON.parse(await call('browser', 'links', { action: 'links', sessionId })).length > 0);
  assert.match(await call('browser', 'wait', { action: 'wait', sessionId, selector: 'body', timeoutMs: 5000 }), /Element is visible/);
  assert.match(await call('browser', 'screenshot', { action: 'screenshot', sessionId, timeoutMs: 10000 }), /image bytes/);
  assert.equal(screenshots, 1);

  const secondTab = JSON.parse(await call('browser', 'new_tab', { action: 'new_tab', sessionId, url: 'https://example.org' }));
  assert.match(secondTab.title, /Example Domain/);
  assert.equal(JSON.parse(await call('browser', 'tabs', { action: 'tabs', sessionId })).length, 2);
  await call('browser', 'activate_tab', { action: 'activate_tab', sessionId, tabId: firstTab });
  assert.match(JSON.parse(await call('browser', 'navigate', { action: 'navigate', sessionId, url: 'https://example.org' })).title, /Example Domain/);
  assert.match(JSON.parse(await call('browser', 'back', { action: 'back', sessionId })).url, /example\.com/);
  assert.match(JSON.parse(await call('browser', 'forward', { action: 'forward', sessionId })).url, /example\.org/);
  assert.match(JSON.parse(await call('browser', 'reload', { action: 'reload', sessionId })).title, /Example Domain/);
  await call('browser', 'close_tab', { action: 'close_tab', sessionId, tabId: secondTab.tabId });

  const formTab = JSON.parse(await call('browser', 'new_tab', { action: 'new_tab', sessionId, url: 'https://httpbin.org/forms/post' }));
  const formFields = JSON.parse(await call('browser', 'forms', { action: 'forms', sessionId }));
  assert.ok(formFields.some((field: { name: string }) => field.name === 'custname'));
  assert.ok(formFields.some((field: { type: string }) => field.type === 'checkbox'));
  assert.match(await call('browser', 'fill', { action: 'fill', sessionId, selector: 'input[name="custname"]', text: 'PolonRLM smoke test' }), /Form field updated/);
  assert.match(await call('browser', 'type', { action: 'type', sessionId, selector: 'input[name="custtel"]', text: '5550100' }), /Text entered/);
  assert.match(await call('browser', 'press', { action: 'press', sessionId, selector: 'input[name="custname"]', key: 'End' }), /Key sent/);
  assert.equal(await call('browser', 'check', { action: 'check', sessionId, selector: 'input[name="topping"][value="cheese"]' }), 'Checkbox selected.');
  assert.equal(await call('browser', 'uncheck', { action: 'uncheck', sessionId, selector: 'input[name="topping"][value="cheese"]' }), 'Checkbox cleared.');
  assert.match(await call('browser', 'scroll', { action: 'scroll', sessionId, direction: 'down', amount: 250 }), /Scrolled down/);
  assert.match(await call('browser', 'click', { action: 'click', sessionId, selector: 'fieldset:first-of-type legend' }), /Clicked element/);
  await call('browser', 'close_tab', { action: 'close_tab', sessionId, tabId: formTab.tabId });

  const selectTab = JSON.parse(await call('browser', 'new_tab', { action: 'new_tab', sessionId, url: 'https://www.selenium.dev/selenium/web/selectPage.html' }));
  assert.match(selectTab.title, /Selection test page/);
  assert.match(await call('browser', 'select', { action: 'select', sessionId, selector: '#selectWithoutMultiple', text: 'two' }), /Option selected/);
  await call('browser', 'close_tab', { action: 'close_tab', sessionId, tabId: selectTab.tabId });
  await call('browser', 'close', { action: 'close', sessionId });
  assert.deepEqual(JSON.parse(await call('browser_sessions', 'list', {})), []);

  assert.match(await call('browser_automation', 'text', { url: 'https://example.com', action: 'text' }), /This domain is for use in documentation examples/);
  const screenshotPath = 'agent_workspace/browser-smoke.png';
  await call('browser_automation', 'screenshot', { url: 'https://example.com', action: 'screenshot', output: screenshotPath });
  const saved = await workspace.resolve(screenshotPath);
  assert.ok((await stat(saved)).size > 1000);
  assert.equal((await readFile(saved)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.match(await call('browser_automation', 'click', { url: 'https://example.com', action: 'click', selector: 'a' }), /This domain is for use in documentation examples|iana\.org/i);

  console.log(JSON.stringify({ engine: 'chromium', preflight: 'passed; no install attempted', screenshots, checks }, null, 2));
} finally {
  await registry.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
