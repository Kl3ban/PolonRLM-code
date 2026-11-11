export function dedupe(items) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') throw new TypeError('item must be an object');
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    output.push(item);
  }
  return output;
}
