export function binarySearchFirst(items, target) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof target !== 'number' || !Number.isFinite(target)) throw new TypeError('target must be a finite number');
  for (const item of items) {
    if (typeof item !== 'number' || !Number.isFinite(item)) throw new TypeError('items must contain only finite numbers');
  }
  let low = 0;
  let high = items.length - 1;
  let first = -1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    if (items[middle] === target) {
      first = middle;
      high = middle - 1;
    } else if (items[middle] < target) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return first;
}
