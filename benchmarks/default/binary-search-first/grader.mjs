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
    const { binarySearchFirst } = await import(
      pathToFileURL(path.join(root, 'src', 'binary-search-first.js')).href + `?grade=${Date.now()}`
    );
    const wide = Array.from({ length: 1000 }, (_, index) => index * 2);
    const checks = [
      attempt(() => binarySearchFirst([1, 3, 3, 3, 5], 3)) === 1,
      attempt(() => binarySearchFirst([1, 3, 3, 3, 5], 1)) === 0,
      attempt(() => binarySearchFirst([1, 3, 3, 3, 5], 5)) === 4,
      attempt(() => binarySearchFirst([1, 2, 4, 8], 3)) === -1,
      attempt(() => binarySearchFirst([1, 2, 4, 8], 0)) === -1,
      attempt(() => binarySearchFirst([1, 2, 4, 8], 9)) === -1,
      attempt(() => binarySearchFirst([], 1)) === -1,
      attempt(() => binarySearchFirst([7], 7)) === 0,
      attempt(() => binarySearchFirst([7], 8)) === -1,
      attempt(() => binarySearchFirst([2, 2, 2, 2], 2)) === 0,
      attempt(() => binarySearchFirst(wide, 502)) === 251,
      attempt(() => binarySearchFirst(wide, 503)) === -1,
      attempt(() => typeof binarySearchFirst([4, 4], 4)) === 'number',
    ];
    const input = [1, 2, 2, 3];
    const before = JSON.stringify(input);
    attempt(() => binarySearchFirst(input, 2));
    checks.push(JSON.stringify(input) === before);
    let rejected = 0;
    for (const run of [
      () => binarySearchFirst('123', 1),
      () => binarySearchFirst(null, 1),
      () => binarySearchFirst([1, 2], Number.NaN),
      () => binarySearchFirst([1, 2], Infinity),
      () => binarySearchFirst([1, 2], '2'),
      () => binarySearchFirst([1, '2'], 2),
      () => binarySearchFirst([1, 2], undefined),
    ]) {
      if (rejectsTypeError(run)) rejected += 1;
    }
    checks.push(rejected === 7);
    const passed = checks.every(Boolean);
    return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
