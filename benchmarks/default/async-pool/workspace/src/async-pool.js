export async function asyncPool(items, limit, worker) {
  return Promise.all(items.map((item, index) => worker(item, index)));
}
