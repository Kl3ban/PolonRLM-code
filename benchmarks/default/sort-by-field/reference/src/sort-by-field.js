export function sortByField(items, field, direction = 'asc') {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof field !== 'string' || field.length === 0) throw new TypeError('field must be a non-empty string');
  if (direction !== 'asc' && direction !== 'desc') throw new TypeError("direction must be 'asc' or 'desc'");

  const values = items.map(item => {
    if (item === null || typeof item !== 'object') throw new TypeError('items must be non-null objects');
    const value = item[field];
    if (value === undefined) throw new TypeError(`item is missing field ${field}`);
    return value;
  });

  const allNumbers = values.every(value => typeof value === 'number');
  const allStrings = values.every(value => typeof value === 'string');
  if (!allNumbers && !allStrings) throw new TypeError('field values must be all numbers or all strings');
  if (allNumbers && values.some(value => !Number.isFinite(value))) throw new TypeError('number values must be finite');

  const sign = direction === 'desc' ? -1 : 1;
  return items.slice().sort((left, right) => {
    const a = left[field];
    const b = right[field];
    if (a < b) return -1 * sign;
    if (a > b) return 1 * sign;
    return 0;
  });
}
