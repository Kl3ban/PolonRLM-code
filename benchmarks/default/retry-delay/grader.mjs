import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { retryDelay } = await import(pathToFileURL(path.join(root, 'src', 'retry.js')).href);
  const checks = [
    retryDelay(1, 100, 1000) === 100,
    retryDelay(2, 100, 1000) === 200,
    retryDelay(4, 100, 350) === 350,
    retryDelay(0, 100, 1000) === 0,
    retryDelay(-2, 100, 1000) === 0,
    retryDelay(2.9, 10, 100) === 20,
    retryDelay(2, -10, 100) === 0,
    retryDelay(2, 10, -1) === 0,
    retryDelay(Number.NaN, 10, 100) === 0,
    retryDelay(2, Number.POSITIVE_INFINITY, 100) === 0,
  ];
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
