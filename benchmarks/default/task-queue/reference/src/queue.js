import { assertConcurrency } from './limits.js';

export function createQueue(concurrency = 1) {
  assertConcurrency(concurrency);
  const pending = [];
  let active = 0;
  let idleResolvers = [];

  function settleIdleIfDrained() {
    if (active !== 0 || pending.length !== 0) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  function pump() {
    while (active < concurrency && pending.length > 0) {
      const job = pending.shift();
      active += 1;
      Promise.resolve()
        .then(() => job.task())
        .then(
          value => {
            active -= 1;
            job.resolve(value);
            pump();
          },
          error => {
            active -= 1;
            job.reject(error);
            pump();
          },
        );
    }
    settleIdleIfDrained();
  }

  return {
    push(task) {
      if (typeof task !== 'function') {
        return Promise.reject(new TypeError('task must be a function'));
      }
      return new Promise((resolve, reject) => {
        pending.push({ task, resolve, reject });
        pump();
      });
    },
    get size() {
      return pending.length;
    },
    get active() {
      return active;
    },
    idle() {
      if (active === 0 && pending.length === 0) return Promise.resolve();
      return new Promise(resolve => {
        idleResolvers.push(resolve);
      });
    },
  };
}
