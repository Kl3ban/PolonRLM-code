export function sortByField(items, field, direction = 'asc') {
  const sign = direction === 'desc' ? -1 : 1;
  return items.slice().sort((left, right) => {
    const a = left[field];
    const b = right[field];
    if (a < b) return -1 * sign;
    if (a > b) return 1 * sign;
    return 0;
  });
}
