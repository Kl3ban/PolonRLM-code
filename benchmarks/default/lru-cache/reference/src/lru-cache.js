export class LruCache {
  #entries = new Map();
  #maxSize;

  constructor(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must be an object');
    }
    const { maxSize } = options;
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
      throw new TypeError('maxSize must be a positive safe integer');
    }
    this.#maxSize = maxSize;
  }

  get(key) {
    if (!this.#entries.has(key)) return undefined;
    const value = this.#entries.get(key);
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#maxSize) {
      const oldest = this.#entries.keys().next().value;
      this.#entries.delete(oldest);
    }
  }

  has(key) {
    return this.#entries.has(key);
  }

  delete(key) {
    return this.#entries.delete(key);
  }

  clear() {
    this.#entries.clear();
  }

  get size() {
    return this.#entries.size;
  }
}
