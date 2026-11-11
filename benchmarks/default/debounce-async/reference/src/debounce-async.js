const defaultClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle),
};

export function debounceAsync(fn, waitMs, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new TypeError('waitMs must be a non-negative finite number');
  const { clock = defaultClock } = options ?? {};
  if (!clock || typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') {
    throw new TypeError('clock must provide setTimeout and clearTimeout');
  }

  let timer = null;
  let burst = null;

  const debounced = (...args) => {
    if (!burst) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      burst = { args, promise, resolve, reject };
    } else {
      burst.args = args;
    }
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      const current = burst;
      burst = null;
      if (!current) return;
      let result;
      try {
        result = fn(...current.args);
      } catch (error) {
        current.reject(error);
        return;
      }
      Promise.resolve(result).then(current.resolve, current.reject);
    }, waitMs);
    return burst.promise;
  };

  debounced.cancel = () => {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
    const current = burst;
    burst = null;
    if (current) {
      const error = new Error('Debounced call cancelled');
      error.name = 'AbortError';
      current.reject(error);
    }
  };

  return debounced;
}
