export function createBatcher(loadMany) {
  return {
    load(key) {
      return Promise.resolve()
        .then(() => loadMany([key]))
        .then(values => values[0]);
    },
  };
}
