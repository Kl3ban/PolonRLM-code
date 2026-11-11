import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LruTtlCache } from '../src/index.js';

test('refreshes recency and evicts least recently used entry', () => {
  const cache = new LruTtlCache({ maxEntries: 2 });
  cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.equal(cache.has('b'), false);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('expires lazily using injected clock and ttl zero never expires', () => {
  let time = 10;
  const cache = new LruTtlCache({ maxEntries: 2, ttlMs: 5, now: () => time });
  cache.set('short', 1); time = 15;
  assert.equal(cache.has('short'), false);
  assert.equal(cache.get('short'), undefined);
  const forever = new LruTtlCache({ maxEntries: 1, ttlMs: 0, now: () => time });
  forever.set('x', undefined); time = Number.MAX_SAFE_INTEGER;
  assert.equal(forever.has('x'), true);
  assert.equal(forever.get('x'), undefined);
});

test('delete and clear report whether entries were removed', () => {
  const cache = new LruTtlCache();
  assert.equal(cache.delete('x'), false);
  cache.set('x', 1);
  assert.equal(cache.delete('x'), true);
  cache.set('a', 1); cache.set('b', 2);
  assert.equal(cache.clear(), true);
  assert.equal(cache.clear(), false);
});

test('invalid cache options fail early', () => {
  assert.throws(() => new LruTtlCache({ maxEntries: 0 }), TypeError);
  assert.throws(() => new LruTtlCache({ ttlMs: -1 }), TypeError);
  assert.throws(() => new LruTtlCache({ now: 1 }), TypeError);
});
