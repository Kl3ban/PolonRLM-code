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
    const { sortByField } = await import(pathToFileURL(path.join(root, 'src', 'sort-by-field.js')).href + `?grade=${Date.now()}`);
    check('exports sortByField', () => assert.equal(typeof sortByField, 'function'));
    check('sorts strings ascending and descending', () => {
      const items = [{ name: 'b', id: 1 }, { name: 'a', id: 2 }, { name: 'b', id: 3 }];
      assert.deepEqual(sortByField(items, 'name').map(item => item.id), [2, 1, 3]);
      assert.deepEqual(sortByField(items, 'name', 'desc').map(item => item.id), [1, 3, 2]);
    });
    check('sorts numbers numerically', () => {
      const items = [{ v: 2, id: 'a' }, { v: -1, id: 'b' }, { v: 2, id: 'c' }, { v: 0, id: 'd' }, { v: -1.5, id: 'e' }];
      assert.deepEqual(sortByField(items, 'v').map(item => item.id), ['e', 'b', 'd', 'a', 'c']);
      assert.deepEqual(sortByField(items, 'v', 'desc').map(item => item.id), ['a', 'c', 'd', 'b', 'e']);
    });
    check('keeps ties stable in both directions', () => {
      const items = [{ k: 1, id: 1 }, { k: 2, id: 2 }, { k: 1, id: 3 }, { k: 2, id: 4 }];
      assert.deepEqual(sortByField(items, 'k').map(item => item.id), [1, 3, 2, 4]);
      assert.deepEqual(sortByField(items, 'k', 'desc').map(item => item.id), [2, 4, 1, 3]);
    });
    check('returns a new array and leaves the input untouched', () => {
      const items = [{ n: 2 }, { n: 1 }];
      const before = JSON.stringify(items);
      const sorted = sortByField(items, 'n');
      assert.notEqual(sorted, items);
      assert.equal(items[0].n, 2);
      assert.equal(JSON.stringify(items), before);
    });
    check('handles an empty array', () => {
      const items = [];
      const sorted = sortByField(items, 'anything');
      assert.deepEqual(sorted, []);
      assert.notEqual(sorted, items);
    });
    check('compares strings by UTF-16 code units', () => {
      assert.deepEqual(sortByField([{ s: 'a' }, { s: 'B' }, { s: 'A' }], 's').map(item => item.s), ['A', 'B', 'a']);
    });
    check('rejects missing or undefined field values', () => {
      assert.throws(() => sortByField([{ a: 1 }, {}], 'a'), TypeError);
      assert.throws(() => sortByField([{ a: 1 }, { a: undefined }], 'a'), TypeError);
    });
    check('rejects mixed or unsupported value types', () => {
      assert.throws(() => sortByField([{ v: 1 }, { v: '2' }], 'v'), TypeError);
      assert.throws(() => sortByField([{ v: true }, { v: false }], 'v'), TypeError);
      assert.throws(() => sortByField([{ v: NaN }], 'v'), TypeError);
      assert.throws(() => sortByField([{ v: Infinity }], 'v'), TypeError);
    });
    check('rejects invalid arguments', () => {
      assert.throws(() => sortByField(null, 'a'), TypeError);
      assert.throws(() => sortByField({}, 'a'), TypeError);
      assert.throws(() => sortByField([{ a: 1 }], ''), TypeError);
      assert.throws(() => sortByField([{ a: 1 }], 3), TypeError);
      assert.throws(() => sortByField([{ a: 1 }], 'a', 'ASC'), TypeError);
      assert.throws(() => sortByField([{ a: 1 }], 'a', null), TypeError);
      assert.throws(() => sortByField([{ a: 1 }], 'a', 'ascending'), TypeError);
      assert.throws(() => sortByField([null], 'a'), TypeError);
      assert.throws(() => sortByField([5], 'a'), TypeError);
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
