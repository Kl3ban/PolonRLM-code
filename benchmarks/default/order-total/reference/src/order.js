import { percentageOf } from './money.js';

function assertItem(item, index) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError(`items[${index}] must be an object`);
  }
  if (!Number.isSafeInteger(item.priceCents) || item.priceCents < 0) {
    throw new RangeError(`items[${index}].priceCents must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
    throw new RangeError(`items[${index}].quantity must be a positive safe integer`);
  }
}

export function calculateTotal(items, options = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError('items must be an array');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const {
    discountPercent = 0,
    taxPercent = 0,
    shippingCents = 0,
  } = options;

  if (!Number.isSafeInteger(shippingCents) || shippingCents < 0) {
    throw new RangeError('shippingCents must be a non-negative safe integer');
  }

  let subtotalCents = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    assertItem(item, index);
    subtotalCents += item.priceCents * item.quantity;
    if (!Number.isSafeInteger(subtotalCents)) {
      throw new RangeError('order subtotal must be a safe integer');
    }
  }

  const discountCents = percentageOf(subtotalCents, discountPercent);
  const taxCents = percentageOf(subtotalCents - discountCents, taxPercent);
  const totalCents = subtotalCents - discountCents + taxCents + shippingCents;

  return { subtotalCents, discountCents, taxCents, shippingCents, totalCents };
}
