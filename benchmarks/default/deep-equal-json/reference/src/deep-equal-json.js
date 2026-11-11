function assertJsonValue(value, seen) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('numbers must be finite');
    return;
  }
  if (type !== 'object') throw new TypeError('value is not JSON-compatible');
  if (seen.has(value)) throw new TypeError('cyclic structures are not supported');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('objects must be plain');
    for (const key of Object.keys(value)) assertJsonValue(value[key], seen);
  }
  seen.delete(value);
}

function equal(left, right) {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!equal(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!equal(left[key], right[key])) return false;
  }
  return true;
}

export function deepEqualJson(left, right) {
  assertJsonValue(left, new WeakSet());
  assertJsonValue(right, new WeakSet());
  return equal(left, right);
}
