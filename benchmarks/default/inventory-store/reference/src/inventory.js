import { assertQuantity, assertSku } from './validation.js';

export class Inventory {
  #counts = new Map();

  constructor(initial = []) {
    if (!Array.isArray(initial)) {
      throw new TypeError('initial must be an array');
    }
    for (const entry of initial) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('each initial entry must be an object');
      }
      const sku = assertSku(entry.sku);
      const quantity = assertQuantity(entry.quantity);
      const next = (this.#counts.get(sku) ?? 0) + quantity;
      if (!Number.isSafeInteger(next)) {
        throw new RangeError('inventory quantity must be a safe integer');
      }
      this.#counts.set(sku, next);
    }
  }

  add(sku, quantity) {
    const validSku = assertSku(sku);
    const validQuantity = assertQuantity(quantity);
    const next = (this.#counts.get(validSku) ?? 0) + validQuantity;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError('inventory quantity must be a safe integer');
    }
    this.#counts.set(validSku, next);
    return next;
  }

  remove(sku, quantity) {
    const validSku = assertSku(sku);
    const validQuantity = assertQuantity(quantity);
    const current = this.#counts.get(validSku);
    if (current === undefined) {
      throw new Error(`unknown sku: ${validSku}`);
    }
    if (current < validQuantity) {
      throw new Error(`insufficient stock for sku: ${validSku}`);
    }
    const next = current - validQuantity;
    if (next === 0) {
      this.#counts.delete(validSku);
    } else {
      this.#counts.set(validSku, next);
    }
    return next;
  }

  get(sku) {
    return this.#counts.get(assertSku(sku)) ?? 0;
  }

  list() {
    return [...this.#counts.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([sku, quantity]) => ({ sku, quantity }));
  }
}
