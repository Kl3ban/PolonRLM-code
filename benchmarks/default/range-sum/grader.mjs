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
    const { RangeSum } = await import(pathToFileURL(path.join(root, 'src', 'range-sum.js')).href + `?grade=${Date.now()}`);
    check('exports the RangeSum class', () => assert.equal(typeof RangeSum, 'function'));
    check('rejects invalid constructor input', () => {
      const sparse = [1, 2, 3];
      delete sparse[1];
      for (const values of [undefined, null, {}, 'abc', 7, [1, NaN], [1, Infinity], [1, -Infinity], [1, '2'], [1, undefined], sparse]) {
        assert.throws(() => new RangeSum(values), TypeError);
      }
    });
    check('sums inclusive ranges', () => {
      const range = new RangeSum([1, 2, 3, 4, 5]);
      assert.equal(range.sumRange(0, 4), 15);
      assert.equal(range.sumRange(1, 3), 9);
      assert.equal(range.sumRange(2, 2), 3);
      assert.equal(range.sumRange(0, 0), 1);
      assert.equal(range.sumRange(3, 4), 9);
    });
    check('handles negative and fractional values', () => {
      const range = new RangeSum([-5, 10, -2, 0.5, 0.25, 0.25]);
      assert.equal(range.sumRange(0, 2), 3);
      assert.equal(range.sumRange(1, 3), 8.5);
      assert.equal(range.sumRange(0, 5), 4);
      assert.equal(range.sumRange(4, 5), 0.5);
    });
    check('handles a single value', () => {
      const range = new RangeSum([7]);
      assert.equal(range.sumRange(0, 0), 7);
    });
    check('rejects out-of-range indices with RangeError', () => {
      const range = new RangeSum([1, 2, 3]);
      for (const [left, right] of [[-1, 0], [0, 3], [5, 6], [0, -1], [2, 1], [0, 100]]) {
        assert.throws(() => range.sumRange(left, right), RangeError);
      }
    });
    check('rejects non-integer indices with TypeError', () => {
      const range = new RangeSum([1, 2, 3]);
      for (const [left, right] of [[0.5, 1], ['0', 1], [null, 1], [NaN, 0], [0, undefined], [0, 2.5]]) {
        assert.throws(() => range.sumRange(left, right), TypeError);
      }
    });
    check('allows an empty array but rejects every query', () => {
      const empty = new RangeSum([]);
      assert.throws(() => empty.sumRange(0, 0), RangeError);
      assert.throws(() => empty.sumRange(-1, 0), RangeError);
    });
    check('copies input values at construction', () => {
      const values = [1, 2, 3];
      const range = new RangeSum(values);
      values[0] = 100;
      values.push(4);
      assert.equal(range.sumRange(0, 2), 6);
      assert.deepEqual(values, [100, 2, 3, 4]);
    });
    check('answers a large range correctly', () => {
      const values = Array.from({ length: 10000 }, (_, index) => index + 1);
      const range = new RangeSum(values);
      assert.equal(range.sumRange(0, 9999), 50005000);
      assert.equal(range.sumRange(9999, 9999), 10000);
      assert.equal(range.sumRange(1234, 5678), 15366365);
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
