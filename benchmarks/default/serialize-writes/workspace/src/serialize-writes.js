export function createWriteQueue() {
  const active = new Set();
  return {
    enqueue(operation) {
      const promise = Promise.resolve().then(() => operation());
      active.add(promise);
      promise.then(() => active.delete(promise), () => active.delete(promise));
      return promise;
    },
    pending() {
      return active.size;
    },
    onIdle() {
      return Promise.all([...active]).then(() => {}, () => {});
    },
  };
}
