import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const { LruTtlCache } = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    assert.equal(typeof LruTtlCache, 'function');
    let now = 100;
    const cache = new LruTtlCache({ maxEntries: 2, ttlMs: 10, now: () => now });
    cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
    assert.equal(cache.has('b'), false);
    assert.equal(cache.get('a'), 1); assert.equal(cache.get('c'), 3);
    cache.set('x', undefined); assert.equal(cache.has('x'), true);
    now = 110; assert.equal(cache.has('x'), false);
    const permanent = new LruTtlCache({ maxEntries: 1, now: () => now });
    permanent.set('a', 1); now = Number.MAX_SAFE_INTEGER; assert.equal(permanent.get('a'), 1);
    assert.equal(permanent.delete('a'), true); assert.equal(permanent.delete('a'), false);
    permanent.set('a', 1); assert.equal(permanent.clear(), true); assert.equal(permanent.clear(), false);
    for (const options of [{ maxEntries: 0 }, { ttlMs: -1 }, { now: null }]) assert.throws(() => new LruTtlCache(options), TypeError);
    return { passed: true, summary: 'LRU eviction, expiry, undefined values, no-expiry mode, and input validation passed' };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
