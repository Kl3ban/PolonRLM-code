import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessCortexProject, chooseCortex, cortexTaskText, escalateCortex } from '../src/core/cortex.js';
import { calibrateCortex, CortexRunEvidence, formatCortexStats, type CortexRunRecord } from '../src/core/cortex-evidence.js';

test('a typo mention does not override a security or cross-module task', () => {
  assert.ok(chooseCortex(5, 'Fix a typo, then refactor security across modules and add regression tests.').level >= 2);
  assert.equal(chooseCortex(5, 'Fix a spelling typo in a label.').level, 0);
});

function sample(level = 1): CortexRunRecord {
  const evidence = new CortexRunEvidence(); evidence.choose({ requested: 5, level, score: 3, reason: 'fixture' });
  evidence.observe(false, true); evidence.observe(false, false, 0);
  return evidence.finish('session', 'workspace', 'provider/model', 'BUILD', 'Fix a bug.', 'complete', 2, { input: 100, output: 20 });
}

test('Cortex feedback needs comparable check-backed evidence and respects the selected ceiling', () => {
  const decision = { requested: 5, level: 2, score: 3, reason: 'focused' };
  assert.equal(calibrateCortex(decision, 'bugfix', 'provider/model', 'BUILD', [sample(), sample()]).level, 2);
  const runs = [sample(), sample(), sample()];
  assert.equal(calibrateCortex(decision, 'bugfix', 'provider/model', 'BUILD', runs).level, 1);
  assert.equal(calibrateCortex(decision, 'bugfix', 'different/model', 'BUILD', runs).level, 2);
  assert.equal(calibrateCortex(decision, 'refactor', 'provider/model', 'BUILD', runs).level, 2);
  assert.equal(calibrateCortex(decision, 'bugfix', 'provider/model', 'BUILD', [...runs, { ...sample(), peakLevel: 2 }]).level, 2, 'a lower-level run that required escalation blocks downshifting');
  assert.equal(calibrateCortex(decision, 'bugfix', 'provider/model', 'BUILD', runs.map(run => ({ ...run, outcome: 'unverified' }))).level, 2);
  const failures = [sample(2), sample(2)].map(run => ({ ...run, outcome: 'checks_failed' as const }));
  assert.equal(calibrateCortex(decision, 'bugfix', 'provider/model', 'BUILD', failures).level, 3);
  assert.equal(calibrateCortex({ ...decision, requested: 2 }, 'bugfix', 'provider/model', 'BUILD', failures).level, 2);
});

test('Cortex evidence invalidates old checks after a change and never counts an unchecked answer as success', () => {
  const evidence = new CortexRunEvidence(); evidence.choose({ requested: 3, level: 1, score: 2, reason: 'fixture' });
  const finish = () => evidence.finish('s', 'w', 'm', 'BUILD', 'Fix bug.', 'complete', 1, { input: 10, output: 5 });
  assert.equal(finish().outcome, 'unverified');
  evidence.observe(false, false, 0); assert.equal(finish().outcome, 'checks_passed');
  evidence.observe(false, true); assert.equal(finish().outcome, 'unverified');
  evidence.observe(false, false, 1); assert.equal(finish().outcome, 'checks_failed');
  evidence.stalled = true; assert.equal(finish().outcome, 'stalled');
  assert.match(formatCortexStats([sample()]), /not proof the whole task is correct/);
});

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
