export function groupBy(items, keyFn) {
  if (typeof keyFn !== 'function') throw new TypeError('keyFn must be a function');
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
