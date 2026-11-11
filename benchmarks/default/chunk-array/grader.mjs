import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { chunk } = await import(pathToFileURL(path.join(root, 'src', 'chunk.js')).href);
  const input = [1, 2, 3, 4, 5];
  const before = JSON.stringify(input);
  const checks = [
    JSON.stringify(chunk(input, 2)) === JSON.stringify([[1, 2], [3, 4], [5]]),
    JSON.stringify(chunk(input, 5)) === JSON.stringify([[1, 2, 3, 4, 5]]),
    JSON.stringify(chunk(input, 9)) === JSON.stringify([[1, 2, 3, 4, 5]]),
    JSON.stringify(chunk([], 3)) === JSON.stringify([]),
    JSON.stringify(input) === before,
    chunk(input, 2)[0] !== input,
  ];
  let rejected = 0;
  for (const [items, size] of [['no', 2], [input, 0], [input, -1], [input, 1.5], [input, '2']]) {
    try { chunk(items, size); } catch (error) { if (error instanceof TypeError) rejected++; }
  }
  checks.push(rejected === 5);
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
