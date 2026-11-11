import { assertConcurrency } from './limits.js';

export function createQueue(concurrency = 1) {
  assertConcurrency(concurrency);
  return {
    push(task) {
      return Promise.resolve().then(task);
    },
    get size() {
      return 0;
    },
    get active() {
      return 0;
    },
    idle() {
      return Promise.resolve();
    },
  };
}
