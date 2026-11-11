export class TimeoutError extends Error {
  constructor(ms) {
    super(`Operation timed out after ${ms} ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = ms;
  }
}

const defaultTimer = ms => {
  let handle;
  const promise = new Promise(resolve => {
    handle = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
};

export function withTimeout(operation, ms, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError('ms must be a positive finite number');
  const { timer = defaultTimer } = options ?? {};
  if (typeof timer !== 'function') throw new TypeError('timer must be a function');

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        try {
          timeoutHandle.cancel();
        } catch {
          // A cancel implementation that throws must not change the outcome.
        }
      }
      callback(value);
    };

    let timeoutHandle;
    try {
      timeoutHandle = timer(ms);
    } catch (error) {
      reject(error);
      return;
    }

    Promise.resolve(timeoutHandle.promise).then(
      () => {
        if (settled) return;
        settled = true;
        reject(new TimeoutError(ms));
      },
      error => {
        if (settled) return;
        settled = true;
        reject(error);
      },
    );

    let result;
    try {
      result = operation();
    } catch (error) {
      finish(reject, error);
      return;
    }
    Promise.resolve(result).then(
      value => finish(resolve, value),
      error => finish(reject, error),
    );
  });
}
