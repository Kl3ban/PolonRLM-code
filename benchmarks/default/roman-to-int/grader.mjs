import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FAILED = Symbol('failed');

function attempt(run) {
  try {
    return run();
  } catch {
    return FAILED;
  }
}

function rejectsTypeError(run) {
  try {
    run();
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
}

export async function grade(root) {
  try {
    const { romanToInt } = await import(
      pathToFileURL(path.join(root, 'src', 'roman-to-int.js')).href + `?grade=${Date.now()}`
    );
    const values = [
      ['I', 1],
      ['IV', 4],
      ['IX', 9],
      ['XL', 40],
      ['XC', 90],
      ['CD', 400],
      ['CM', 900],
      ['LVIII', 58],
      ['XLII', 42],
      ['D', 500],
      ['XCIX', 99],
      ['CDXLIV', 444],
      ['MCMXCIV', 1994],
      ['MMXXIV', 2024],
      ['MMMCMXCIX', 3999],
      ['MMMDCCCLXXXVIII', 3888],
    ];
    const checks = values.map(([roman, expected]) => attempt(() => romanToInt(roman)) === expected);
    checks.push(attempt(() => typeof romanToInt('X')) === 'number');
    let rejected = 0;
    for (const run of [
      () => romanToInt('IIII'),
      () => romanToInt('VV'),
      () => romanToInt('IC'),
      () => romanToInt('IL'),
      () => romanToInt(''),
      () => romanToInt('MMMM'),
      () => romanToInt('ABC'),
      () => romanToInt('i'),
      () => romanToInt('XIIX'),
      () => romanToInt('IVI'),
      () => romanToInt('VX'),
      () => romanToInt('ICM'),
      () => romanToInt(42),
      () => romanToInt(null),
      () => romanToInt(undefined),
    ]) {
      if (rejectsTypeError(run)) rejected += 1;
    }
    checks.push(rejected === 15);
    const passed = checks.every(Boolean);
    return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
