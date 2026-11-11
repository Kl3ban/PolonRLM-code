import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCortexProject, chooseCortex, cortexTaskText, escalateCortex } from '../src/core/cortex.js';

test('adaptive Cortex lowers needless delegation and never raises the configured ceiling', () => {
  const simple = chooseCortex(5, 'What is 2 + 2?');
  assert.equal(simple.level, 0);
  assert.match(simple.reason, /small task/);

  const moderate = chooseCortex(5, 'Fix the provider model picker and add a regression test.');
  assert.ok(moderate.level > 0 && moderate.level < 5);

  const smallerCeiling = chooseCortex(2, 'Refactor auth across auth.ts, sessions.ts, and api.ts; add regression tests and verify the integration.');
  assert.ok(smallerCeiling.level <= 2);
});

test('Cortex project analysis raises effort from repository size and never exceeds the ceiling', () => {
  const decision = { requested: 4, level: 1, score: 2, reason: 'focused task' };
  assert.equal(assessCortexProject(decision, { sourceFiles: 20, importEdges: 10, truncated: false }).level, 1);
  assert.equal(assessCortexProject(decision, { sourceFiles: 120, importEdges: 20, truncated: false }).level, 1);
  assert.equal(assessCortexProject({ ...decision, level: 0 }, { sourceFiles: 120, importEdges: 20, truncated: false }).level, 1);
  assert.equal(assessCortexProject(decision, { sourceFiles: 300, importEdges: 20, truncated: false }).level, 2);
  assert.equal(assessCortexProject(decision, { sourceFiles: 20, importEdges: 20, truncated: true }).level, 2);
  assert.equal(assessCortexProject({ ...decision, requested: 2 }, { sourceFiles: 300, importEdges: 20, truncated: true }).level, 2);
  assert.equal(assessCortexProject({ ...decision, level: 3 }, { sourceFiles: 300, importEdges: 200, truncated: false }).level, 3);
});

test('Cortex escalation raises effort by one level and respects the requested ceiling', () => {
  const decision = { requested: 4, level: 1, score: 2, reason: 'focused task' };
  const first = escalateCortex(decision, 'repeated failure');
  assert.equal(first.level, 2);
  assert.match(first.reason, /stagnation/);
  assert.equal(escalateCortex({ ...first, level: 4 }, 'again').level, 4);
  assert.deepEqual(escalateCortex({ requested: 0, level: 0, score: 0, reason: 'small' }, 'again'), { requested: 0, level: 0, score: 0, reason: 'small' });
});

test('fixed Cortex always honors the selected level and continuation reuses the prior task', () => {
  assert.equal(chooseCortex(5, 'What is 2 + 2?', 'fixed').level, 5);
  assert.equal(cortexTaskText('keep going', ['Refactor auth across three modules.']), 'Refactor auth across three modules.');
  assert.equal(cortexTaskText('Explain a small function.', ['An unrelated old task.']), 'Explain a small function.');
});
