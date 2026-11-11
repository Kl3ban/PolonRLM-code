import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCortex, cortexTaskText } from '../src/core/cortex.js';

test('adaptive Cortex lowers needless delegation and never raises the configured ceiling', () => {
  const simple = chooseCortex(5, 'What is 2 + 2?');
  assert.equal(simple.level, 0);
  assert.match(simple.reason, /small task/);

  const moderate = chooseCortex(5, 'Fix the provider model picker and add a regression test.');
  assert.ok(moderate.level > 0 && moderate.level < 5);

  const smallerCeiling = chooseCortex(2, 'Refactor auth across auth.ts, sessions.ts, and api.ts; add regression tests and verify the integration.');
  assert.ok(smallerCeiling.level <= 2);
});

test('fixed Cortex always honors the selected level and continuation reuses the prior task', () => {
  assert.equal(chooseCortex(5, 'What is 2 + 2?', 'fixed').level, 5);
  assert.equal(cortexTaskText('keep going', ['Refactor auth across three modules.']), 'Refactor auth across three modules.');
  assert.equal(cortexTaskText('Explain a small function.', ['An unrelated old task.']), 'Explain a small function.');
});
