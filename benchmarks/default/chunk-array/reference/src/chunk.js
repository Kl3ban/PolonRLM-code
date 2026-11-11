export function chunk(items, size) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isInteger(size) || size < 1) throw new TypeError('size must be a positive integer');
  const output = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}
