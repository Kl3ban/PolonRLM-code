const defaultDelay = ms => new Promise(resolve => setTimeout(resolve, ms));

function abortReason(signal) {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function waitForDelay(delay, ms, attempt, signal) {
  if (!signal) return Promise.resolve(delay(ms, attempt));
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(delay(ms, attempt)).then(
      () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function retry(task, options = {}) {
  if (typeof task !== 'function') throw new TypeError('task must be a function');
  const {
    retries = 3,
    baseMs = 10,
    maxMs = 100,
    delay = defaultDelay,
    signal,
  } = options ?? {};
  if (!Number.isSafeInteger(retries) || retries < 0) throw new TypeError('retries must be a non-negative integer');
  if (!Number.isFinite(baseMs) || baseMs < 0) throw new TypeError('baseMs must be a non-negative finite number');
  if (!Number.isFinite(maxMs) || maxMs < 0) throw new TypeError('maxMs must be a non-negative finite number');
  if (typeof delay !== 'function') throw new TypeError('delay must be a function');

  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw abortReason(signal);
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt > retries) throw error;
      if (signal?.aborted) throw abortReason(signal);
      const waitMs = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      await waitForDelay(delay, waitMs, attempt, signal);
    }
  }
}
