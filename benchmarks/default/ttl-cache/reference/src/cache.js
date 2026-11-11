import { expiryFor } from './clock.js';
export class LruTtlCache {
  constructor({ maxEntries = 100, ttlMs = 0, now = Date.now } = {}) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError('ttlMs must be finite and non-negative');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.maxEntries = maxEntries; this.ttlMs = ttlMs; this.now = now; this.entries = new Map();
  }
  live(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { this.entries.delete(key); return undefined; }
    return entry;
  }
  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: expiryFor(this.now, this.ttlMs) });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value);
    return this;
  }
  get(key) {
    const entry = this.live(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  has(key) { return this.live(key) !== undefined; }
  delete(key) { return this.entries.delete(key); }
  clear() { const had = this.entries.size > 0; this.entries.clear(); return had; }
}
