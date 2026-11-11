export function memoizeJson(fn) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  const cache = new Map();

  function memoized(...args) {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const value = fn.apply(this, args);
    cache.set(key, value);
    return value;
  }

  memoized.cache = cache;
  memoized.clear = () => {
    cache.clear();
  };
  return memoized;
}
