import assert from 'node:assert/strict';
import test from 'node:test';
import { isProviderFailure, liveReviewFindings } from '../scripts/live-review-report.js';

test('live review recognizes upstream provider outages and rejects ordinary tool errors', () => {
  for (const message of [
    'deepseek-v4-flash-free is experiencing high demand right now',
    'The selected provider is temporarily busy. Wait briefly, then retry.',
    'HTTP 503 Service Unavailable',
    'HTTP 429 Too Many Requests',
    'request timed out after 120000ms',
  ]) assert.equal(isProviderFailure(message), true, message);

  assert.equal(isProviderFailure('read_file failed: path does not exist'), false);
  assert.equal(isProviderFailure(undefined), false);
});

test('provider outages are reported once and do not become failures for every uncalled tool', () => {
  const findings = liveReviewFindings({
    name: 'subagents-and-reviewed-apply',
    missing: ['delegate', 'agent_changes', 'agent_apply'],
    errors: [],
    fatal: 'deepseek-v4-flash-free is experiencing high demand right now',
    providerFailure: true,
  }, new Set());

  assert.deepEqual(findings, [{
    severity: 'high',
    area: 'subagents-and-reviewed-apply',
    status: 'provider unavailable before tool review completed',
    evidence: 'deepseek-v4-flash-free is experiencing high demand right now',
  }]);
});

test('ordinary case failures still report missing tools and unexpected tool errors', () => {
  const findings = liveReviewFindings({
    name: 'workspace-read-and-inspection',
    missing: ['read_file'],
    errors: [{ name: 'list_directory', error: 'permission denied' }],
    fatal: 'fixture assertion failed',
  }, new Set());

  assert.deepEqual(findings.map(finding => finding.status), [
    'required tool not called',
    'tool returned an error',
    'case failed',
  ]);
});

test('invalid model tool arguments are separated from tool implementation errors', () => {
  const findings = liveReviewFindings({
    name: 'documents-and-ocr',
    missing: [],
    errors: [{ name: 'request_tool', error: 'Invalid arguments for tool request_tool. The call was not executed. Choose a tool from the active list or use discover_tools.' }],
  }, new Set());

  assert.deepEqual(findings, [{
    severity: 'low',
    area: 'documents-and-ocr/request_tool',
    status: 'model returned invalid tool arguments; call was blocked',
    evidence: 'Invalid arguments for tool request_tool. The call was not executed. Choose a tool from the active list or use discover_tools.',
  }]);
});
