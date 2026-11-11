import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { mergeIntervals } = await import(pathToFileURL(path.join(root, 'src', 'intervals.js')).href);
  const cases = [
    [[[1, 3], [2, 6], [8, 10], [15, 18]], [[1, 6], [8, 10], [15, 18]]],
    [[[1, 4], [4, 5]], [[1, 5]]],
    [[[5, 6], [1, 2]], [[1, 2], [5, 6]]],
    [[[1, 2], [3, 4]], [[1, 2], [3, 4]]],
    [[], []],
  ];
  const checks = cases.map(([input, expected]) => JSON.stringify(mergeIntervals(input)) === JSON.stringify(expected));
  const input = [[1, 3], [2, 6]];
  const before = JSON.stringify(input);
  mergeIntervals(input);
  checks.push(JSON.stringify(input) === before);
  let rejected = 0;
  for (const value of ['no', [[1]], [[2, 1]], [[1, 2, 3]], [[1, Number.NaN]]]) {
    try { mergeIntervals(value); } catch (error) { if (error instanceof TypeError) rejected++; }
  }
  checks.push(rejected === 5);
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
