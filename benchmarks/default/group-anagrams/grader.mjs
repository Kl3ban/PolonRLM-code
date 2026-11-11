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

function sameGroups(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((group, index) => Array.isArray(group) && JSON.stringify(group) === JSON.stringify(expected[index]));
}

export async function grade(root) {
  try {
    const { groupAnagrams } = await import(
      pathToFileURL(path.join(root, 'src', 'group-anagrams.js')).href + `?grade=${Date.now()}`
    );
    const checks = [
      sameGroups(attempt(() => groupAnagrams(['eat', 'tea', 'tan', 'ate', 'nat', 'bat'])), [['eat', 'tea', 'ate'], ['tan', 'nat'], ['bat']]),
      sameGroups(attempt(() => groupAnagrams(['ab', 'ba', 'ab'])), [['ab', 'ba', 'ab']]),
      sameGroups(attempt(() => groupAnagrams([])), []),
      sameGroups(attempt(() => groupAnagrams(['abc'])), [['abc']]),
      sameGroups(attempt(() => groupAnagrams(['a', 'b', 'c'])), [['a'], ['b'], ['c']]),
      sameGroups(attempt(() => groupAnagrams(['listen', 'silent', 'enlist'])), [['listen', 'silent', 'enlist']]),
      sameGroups(attempt(() => groupAnagrams(['abc', 'def', 'cab', 'fed'])), [['abc', 'cab'], ['def', 'fed']]),
      sameGroups(attempt(() => groupAnagrams(['zz', 'aa', 'zz'])), [['zz', 'zz'], ['aa']]),
      sameGroups(attempt(() => groupAnagrams(['ab', 'cd', 'ba', 'dc', 'ac'])), [['ab', 'ba'], ['cd', 'dc'], ['ac']]),
    ];
    const input = ['eat', 'tea', 'bat'];
    const before = JSON.stringify(input);
    attempt(() => groupAnagrams(input));
    checks.push(JSON.stringify(input) === before);
    let rejected = 0;
    for (const run of [
      () => groupAnagrams('abc'),
      () => groupAnagrams([1]),
      () => groupAnagrams(['']),
      () => groupAnagrams(['ab', 'a1']),
      () => groupAnagrams(['ab', 'AB']),
      () => groupAnagrams(['ab', 'a b']),
      () => groupAnagrams([null]),
      () => groupAnagrams(['ab', '']),
    ]) {
      if (rejectsTypeError(run)) rejected += 1;
    }
    checks.push(rejected === 8);
    const passed = checks.every(Boolean);
    return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
