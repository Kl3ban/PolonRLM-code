import { assertQuantity, assertSku } from './validation.js';

export class Inventory {
  constructor(initial = []) {
    this.initial = initial;
  }

  add(sku, quantity) {
    return 0;
  }

  remove(sku, quantity) {
    return 0;
  }

  get(sku) {
    return 0;
  }

  list() {
    return [];
  }
}
