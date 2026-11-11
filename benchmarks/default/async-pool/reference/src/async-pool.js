export async function asyncPool(items, limit, worker) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  if (typeof worker !== 'function') throw new TypeError('worker must be a function');
  const results = new Array(items.length);
  if (items.length === 0) return results;
  return new Promise((resolve, reject) => {
    let next = 0;
    let active = 0;
    let completed = 0;
    let failed = false;
    const launch = () => {
      while (!failed && active < limit && next < items.length) {
        const index = next;
        next += 1;
        active += 1;
        Promise.resolve().then(() => worker(items[index], index)).then(
          value => {
            results[index] = value;
            active -= 1;
            completed += 1;
            if (completed === items.length) resolve(results);
            else launch();
          },
          error => {
            if (failed) return;
            failed = true;
            reject(error);
          },
        );
      }
    };
    launch();
  });
}
