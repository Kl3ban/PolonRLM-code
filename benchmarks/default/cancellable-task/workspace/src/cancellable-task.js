export function createCancellableTask(executor) {
  let state = 'idle';
  let promise = null;
  return {
    start() {
      if (!promise) {
        state = 'running';
        promise = Promise.resolve().then(() => executor(undefined)).then(
          value => {
            state = 'fulfilled';
            return value;
          },
          error => {
            state = 'rejected';
            throw error;
          },
        );
      }
      return promise;
    },
    cancel() {
      return false;
    },
    status() {
      return state;
    },
  };
}
