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
    const { deepEqualJson } = await import(
      pathToFileURL(path.join(root, 'src', 'deep-equal-json.js')).href + `?grade=${Date.now()}`
    );
    const checks = [
      attempt(() => deepEqualJson({ a: 1, b: [1, 2, { c: null }] }, { b: [1, 2, { c: null }], a: 1 })) === true,
      attempt(() => deepEqualJson([1, 2, 3], [1, 3, 2])) === false,
      attempt(() => deepEqualJson({ a: 1 }, { a: 2 })) === false,
      attempt(() => deepEqualJson({ a: 1 }, { a: '1' })) === false,
      attempt(() => deepEqualJson([], {})) === false,
      attempt(() => deepEqualJson({}, {})) === true,
      attempt(() => deepEqualJson([], [])) === true,
      attempt(() => deepEqualJson({ a: 1 }, { a: 1, b: 2 })) === false,
      attempt(() => deepEqualJson({ a: [1, { b: [] }] }, { a: [1, { b: [] }] })) === true,
      attempt(() => deepEqualJson(0, 0)) === true,
      attempt(() => deepEqualJson(0, false)) === false,
      attempt(() => deepEqualJson('a', 'a')) === true,
      attempt(() => deepEqualJson(null, null)) === true,
      attempt(() => deepEqualJson(null, 0)) === false,
      attempt(() => deepEqualJson([[1, 2], [3]], [[1, 2], [3, 4]])) === false,
      attempt(() => deepEqualJson({ x: 1, y: 2 }, { y: 2, x: 1 })) === true,
    ];
    const left = { a: [1, { b: 2 }] };
    const right = { a: [1, { b: 2 }] };
    const before = JSON.stringify(left);
    attempt(() => deepEqualJson(left, right));
    checks.push(JSON.stringify(left) === before && JSON.stringify(right) === before);
    const cyclic = {};
    cyclic.self = cyclic;
    const cyclicArray = [];
    cyclicArray.push(cyclicArray);
    let rejected = 0;
    for (const run of [
      () => deepEqualJson(Number.NaN, Number.NaN),
      () => deepEqualJson(Infinity, Infinity),
      () => deepEqualJson(undefined, null),
      () => deepEqualJson(null, undefined),
      () => deepEqualJson({ a: 1 }, { a: () => 1 }),
      () => deepEqualJson(Symbol('x'), Symbol('x')),
      () => deepEqualJson(1n, 1n),
      () => deepEqualJson(new Date(0), new Date(0)),
      () => deepEqualJson(new Map(), new Map()),
      () => deepEqualJson(new Set(), new Set()),
      () => deepEqualJson(cyclic, {}),
      () => deepEqualJson({}, cyclic),
      () => deepEqualJson(cyclicArray, []),
      () => deepEqualJson([1], [1, undefined]),
      () => deepEqualJson(class {}, class {}),
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
