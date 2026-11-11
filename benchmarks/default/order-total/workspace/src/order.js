import { percentageOf } from './money.js';

export function calculateTotal(items, options = {}) {
  return {
    subtotalCents: 0,
    discountCents: 0,
    taxCents: 0,
    shippingCents: 0,
    totalCents: 0,
  };
}
