export function debounceAsync(fn, waitMs, options = {}) {
  const debounced = (...args) => Promise.resolve().then(() => fn(...args));
  debounced.cancel = () => {};
  return debounced;
}
