import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FAILED = Symbol('failed');

function attempt(run) {
  try {
    return run();
  } catch {
    return FAILED;
  }
}

function rejectsTypeError(run) {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

export async function grade(root) {
  try {
    const { escapeHtml } = await import(
      pathToFileURL(path.join(root, 'src', 'escape-html.js')).href + `?grade=${Date.now()}`
    );
    const checks = [
      attempt(() => escapeHtml('')) === '',
      attempt(() => escapeHtml('plain text 123')) === 'plain text 123',
      attempt(() => escapeHtml('&')) === '&amp;',
      attempt(() => escapeHtml('<')) === '&lt;',
      attempt(() => escapeHtml('>')) === '&gt;',
      attempt(() => escapeHtml('"')) === '&quot;',
      attempt(() => escapeHtml("'")) === '&#39;',
      attempt(() => escapeHtml('<a href="x">Tom & Jerry\'s</a>')) === '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;',
      attempt(() => escapeHtml('&amp;')) === '&amp;amp;',
      attempt(() => escapeHtml('a < b && c > d')) === 'a &lt; b &amp;&amp; c &gt; d',
      attempt(() => escapeHtml('café ✓ 日本')) === 'café ✓ 日本',
      attempt(() => escapeHtml('line1\nline2')) === 'line1\nline2',
      attempt(() => escapeHtml('<<>>')) === '&lt;&lt;&gt;&gt;',
      attempt(() => escapeHtml('&lt;')) === '&amp;lt;',
      attempt(() => typeof escapeHtml('<')) === 'string',
    ];
    let rejected = 0;
    for (const run of [
      () => escapeHtml(42),
      () => escapeHtml(null),
      () => escapeHtml(undefined),
      () => escapeHtml(['<']),
      () => escapeHtml({}),
    ]) {
      if (rejectsTypeError(run)) rejected += 1;
    }
    checks.push(rejected === 5);
    const passed = checks.every(Boolean);
    return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
