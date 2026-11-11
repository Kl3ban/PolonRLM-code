export class LruCache {
  constructor(options) {
    this.maxSize = options.maxSize;
    this.entries = new Map();
  }

  get(key) {
    return this.entries.get(key);
  }

  set(key, value) {
    this.entries.set(key, value);
  }

  has(key) {
    return this.entries.has(key);
  }

  delete(key) {
    return this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  get size() {
    return this.entries.size;
  }
}
