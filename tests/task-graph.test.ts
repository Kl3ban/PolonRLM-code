import test from 'node:test';
import assert from 'node:assert/strict';
import { taskGraphWaves } from '../src/core/task-graph.js';

test('task graph forms stable parallel waves and resolves dependencies declared later', () => {
  const waves = taskGraphWaves([
    { id: 'integration', dependsOn: ['backend', 'frontend'], value: 4 },
    { id: 'backend', dependsOn: ['analysis'], value: 2 },
    { id: 'analysis', value: 1 },
    { id: 'frontend', dependsOn: ['analysis'], value: 3 },
    { id: 'docs', value: 5 },
  ]);
  assert.deepEqual(waves.map(wave => wave.map(node => node.id)), [['analysis', 'docs'], ['backend', 'frontend'], ['integration']]);
  assert.deepEqual(waves[2]![0]!.task, { id: 'integration', dependsOn: ['backend', 'frontend'], value: 4 });
});

test('task graph assigns deterministic IDs to independent legacy delegation tasks', () => {
  const waves = taskGraphWaves([{ value: 'a' }, { value: 'b' }]);
  assert.deepEqual(waves.map(wave => wave.map(node => node.id)), [['task-1', 'task-2']]);
});

test('task graph rejects duplicate IDs, repeated/unknown dependencies, self dependencies and cycles', () => {
  assert.throws(() => taskGraphWaves([{ id: 'same' }, { id: 'same' }]), /Duplicate task ID/);
  assert.throws(() => taskGraphWaves([{ id: 'child', dependsOn: ['missing'] }]), /unknown task missing/);
  assert.throws(() => taskGraphWaves([{ id: 'child', dependsOn: ['child'] }]), /cannot depend on itself/);
  assert.throws(() => taskGraphWaves([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), /dependency cycle/);
  assert.throws(() => taskGraphWaves([{ id: 'child', dependsOn: ['base', 'base'] }, { id: 'base' }]), /more than once/);
});
