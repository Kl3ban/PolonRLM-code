import { expiryFor } from './clock.js';

export class LruTtlCache {
  constructor(options = {}) {
    this.options = options;
    this.entries = new Map();
  }
  set() { throw new Error('TODO'); }
  get() { return undefined; }
  has() { return false; }
  delete() { return false; }
  clear() { return false; }
}
