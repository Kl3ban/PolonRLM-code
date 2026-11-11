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

function sameList(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => Object.is(actual[index], value));
}

export async function grade(root) {
  try {
    const { dedupePrimitives } = await import(
      pathToFileURL(path.join(root, 'src', 'dedupe-primitives.js')).href + `?grade=${Date.now()}`
    );
    const checks = [
      sameList(attempt(() => dedupePrimitives([1, 1, 2, 1])), [1, 2]),
      sameList(attempt(() => dedupePrimitives(['a', 'b', 'a'])), ['a', 'b']),
      sameList(attempt(() => dedupePrimitives([Number.NaN, Number.NaN, 1])), [Number.NaN, 1]),
      sameList(attempt(() => dedupePrimitives([1, '1', 1, '1'])), [1, '1']),
      sameList(attempt(() => dedupePrimitives([true, 1, true])), [true, 1]),
      sameList(attempt(() => dedupePrimitives([null, undefined, null, undefined])), [null, undefined]),
      sameList(attempt(() => dedupePrimitives([3, 1, 3, 2, 1])), [3, 1, 2]),
      sameList(attempt(() => dedupePrimitives([])), []),
    ];
    const input = [1, 1, 2];
    const output = attempt(() => dedupePrimitives(input));
    checks.push(Array.isArray(output) && output !== input);
    checks.push(JSON.stringify(input) === '[1,1,2]');
    let rejected = 0;
    for (const run of [
      () => dedupePrimitives('abc'),
      () => dedupePrimitives(null),
      () => dedupePrimitives([{}]),
      () => dedupePrimitives([[1]]),
      () => dedupePrimitives([() => 1]),
      () => dedupePrimitives([new Date(0)]),
      () => dedupePrimitives([new Map()]),
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
