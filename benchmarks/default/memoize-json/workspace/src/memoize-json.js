export function memoizeJson(fn) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  const cache = new Map();

  function memoized(...args) {
    const value = fn.apply(this, args);
    return value;
  }

  memoized.cache = cache;
  memoized.clear = () => {
    cache.clear();
  };
  return memoized;
}
