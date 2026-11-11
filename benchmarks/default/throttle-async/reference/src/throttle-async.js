const defaultClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle),
};

export function throttleAsync(fn, intervalMs, options = {}) {
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new TypeError('intervalMs must be a positive finite number');
  const { clock = defaultClock } = options ?? {};
  if (!clock || typeof clock.setTimeout !== 'function' || typeof clock.clearTimeout !== 'function') {
    throw new TypeError('clock must provide setTimeout and clearTimeout');
  }

  let timer = null;
  let trailing = null;

  const invoke = args => {
    try {
      return Promise.resolve(fn(...args));
    } catch (error) {
      return Promise.reject(error);
    }
  };

  const throttled = (...args) => {
    if (timer === null) {
      timer = clock.setTimeout(() => {
        timer = null;
        const current = trailing;
        trailing = null;
        if (!current) return;
        let result;
        try {
          result = fn(...current.args);
        } catch (error) {
          current.reject(error);
          return;
        }
        Promise.resolve(result).then(current.resolve, current.reject);
      }, intervalMs);
      return invoke(args);
    }
    if (!trailing) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      trailing = { args, promise, resolve, reject };
      return promise;
    }
    trailing.args = args;
    return trailing.promise;
  };

  throttled.cancel = () => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
    const current = trailing;
    trailing = null;
    if (current) {
      const error = new Error('Throttled call cancelled');
      error.name = 'AbortError';
      current.reject(error);
    }
  };

  return throttled;
}
