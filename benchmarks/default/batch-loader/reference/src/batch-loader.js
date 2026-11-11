export function createBatcher(loadMany) {
  if (typeof loadMany !== 'function') throw new TypeError('loadMany must be a function');
  let batch = new Map();
  let scheduled = false;

  const dispatch = () => {
    scheduled = false;
    const current = batch;
    batch = new Map();
    if (current.size === 0) return;
    const keys = [...current.keys()];
    const entries = [...current.values()];
    Promise.resolve()
      .then(() => loadMany(keys))
      .then(
        values => {
          if (!Array.isArray(values) || values.length !== keys.length) {
            const error = new TypeError('loadMany must resolve to an array with one entry per key');
            for (const entry of entries) entry.reject(error);
            return;
          }
          values.forEach((value, index) => {
            const entry = entries[index];
            if (value instanceof Error) entry.reject(value);
            else entry.resolve(value);
          });
        },
        error => {
          for (const entry of entries) entry.reject(error);
        },
      );
  };

  return {
    load(key) {
      let entry = batch.get(key);
      if (!entry) {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        entry = { promise, resolve, reject };
        batch.set(key, entry);
      }
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(dispatch);
      }
      return entry.promise;
    },
  };
}
