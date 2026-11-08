import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execa } from 'execa';
import { networkPython } from '../src/tools/network.js';
import { defaultSettings, settingsSchema } from '../src/core/config.js';
import { parseTokenBudget, tokenBudgetMaximum } from '../src/core/budget.js';
import { transcriptLines } from '../src/ui/transcript.js';
import { scrollbarMetrics } from '../src/ui/scrollbar.js';
import { browserEngineOrder, browserSetupHint } from '../src/tools/browser-launcher.js';

test('local worker validates DNS, redirects, parsing, ranking, downloads and compact schemas', { skip: !existsSync(networkPython()), timeout: 15000 }, async () => {
  const result = await execa(networkPython(), ['tests/local_web_test.py'], { windowsHide: true, timeout: 12000, reject: false });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});
test('unlimited tokens are JSON-safe and preserve explicit finite budgets', () => {
  assert.equal(defaultSettings().tokenBudget, 0);
  assert.equal(tokenBudgetMaximum(0), Infinity);
  assert.equal(parseTokenBudget('infinity'), 0);
  assert.equal(parseTokenBudget('∞'), 0);
  assert.equal(settingsSchema.parse({ ...defaultSettings(), tokenBudget: null }).tokenBudget, 0);
  assert.equal(settingsSchema.parse({ ...defaultSettings(), tokenBudget: 12000 }).tokenBudget, 12000);
  assert.throws(() => parseTokenBudget('-1'));
  assert.throws(() => parseTokenBudget('500'));
  assert.equal(JSON.parse(JSON.stringify(defaultSettings())).tokenBudget, 0);
});
test('legacy DuckDuckGo search settings migrate to local automatic search', () => {
  assert.equal(settingsSchema.parse({ ...defaultSettings(), webSearchMode: 'duckduckgo' }).webSearchMode, 'auto');
  assert.equal(settingsSchema.parse({ ...defaultSettings(), webSearchMode: 'yahoo' }).webSearchMode, 'yahoo');
});
test('browser selection defaults to portable auto and supports explicit installed engines', () => {
  assert.equal(defaultSettings().browserEngine, 'auto');
  assert.deepEqual(browserEngineOrder('auto'), ['chromium', 'chrome', 'edge', 'brave', 'firefox']);
  assert.match(browserSetupHint('chromium'), /playwright install chromium/);
  assert.match(browserSetupHint('firefox'), /playwright install firefox/);
  assert.match(browserSetupHint('chrome'), /Google Chrome/);
  assert.match(browserSetupHint('edge'), /Microsoft Edge/);
  assert.match(browserSetupHint('brave'), /POLONRLM_BRAVE_PATH/);
  for (const engine of ['chromium', 'chrome', 'edge', 'brave', 'firefox'] as const) {
    assert.deepEqual(browserEngineOrder(engine), [engine]);
    assert.equal(settingsSchema.parse({ ...defaultSettings(), browserEngine: engine }).browserEngine, engine);
    assert.match(browserSetupHint(engine), /Install/);
  }
  assert.throws(() => settingsSchema.parse({ ...defaultSettings(), browserEngine: 'safari' }));
});
test('forty web operations stay compact while failures remain visible and details can expand', () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: 'tool', text: '', toolName: 'read_webpage', toolCallId: `read-${i}`, toolState: i === 20 ? 'error' as const : 'done' as const, toolDetail: `Odczyt strony: https://example.org/${i}`, toolOutput: i === 20 ? 'HTTP 429' : 'Full content of the source' }));
  const lines = transcriptLines(messages, 72);
  assert.ok(lines.length <= 5);
  assert.match(lines.map(line => line.text).join('\n'), /40 operations.*errors: 1/);
  assert.match(lines.map(line => line.text).join('\n'), /HTTP 429/);
  const expanded = transcriptLines(messages, 72, new Set(['group:read-0', 'read-3']));
  assert.match(expanded.map(line => line.text).join('\n'), /Full content of the source/);
});
test('scrollbar maps top and bottom to the whole conversation range', () => {
  assert.equal(scrollbarMetrics(200, 20, 0).top, 0);
  const bottom = scrollbarMetrics(200, 20, 180);
  assert.equal(bottom.top + bottom.size, 20);
  assert.equal(bottom.maximum, 180);
  assert.equal(scrollbarMetrics(5, 20, 0).maximum, 0);
});
