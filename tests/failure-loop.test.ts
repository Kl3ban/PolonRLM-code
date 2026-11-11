import test from 'node:test';
import assert from 'node:assert/strict';
import { FailureLoopGuard } from '../src/core/failure-loop.js';

test('failure loop fingerprints ignore stack line numbers and elapsed-time noise', () => {
  const guard = new FailureLoopGuard(2);
  assert.equal(guard.observe('run_tests', 'Assertion failed at test.spec.ts:12:4 after 18ms').count, 1);
  const repeated = guard.observe('run_tests', 'Assertion failed at test.spec.ts:88:2 after 42ms');
  assert.equal(repeated.count, 2);
  assert.match(repeated.notice ?? '', /same run_tests failure occurred 2 times/);
});

test('failure loop warns when one tool keeps failing with changing diagnostics', () => {
  const guard = new FailureLoopGuard(3);
  assert.equal(guard.observe('run_tests', 'Expected true but received false').count, 1);
  assert.equal(guard.observe('run_tests', 'Missing export: parseConfig').count, 1);
  const repeated = guard.observe('run_tests', 'Module not found: plugin-core');
  assert.equal(repeated.count, 3);
  assert.match(repeated.notice ?? '', /failed 3 times without verified progress, with changing errors/);
});
