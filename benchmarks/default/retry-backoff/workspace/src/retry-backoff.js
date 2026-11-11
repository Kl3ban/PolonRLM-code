export async function retry(task, options = {}) {
  const { retries = 3, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = options;
  try {
    return await task(1);
  } catch (error) {
    if (retries < 1) throw error;
    await delay(0);
    return task(2);
  }
}
