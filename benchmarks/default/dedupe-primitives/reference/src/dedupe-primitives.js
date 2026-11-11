function sameValueZero(left, right) {
  return left === right || (left !== left && right !== right);
}

export function dedupePrimitives(items) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  for (const item of items) {
    const type = typeof item;
    const isPrimitive = item === null || type === 'string' || type === 'number' || type === 'boolean'
      || type === 'undefined' || type === 'symbol' || type === 'bigint';
    if (!isPrimitive) throw new TypeError('items must contain only primitive values');
  }
  const result = [];
  for (const item of items) {
    if (!result.some(existing => sameValueZero(existing, item))) result.push(item);
  }
  return result;
}
