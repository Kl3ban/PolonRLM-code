import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const { buildWaves, validateTasks } = await import(pathToFileURL(`${workspace}/src/index.js`).href + `?grade=${Date.now()}`);
    assert.equal(typeof buildWaves, 'function'); assert.equal(typeof validateTasks, 'function');
    const input = [{ id: 'a' }, { id: 'b' }, { id: 'c', dependsOn: ['a'] }, { id: 'd' }, { id: 'e', dependsOn: ['b', 'c'] }];
    const before = structuredClone(input);
    assert.deepEqual(buildWaves(input), [['a', 'b', 'd'], ['c'], ['e']]);
    assert.deepEqual(input, before);
    assert.deepEqual(buildWaves([]), []);
    assert.throws(() => validateTasks([{ id: 'x', dependsOn: ['y'] }]), Error);
    assert.throws(() => buildWaves([{ id: 'x' }, { id: 'x' }]), Error);
    assert.throws(() => buildWaves([{ id: 'x', dependsOn: ['x'] }]), Error);
    assert.throws(() => buildWaves([{ id: 'x', dependsOn: ['y'] }, { id: 'y', dependsOn: ['x'] }]), Error);
    return { passed: true, summary: 'stable parallel waves, validation, cycle detection, and immutability passed' };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
