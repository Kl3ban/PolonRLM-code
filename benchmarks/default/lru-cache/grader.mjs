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
    const { LruCache } = await import(pathToFileURL(path.join(root, 'src', 'lru-cache.js')).href + `?grade=${Date.now()}`);
    check('exports the LruCache class', () => assert.equal(typeof LruCache, 'function'));
    check('rejects invalid constructor options', () => {
      for (const options of [undefined, null, {}, { maxSize: 0 }, { maxSize: -1 }, { maxSize: 1.5 }, { maxSize: '2' }, { maxSize: Infinity }]) {
        assert.throws(() => new LruCache(options), TypeError);
      }
    });
    check('stores and returns values', () => {
      const cache = new LruCache({ maxSize: 2 });
      cache.set('a', 1);
      cache.set('b', 0);
      assert.equal(cache.get('a'), 1);
      assert.equal(cache.get('b'), 0);
      assert.equal(cache.get('missing'), undefined);
      assert.equal(cache.size, 2);
    });
    check('get refreshes recency and set evicts the LRU entry', () => {
      const cache = new LruCache({ maxSize: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      assert.equal(cache.get('a'), 1);
      cache.set('c', 3);
      assert.equal(cache.has('b'), false);
      assert.equal(cache.get('a'), 1);
      assert.equal(cache.get('c'), 3);
      assert.equal(cache.size, 2);
    });
    check('updating a key refreshes it without growing', () => {
      const cache = new LruCache({ maxSize: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('a', 10);
      assert.equal(cache.size, 2);
      cache.set('c', 3);
      assert.equal(cache.has('b'), false);
      assert.equal(cache.get('a'), 10);
    });
    check('has does not refresh recency', () => {
      const cache = new LruCache({ maxSize: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      assert.equal(cache.has('a'), true);
      cache.set('c', 3);
      assert.equal(cache.has('a'), false);
      assert.equal(cache.has('b'), true);
    });
    check('a missing get does not create an entry', () => {
      const cache = new LruCache({ maxSize: 1 });
      assert.equal(cache.get('ghost'), undefined);
      assert.equal(cache.size, 0);
      cache.set('x', 1);
      assert.equal(cache.size, 1);
      assert.equal(cache.has('ghost'), false);
    });
    check('stores undefined values distinctly', () => {
      const cache = new LruCache({ maxSize: 1 });
      cache.set('u', undefined);
      assert.equal(cache.has('u'), true);
      assert.equal(cache.get('u'), undefined);
      assert.equal(cache.size, 1);
      cache.set('v', 2);
      assert.equal(cache.has('u'), false);
      assert.equal(cache.get('v'), 2);
    });
    check('uses SameValueZero key semantics', () => {
      const cache = new LruCache({ maxSize: 3 });
      cache.set(NaN, 'nan');
      assert.equal(cache.get(NaN), 'nan');
      cache.set(-0, 'zero');
      assert.equal(cache.get(0), 'zero');
      const objectKey = {};
      cache.set(objectKey, 'object');
      assert.equal(cache.get({}), undefined);
      assert.equal(cache.get(objectKey), 'object');
    });
    check('delete reports existence and frees capacity', () => {
      const cache = new LruCache({ maxSize: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      assert.equal(cache.delete('a'), true);
      assert.equal(cache.delete('a'), false);
      assert.equal(cache.size, 1);
      cache.set('c', 3);
      assert.equal(cache.has('b'), true);
      assert.equal(cache.has('c'), true);
    });
    check('clear empties the cache and it remains usable', () => {
      const cache = new LruCache({ maxSize: 2 });
      cache.set('a', 1);
      cache.set('b', 2);
      cache.clear();
      assert.equal(cache.size, 0);
      assert.equal(cache.has('a'), false);
      cache.set('c', 3);
      assert.equal(cache.get('c'), 3);
      assert.equal(cache.size, 1);
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
