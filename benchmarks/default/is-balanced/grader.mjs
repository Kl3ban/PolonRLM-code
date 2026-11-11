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
    const { isBalanced } = await import(
      pathToFileURL(path.join(root, 'src', 'is-balanced.js')).href + `?grade=${Date.now()}`
    );
    const balanced = ['', '()', '[]', '{}', '([]{})', '([{}])', 'a(b)c[d]{e}', '((a)[b]{c})', '{a[b(c)d]e}', 'if (x) { return [1, (2)]; }', '((()))'];
    const unbalanced = ['(', ')', '((', '))', '(]', '([)]', '}{', '{(})', '(()', 'abc(def', '{[}]', ')]', '([})'];
    const checks = balanced.map(text => attempt(() => isBalanced(text)) === true);
    checks.push(...unbalanced.map(text => attempt(() => isBalanced(text)) === false));
    checks.push(attempt(() => typeof isBalanced('()')) === 'boolean');
    let rejected = 0;
    for (const run of [
      () => isBalanced(null),
      () => isBalanced(5),
      () => isBalanced([]),
      () => isBalanced({}),
      () => isBalanced(undefined),
    ]) {
      if (rejectsTypeError(run)) rejected += 1;
    }
    checks.push(rejected === 5);
    const passed = checks.every(Boolean);
    return { passed, summary: `${checks.filter(Boolean).length}/${checks.length} checks passed` };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
