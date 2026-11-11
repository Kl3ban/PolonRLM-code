export function uniqueBy(items, keyFn) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof keyFn !== 'function') throw new TypeError('keyFn must be a function');

  const seen = new Set();
  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const key = keyFn(item, index);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}
