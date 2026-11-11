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
    const { memoizeJson } = await import(pathToFileURL(path.join(root, 'src', 'memoize-json.js')).href + `?grade=${Date.now()}`);
    check('exports memoizeJson', () => assert.equal(typeof memoizeJson, 'function'));
    check('rejects a non-function argument', () => {
      for (const value of [undefined, null, 42, {}, 'fn']) {
        assert.throws(() => memoizeJson(value), TypeError);
      }
    });
    check('caches repeated calls and counts invocations', () => {
      let calls = 0;
      const add = memoizeJson((a, b) => {
        calls += 1;
        return a + b;
      });
      assert.equal(add(1, 2), 3);
      assert.equal(add(1, 2), 3);
      assert.equal(calls, 1);
      assert.equal(add(2, 1), 3);
      assert.equal(calls, 2);
      assert.ok(add.cache instanceof Map);
      assert.equal(add.cache.size, 2);
    });
    check('keys entries by the full argument list', () => {
      let calls = 0;
      const first = memoizeJson(value => ({ calls: ++calls, value }));
      const a = first({ id: 7 });
      const b = first({ id: 7 });
      assert.equal(a, b);
      assert.equal(calls, 1);
      const c = first({ id: 8 });
      assert.notEqual(a, c);
      assert.equal(calls, 2);
    });
    check('caches a no-argument call once', () => {
      let calls = 0;
      const next = memoizeJson(() => {
        calls += 1;
        return calls;
      });
      assert.equal(next(), 1);
      assert.equal(next(), 1);
      assert.equal(calls, 1);
      assert.equal(next.cache.size, 1);
    });
    check('caches undefined, null, zero, false, and empty string results', () => {
      for (const value of [undefined, null, 0, false, '']) {
        let calls = 0;
        const get = memoizeJson(() => {
          calls += 1;
          return value;
        });
        assert.equal(get(), value);
        assert.equal(get(), value);
        assert.equal(calls, 1);
      }
    });
    check('does not cache thrown errors', () => {
      let calls = 0;
      const flaky = memoizeJson(() => {
        calls += 1;
        if (calls === 1) throw new RangeError('first call fails');
        return 'recovered';
      });
      assert.throws(() => flaky(), RangeError);
      assert.equal(flaky(), 'recovered');
      assert.equal(calls, 2);
    });
    check('propagates key serialization errors without calling fn', () => {
      let calls = 0;
      const never = memoizeJson(() => {
        calls += 1;
        return 'value';
      });
      const circular = {};
      circular.self = circular;
      assert.throws(() => never(circular), TypeError);
      assert.equal(calls, 0);
      assert.equal(never.cache.size, 0);
      assert.throws(() => never(1n), TypeError);
      assert.equal(calls, 0);
    });
    check('clear empties the cache and allows recomputation', () => {
      let calls = 0;
      const identity = memoizeJson(value => {
        calls += 1;
        return value;
      });
      assert.equal(identity(5), 5);
      assert.equal(identity(5), 5);
      assert.equal(calls, 1);
      assert.equal(identity.cache.size, 1);
      assert.equal(identity.clear(), undefined);
      assert.equal(identity.cache.size, 0);
      assert.equal(identity(5), 5);
      assert.equal(calls, 2);
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
