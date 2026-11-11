import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveConfig } from '../src/resolve.js';

test('layers nested values and keeps false, zero, null, and empty string', () => {
  assert.deepEqual(resolveConfig(
    { timeoutMs: 0, enabled: false, headers: { accept: null, authorization: '' }, endpoints: ['/user'] },
    { retries: 0, headers: { userAgent: 'workspace' } },
  ), {
    timeoutMs: 0, retries: 0, enabled: false,
    headers: { accept: null, userAgent: 'workspace', authorization: '' },
    endpoints: ['/user'],
  });
});

test('does not mutate defaults, user settings, or workspace settings', () => {
  const user = { headers: { accept: 'text/plain' }, endpoints: ['/user'] };
  const workspace = { headers: { userAgent: 'custom' }, endpoints: ['/workspace'] };
  const beforeUser = structuredClone(user);
  const beforeWorkspace = structuredClone(workspace);
  const result = resolveConfig(user, workspace);
  result.headers.accept = 'changed';
  result.endpoints.push('/changed');
  assert.deepEqual(user, beforeUser);
  assert.deepEqual(workspace, beforeWorkspace);
  assert.equal(resolveConfig().headers.accept, 'application/json');
});

test('later arrays and scalar objects replace instead of concatenate or merge', () => {
  assert.deepEqual(resolveConfig({ endpoints: ['/user'], headers: 'disabled' }, { endpoints: [], headers: { accept: 'text/plain' } }), {
    timeoutMs: 5000, retries: 2, enabled: true,
    headers: { accept: 'text/plain' }, endpoints: [],
  });
});
