import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function grade(workspace) {
  try {
    const mod = await import(pathToFileURL(`${workspace}/src/resolve.js`).href + `?grade=${Date.now()}`);
    const { resolveConfig } = mod;
    assert.equal(typeof resolveConfig, 'function');
    const user = { timeoutMs: 0, enabled: false, headers: { accept: null, authorization: '' }, endpoints: ['/user'] };
    const local = { retries: 0, headers: { userAgent: 'local' } };
    const userBefore = structuredClone(user);
    const localBefore = structuredClone(local);
    const result = resolveConfig(user, local);
    assert.deepEqual(result, { timeoutMs: 0, retries: 0, enabled: false,
      headers: { accept: null, userAgent: 'local', authorization: '' }, endpoints: ['/user'] });
    assert.deepEqual(user, userBefore);
    assert.deepEqual(local, localBefore);
    result.headers.accept = 'mutated';
    assert.equal(resolveConfig().headers.accept, 'application/json');
    assert.deepEqual(resolveConfig({ endpoints: ['/user'] }, { endpoints: [] }).endpoints, []);
    assert.equal(resolveConfig({ retries: undefined }).retries, 2);
    return { passed: true, summary: 'layered values, falsy overrides, arrays, undefined, and immutability passed' };
  } catch (error) {
    return { passed: false, summary: error instanceof Error ? error.message : String(error) };
  }
}
