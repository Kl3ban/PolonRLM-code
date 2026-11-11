import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push({ name, ok: true });
    } catch {
      checks.push({ name, ok: false });
    }
  };

  try {
    const { safeJsonParse } = await import(pathToFileURL(path.join(root, 'src', 'safe-json-parse.js')).href + `?grade=${Date.now()}`);
    check('exports safeJsonParse', () => assert.equal(typeof safeJsonParse, 'function'));
    check('parses valid JSON values', () => {
      assert.deepEqual(safeJsonParse('{"a":1,"b":[true,null]}'), { a: 1, b: [true, null] });
      assert.deepEqual(safeJsonParse('[1,2,3]'), [1, 2, 3]);
      assert.equal(safeJsonParse('null'), null);
      assert.equal(safeJsonParse('false'), false);
      assert.equal(safeJsonParse('0'), 0);
      assert.equal(safeJsonParse('""'), '');
      assert.equal(safeJsonParse(' "x" '), 'x');
      assert.equal(safeJsonParse('1e3'), 1000);
    });
    check('uses the last duplicate object key', () => {
      assert.deepEqual(safeJsonParse('{"a":1,"a":2}'), { a: 2 });
    });
    check('returns the fallback for invalid JSON', () => {
      for (const text of ['', '   ', '{', '{"a":1} trailing', 'undefined', 'NaN', "{'a':1}", '[1,2', '{"a":}']) {
        assert.equal(safeJsonParse(text, 'fallback'), 'fallback');
      }
    });
    check('returns a fallback object by reference without cloning', () => {
      const fallback = { ok: false };
      assert.equal(safeJsonParse('{bad', fallback), fallback);
      assert.deepEqual(fallback, { ok: false });
    });
    check('returns a fallback function without calling it', () => {
      let calls = 0;
      const fallback = () => {
        calls += 1;
        return 'x';
      };
      assert.equal(safeJsonParse('{bad', fallback), fallback);
      assert.equal(calls, 0);
    });
    check('defaults the fallback to undefined', () => {
      assert.equal(safeJsonParse('{bad'), undefined);
      assert.equal(safeJsonParse(''), undefined);
    });
    check('does not use the fallback for valid JSON null, false, or zero', () => {
      assert.equal(safeJsonParse('null', 'fallback'), null);
      assert.equal(safeJsonParse('false', 'fallback'), false);
      assert.equal(safeJsonParse('0', 'fallback'), 0);
    });
    check('throws TypeError for non-string input', () => {
      for (const value of [undefined, null, 42, {}, [], true]) {
        assert.throws(() => safeJsonParse(value, 'fallback'), TypeError);
      }
    });
  } catch {
    checks.push({ name: 'module loads and runs', ok: false });
  }

  const failed = checks.filter(entry => !entry.ok).map(entry => entry.name);
  const passed = checks.length > 0 && failed.length === 0;
  return {
    passed,
    summary: passed
      ? `${checks.length}/${checks.length} checks passed`
      : `${failed.length}/${checks.length} checks failed: ${failed.slice(0, 4).join('; ')}`,
  };
}
