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

function same(actual, expected) {
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    return actual.every((value, index) => same(value, expected[index]));
  }
  return Object.is(actual, expected);
}

export async function grade(root) {
  try {
    const { flattenDepth } = await import(
      pathToFileURL(path.join(root, 'src', 'flatten-depth.js')).href + `?grade=${Date.now()}`
    );
    const checks = [
      same(attempt(() => flattenDepth([1, [2, [3, [4]]]], 1)), [1, 2, [3, [4]]]),
      same(attempt(() => flattenDepth([1, [2, [3, [4]]]], 2)), [1, 2, 3, [4]]),
      same(attempt(() => flattenDepth([1, [2, [3, [4]]]], 3)), [1, 2, 3, 4]),
      same(attempt(() => flattenDepth([1, [2, [3, [4]]]], 99)), [1, 2, 3, 4]),
      same(attempt(() => flattenDepth([], 3)), []),
      same(attempt(() => flattenDepth([1, 2, 3], 0)), [1, 2, 3]),
      same(attempt(() => flattenDepth([[], [[1]]], 1)), [[1]]),
      same(attempt(() => flattenDepth([[], [[1]]], 2)), [1]),
      same(attempt(() => flattenDepth([[[[1]]]], 2)), [[1]]),
      same(attempt(() => flattenDepth([1, [2]], 0)), [1, [2]]),
    ];
    const object = { a: 1 };
    const kept = attempt(() => flattenDepth([object, [object]], 1));
    checks.push(Array.isArray(kept) && kept.length === 2 && kept[0] === object && kept[1] === object);
    const withUndefined = attempt(() => flattenDepth([undefined, [undefined]], 1));
    checks.push(Array.isArray(withUndefined) && withUndefined.length === 2 && withUndefined[0] === undefined && withUndefined[1] === undefined);
    const source = [1, [2]];
    const shallow = attempt(() => flattenDepth(source, 0));
    checks.push(Array.isArray(shallow) && shallow !== source && same(shallow, source) && shallow[1] === source[1]);
    const input = [1, [2, [3]]];
    const before = JSON.stringify(input);
    attempt(() => flattenDepth(input, 5));
    checks.push(JSON.stringify(input) === before);
    let rejected = 0;
    for (const run of [
      () => flattenDepth('no', 1),
      () => flattenDepth(null, 1),
      () => flattenDepth([1], -1),
      () => flattenDepth([1], 1.5),
      () => flattenDepth([1], '1'),
      () => flattenDepth([1], Number.NaN),
      () => flattenDepth([1], Infinity),
      () => flattenDepth([1], undefined),
      () => flattenDepth([1], null),
    ]) {
      if (rejectsTypeError(run)) rejected += 1;
    }
    checks.push(rejected === 9);
    const passed = checks.every(Boolean);
    return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
