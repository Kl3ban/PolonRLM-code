import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function grade(root) {
  const { parseDuration } = await import(pathToFileURL(path.join(root, 'src', 'duration.js')).href);
  const valid = [
    ['1h30m', 5_400_000],
    ['45s', 45_000],
    ['2d4h', 187_200_000],
    ['250ms', 250],
    ['1d2h3m4s5ms', 93_784_005],
  ];
  const checks = valid.map(([input, expected]) => parseDuration(input) === expected);
  const invalid = ['', '1x', 'h', '1h1h', '1m1h', '1.5s', '-1s'];
  let rejected = 0;
  for (const input of invalid) {
    try { parseDuration(input); } catch (error) { if (error instanceof TypeError) rejected++; }
  }
  checks.push(rejected === invalid.length);
  const passed = checks.every(Boolean);
  return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
}
