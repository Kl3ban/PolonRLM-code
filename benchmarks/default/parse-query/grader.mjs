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

function sameRecord(actual, expected) {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) return false;
  return expectedKeys.every(key => actual[key] === expected[key]);
}

export async function grade(root) {
  try {
    const { parseQuery } = await import(
      pathToFileURL(path.join(root, 'src', 'parse-query.js')).href + `?grade=${Date.now()}`
    );
    const checks = [
      sameRecord(attempt(() => parseQuery('a=1&b=2')), { a: '1', b: '2' }),
      sameRecord(attempt(() => parseQuery('?a=1&b=2')), { a: '1', b: '2' }),
      sameRecord(attempt(() => parseQuery('a=1&a=2')), { a: '2' }),
      sameRecord(attempt(() => parseQuery('a=1&b=2&a=3')), { a: '3', b: '2' }),
      sameRecord(attempt(() => parseQuery('q=hello+world')), { q: 'hello world' }),
      sameRecord(attempt(() => parseQuery('x=%E2%9C%93')), { x: '✓' }),
      sameRecord(attempt(() => parseQuery('flag')), { flag: '' }),
      sameRecord(attempt(() => parseQuery('a=1&&b=2&')), { a: '1', b: '2' }),
      sameRecord(attempt(() => parseQuery('')), {}),
      sameRecord(attempt(() => parseQuery('?')), {}),
      sameRecord(attempt(() => parseQuery('=x')), {}),
      sameRecord(attempt(() => parseQuery('&')), {}),
      sameRecord(attempt(() => parseQuery('a=b=c')), { a: 'b=c' }),
      sameRecord(attempt(() => parseQuery('a=%26')), { a: '&' }),
      sameRecord(attempt(() => parseQuery('a=%2B1')), { a: '+1' }),
      sameRecord(attempt(() => parseQuery('name=Tom+%26+Jerry')), { name: 'Tom & Jerry' }),
      sameRecord(attempt(() => parseQuery('a=1&b')), { a: '1', b: '' }),
      sameRecord(attempt(() => parseQuery('key%20with%20space=v%2F1')), { 'key with space': 'v/1' }),
      sameRecord(attempt(() => parseQuery('?a=')), { a: '' }),
    ];
    const value = attempt(() => parseQuery('a=1'));
    checks.push(value !== null && typeof value === 'object' && !Array.isArray(value));
    attempt(() => parseQuery('a=1'));
    checks.push(sameRecord(attempt(() => parseQuery('b=2')), { b: '2' }));
    let rejected = 0;
    for (const run of [
      () => parseQuery(42),
      () => parseQuery(null),
      () => parseQuery(undefined),
      () => parseQuery(['a=1']),
      () => parseQuery({ a: 1 }),
      () => parseQuery('%ZZ=1'),
      () => parseQuery('a=%E0%A4%A'),
      () => parseQuery('a=%'),
      () => parseQuery('a=100%'),
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
