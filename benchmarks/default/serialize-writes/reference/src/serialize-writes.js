export function createWriteQueue() {
  const queue = [];
  let running = false;
  let idleResolvers = [];

  const settleIdle = () => {
    if (running || queue.length > 0) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  };

  const pump = () => {
    if (running) return;
    const entry = queue.shift();
    if (!entry) {
      settleIdle();
      return;
    }
    running = true;
    queueMicrotask(() => {
      let result;
      try {
        result = entry.operation();
      } catch (error) {
        running = false;
        pump();
        entry.reject(error);
        return;
      }
      Promise.resolve(result).then(
        value => {
          running = false;
          pump();
          entry.resolve(value);
        },
        error => {
          running = false;
          pump();
          entry.reject(error);
        },
      );
    });
  };

  return {
    enqueue(operation) {
      if (typeof operation !== 'function') throw new TypeError('operation must be a function');
      return new Promise((resolve, reject) => {
        queue.push({ operation, resolve, reject });
        pump();
      });
    },
    pending() {
      return queue.length + (running ? 1 : 0);
    },
    onIdle() {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise(resolve => {
        idleResolvers.push(resolve);
      });
    },
  };
}
