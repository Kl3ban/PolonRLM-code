import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/core/store.js';
import { formatEvidenceTimeline } from '../src/core/evidence.js';
import { makeVerificationReport } from '../src/core/verification.js';

test('evidence timeline merges model, tool and verification records without exposing full outputs', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-evidence-'));
  const store = new SessionStore(home);
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const session = store.create(path.join(home, 'project'));
  store.audit(session, 'read_file', { arguments: { path: 'src/app.ts' }, result: 'FULL_FILE_CONTENT_SHOULD_NOT_APPEAR', isError: false, agent: 'coder', durationMs: 42 });
  store.audit(session, 'model_request', { provider: 'custom', model: 'flash-test', agent: 'orchestrator', status: 'done', durationMs: 80,
    usage: { input: 100, output: 20, cached: 0, cost: 0.00004, costKnown: true } });
  const report = { ...makeVerificationReport({ session, workspace: path.join(home, 'project'), status: 'failed', commands: [
    { label: 'test', command: 'npm test', status: 'failed', exitCode: 1, durationMs: 300, output: 'failure detail' },
  ], diagnostics: [], files: [{ path: 'src/app.ts', beforeHash: 'before', afterHash: 'after', changedDuringCheck: false }], notes: [] }), createdAt: Date.now() + 1000 };
  store.saveVerification(report);

  const entries = store.evidenceTimeline(session, 20);
  assert.deepEqual(entries.map(entry => entry.kind), ['verification', 'model', 'tool']);
  const output = formatEvidenceTimeline(entries);
  assert.match(output, /Latest \/verify evidence: FAILED/);
  assert.match(output, /custom\/flash-test.*120 tokens/);
  assert.match(output, /Read file: src\/app\.ts/);
  assert.doesNotMatch(output, /FULL_FILE_CONTENT_SHOULD_NOT_APPEAR|failure detail/);
});

test('evidence timeline limit is bounded and empty history is explicit', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polonrlm-evidence-empty-'));
  const store = new SessionStore(home);
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true }); });
  const session = store.create(path.join(home, 'project'));
  assert.deepEqual(store.evidenceTimeline(session, 10), []);
  assert.match(formatEvidenceTimeline([]), /No evidence has been recorded/);
  assert.throws(() => store.evidenceTimeline(session, 201), /between 1 and 200/);
});
