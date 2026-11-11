export async function parallelMap(items, mapper, options = {}) {
  return Promise.all(items.map((item, index) => mapper(item, index))).then(values =>
    values.map(value => ({ status: 'fulfilled', value })),
  );
}
