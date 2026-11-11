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
    const { uniqueBy } = await import(pathToFileURL(path.join(root, 'src', 'unique-by.js')).href + `?grade=${Date.now()}`);
    check('exports uniqueBy', () => assert.equal(typeof uniqueBy, 'function'));
    check('keeps the first item per key in order', () => {
      const items = [{ id: 3, tag: 'x' }, { id: 1, tag: 'y' }, { id: 3, tag: 'z' }, { id: 2, tag: 'w' }];
      const result = uniqueBy(items, item => item.id);
      assert.equal(result.length, 3);
      assert.equal(result[0], items[0]);
      assert.equal(result[1], items[1]);
      assert.equal(result[2], items[3]);
    });
    check('passes item and index to keyFn exactly once per item', () => {
      const items = ['a', 'b', 'c'];
      const calls = [];
      const result = uniqueBy(items, (item, index) => {
        calls.push([item, index]);
        return item;
      });
      assert.deepEqual(calls, [['a', 0], ['b', 1], ['c', 2]]);
      assert.deepEqual(result, ['a', 'b', 'c']);
    });
    check('treats NaN keys as equal', () => {
      assert.deepEqual(uniqueBy([1, 2, 3], () => NaN), [1]);
    });
    check('treats 0 and -0 as the same key', () => {
      assert.deepEqual(uniqueBy(['first', 'second'], (item, index) => (index === 0 ? 0 : -0)), ['first']);
    });
    check('compares object keys by identity', () => {
      const shared = {};
      const other = {};
      const items = ['a', 'b', 'c'];
      assert.deepEqual(uniqueBy(items, item => (item === 'b' ? other : shared)), ['a', 'b']);
    });
    check('handles undefined keys', () => {
      assert.deepEqual(uniqueBy([1, 2], () => undefined), [1]);
    });
    check('does not mutate the input array', () => {
      const items = [1, 2, 3, 1];
      const before = JSON.stringify(items);
      const result = uniqueBy(items, item => item);
      assert.deepEqual(items, [1, 2, 3, 1]);
      assert.equal(JSON.stringify(items), before);
      assert.notEqual(result, items);
    });
    check('returns a new empty array for empty input', () => {
      let calls = 0;
      const result = uniqueBy([], () => {
        calls += 1;
        return 1;
      });
      assert.deepEqual(result, []);
      assert.equal(calls, 0);
    });
    check('rejects invalid arguments', () => {
      for (const items of [undefined, null, {}, 'abc', 7]) {
        assert.throws(() => uniqueBy(items, item => item), TypeError);
      }
      for (const keyFn of [undefined, null, 42, 'fn', {}]) {
        assert.throws(() => uniqueBy([], keyFn), TypeError);
      }
    });
    check('propagates keyFn errors unchanged', () => {
      const failure = new Error('key failed');
      assert.throws(
        () => uniqueBy([1, 2, 3], item => {
          if (item === 2) throw failure;
          return item;
        }),
        error => error === failure,
      );
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
