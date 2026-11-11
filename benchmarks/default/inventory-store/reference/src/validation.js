export function assertSku(sku) {
  if (typeof sku !== 'string' || sku.length === 0 || sku.trim() !== sku) {
    throw new TypeError('sku must be a non-empty string without leading or trailing whitespace');
  }
  return sku;
}

export function assertQuantity(quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new TypeError('quantity must be a positive safe integer');
  }
  return quantity;
}
