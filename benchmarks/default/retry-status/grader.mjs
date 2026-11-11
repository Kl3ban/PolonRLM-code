import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { shouldRetryStatus } = await import(pathToFileURL(path.join(root, 'src', 'status.js')).href);
  const retry = [408, 425, 429, 500, 503, 599].every(code => shouldRetryStatus(code) === true);
  const noRetry = [200, 301, 400, 401, 404, 499, 600, -1, Number.NaN, Number.POSITIVE_INFINITY].every(code => shouldRetryStatus(code) === false);
  const passed = retry && noRetry;
  return { passed, summary: `${Number(retry) + Number(noRetry)}/2 groups passed` };
}
