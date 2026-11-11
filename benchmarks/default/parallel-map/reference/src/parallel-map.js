function abortReason(signal) {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export async function parallelMap(items, mapper, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof mapper !== 'function') throw new TypeError('mapper must be a function');
  const { concurrency = Infinity, signal } = options ?? {};
  if (!(concurrency === Infinity || (Number.isInteger(concurrency) && concurrency > 0))) {
    throw new TypeError('concurrency must be a positive integer or Infinity');
  }
  const results = new Array(items.length);
  if (items.length === 0) return results;
  if (signal?.aborted) throw abortReason(signal);

  return new Promise((resolve, reject) => {
    const limit = concurrency === Infinity ? items.length : Math.min(concurrency, items.length);
    let next = 0;
    let active = 0;
    let completed = 0;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(results);
    };
    const stop = error => {
      if (finished) return;
      finished = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(error);
    };
    const onAbort = () => stop(abortReason(signal));

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const launch = () => {
      if (finished) return;
      while (active < limit && next < items.length) {
        const index = next;
        next += 1;
        active += 1;
        Promise.resolve()
          .then(() => mapper(items[index], index))
          .then(
            value => {
              results[index] = { status: 'fulfilled', value };
            },
            reason => {
              results[index] = { status: 'rejected', reason };
            },
          )
          .then(() => {
            active -= 1;
            completed += 1;
            if (completed === items.length) finish();
            else launch();
          });
      }
    };

    launch();
  });
}
