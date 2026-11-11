export function flattenDepth(items, depth) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0) throw new TypeError('depth must be a non-negative integer');
  const result = [];
  const walk = (list, remaining) => {
    for (const item of list) {
      if (Array.isArray(item) && remaining > 0) {
        walk(item, remaining - 1);
      } else {
        result.push(item);
      }
    }
  };
  walk(items, depth);
  return result;
}
