export function throttleAsync(fn, intervalMs, options = {}) {
  const throttled = (...args) => {
    try {
      return Promise.resolve(fn(...args));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  throttled.cancel = () => {};
  return throttled;
}
