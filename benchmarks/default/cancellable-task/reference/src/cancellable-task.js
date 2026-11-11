function createAbortError() {
  const error = new Error('Task cancelled');
  error.name = 'AbortError';
  return error;
}

export function createCancellableTask(executor) {
  if (typeof executor !== 'function') throw new TypeError('executor must be a function');
  const controller = new AbortController();
  let state = 'idle';
  let promise = null;
  let rejectTask = null;
  let settled = false;
  let cancellation;

  const start = () => {
    if (promise) return promise;
    if (state === 'cancelled') {
      promise = Promise.reject(cancellation);
      promise.catch(() => {});
      return promise;
    }
    promise = new Promise((resolve, reject) => {
      rejectTask = reject;
      state = 'running';
      let result;
      try {
        result = executor(controller.signal);
      } catch (error) {
        settled = true;
        state = 'rejected';
        reject(error);
        return;
      }
      Promise.resolve(result).then(
        value => {
          if (settled) return;
          settled = true;
          state = 'fulfilled';
          resolve(value);
        },
        error => {
          if (settled) return;
          settled = true;
          state = 'rejected';
          reject(error);
        },
      );
    });
    return promise;
  };

  const cancel = reason => {
    if (settled || state === 'cancelled') return false;
    const value = reason === undefined ? createAbortError() : reason;
    settled = true;
    state = 'cancelled';
    cancellation = value;
    controller.abort(value);
    if (rejectTask) rejectTask(value);
    return true;
  };

  return { start, cancel, status: () => state };
}
