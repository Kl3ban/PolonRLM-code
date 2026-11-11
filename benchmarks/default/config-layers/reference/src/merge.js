function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isPlainObject(value)) {
    const copy = {};
    for (const key of Object.keys(value)) {
      copy[key] = cloneValue(value[key]);
    }
    return copy;
  }
  return value;
}

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    throw new TypeError('deepMerge expects two plain objects');
  }
  const result = cloneValue(base);
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = cloneValue(value);
    }
  }
  return result;
}
