import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWaves, validateTasks } from '../src/index.js';

test('stable waves contain only tasks whose prerequisites finished earlier', () => {
  const tasks = [
    { id: 'api' }, { id: 'ui' }, { id: 'tests', dependsOn: ['api', 'ui'] },
    { id: 'docs' }, { id: 'release', dependsOn: ['tests'] },
  ];
  assert.deepEqual(buildWaves(tasks), [['api', 'ui', 'docs'], ['tests'], ['release']]);
  assert.deepEqual(tasks[2].dependsOn, ['api', 'ui']);
});

test('empty graph and validation return expected values', () => {
  assert.deepEqual(buildWaves([]), []);
  assert.equal(validateTasks([{ id: 'one' }]).length, 1);
});

test('invalid ids, dependencies, and cycles fail', () => {
  assert.throws(() => buildWaves(null), TypeError);
  assert.throws(() => buildWaves([{ id: 'a' }, { id: 'a' }]), Error);
  assert.throws(() => buildWaves([{ id: 'a', dependsOn: ['missing'] }]), Error);
  assert.throws(() => buildWaves([{ id: 'a', dependsOn: ['a'] }]), Error);
  assert.throws(() => buildWaves([{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }]), Error);
});
