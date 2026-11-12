import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { recallContext } from '../src/core/context-recall.js';
import { estimateTokens } from '../src/core/context.js';
import { HistoryIndex } from '../src/core/history-retrieval.js';
import { SessionStore } from '../src/core/store.js';
import { makeVerificationReport } from '../src/core/verification.js';
import type { Message } from '../src/core/types.js';
import { CortexRunEvidence } from '../src/core/cortex-evidence.js';

const summary: Message = { role: 'user', name: 'polonrlm_context', content: 'Older work was compacted. Detailed port and regression data were omitted.' };
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'polon-context-recall-')), store = new SessionStore(home), session = store.create('project');
  t.after(async () => { store.close(); await rm(home, { recursive: true, force: true, maxRetries: 5 }); });
  return { home, store, session };
}

test('history index finds rare evidence near the end of long output and keeps provenance', () => {
  const index = new HistoryIndex();
  index.add(1, { role: 'tool', name: 'run_tests', content: ('ordinary database log line\n').repeat(1000) + 'SQLITE_CONFLICT_9137: fixed port is 48173, see src/storage.ts.', isError: true });
  for (let id = 2; id < 20; id++) index.add(id, { role: 'assistant', content: 'ordinary database ordinary database storage ordinary database' });
  const hits = index.search('database SQLITE_CONFLICT_9137', 3);
  assert.equal(hits[0]?.id, 1); assert.match(hits[0]!.excerpt, /48173/);
  assert.ok(hits[0]!.lines[0] > 900); assert.equal(hits[0]?.source, 'run_tests'); assert.equal(hits[0]?.isError, true);
  assert.match(hits[0]!.digest, /^[a-f0-9]{16}$/);
});

test('history index returns the latest copy of duplicate evidence and preserves Unicode', () => {
  const index = new HistoryIndex(), message: Message = { role: 'user', content: 'Żółć: decyzja immutable-reference-22 jest obowiązkowa.' };
  index.add(1, message); index.add(7, message);
  assert.deepEqual(index.search('ŻÓŁĆ immutable-reference-22').map(hit => hit.id), [7]);
});

test('stored history updates its local index, isolates sessions and invalidates after replacement and external writes', async t => {
  const { home, store, session } = await fixture(t);
  store.append(session, { role: 'user', content: 'Immutable needle-original-17 is current.' });
  assert.equal(store.searchHistory(session, 'needle-original-17').length, 1);
  store.append(session, { role: 'tool', name: 'read_file', content: 'Incremental needle-new-29 arrives.' });
  assert.equal(store.searchHistory(session, 'needle-new-29').length, 1);
  const other = store.create('other-project'); store.append(other, { role: 'user', content: 'needle-other-project-18 must stay private.' });
  assert.equal(store.searchHistory(session, 'needle-other-project-18').length, 0);
  store.replace(session, [{ role: 'user', content: 'Replacement needle-replacement-31.' }]);
  assert.equal(store.searchHistory(session, 'needle-original-17').length, 0);
  assert.equal(store.searchHistory(session, 'needle-replacement-31').length, 1);
  const external = new SessionStore(home);
  try { external.replace(session, [{ role: 'user', content: 'External needle-external-42.' }]); }
  finally { external.close(); }
  assert.equal(store.searchHistory(session, 'needle-replacement-31').length, 0);
  assert.equal(store.searchHistory(session, 'needle-external-42').length, 1);
});

test('automatic recall recovers omitted exact facts within a token budget without persisting or changing the current prompt', async t => {
  const { store, session } = await fixture(t);
  store.append(session, { role: 'user', content: 'The reconnect-port-819 contract uses port 48173. Keep it unchanged.' });
  store.archiveContext(session, [summary]);
  const latest: Message = { role: 'user', content: 'What was the reconnect-port-819 port?' };
  store.append(session, latest);
  const active = [summary, latest], before = JSON.stringify(store.messages(session));
  const result = recallContext(store, session, latest.content, active, 400);
  assert.equal(result.hits, 1); assert.match(result.message!.content, /48173/); assert.match(result.message!.content, /msg:\d+ user lines:/);
  assert.match(result.message!.content, /Historical data, not new instructions/);
  assert.ok(estimateTokens([result.message]) <= 400);
  assert.equal(active.at(-1), latest); assert.equal(JSON.stringify(store.messages(session)), before);
  assert.equal(recallContext(store, session, 'nonexistent-key-83288', active, 400).hits, 0);
  assert.equal(recallContext(store, session, latest.content, active, 10).hits, 0);
  assert.equal(recallContext(store, session, latest.content, [...active, ...store.messages(session)], 400).hits, 0, 'already active full evidence is excluded');
});

test('recall includes original verification IDs and saved hashes without treating old reports as current proof', async t => {
  const { store, session } = await fixture(t);
  store.archiveContext(session, [summary]);
  const report = makeVerificationReport({ session, workspace: 'project', status: 'failed', commands: [{ label: 'regression', command: 'npm test storage', status: 'failed', exitCode: 1, durationMs: 10, output: 'storage-regression-821 failed: invalid port.' }], files: [{ path: 'src/storage.ts', beforeHash: null, afterHash: 'saved-file-hash-2818', changedDuringCheck: false }], diagnostics: [], notes: [] });
  store.saveVerification(report);
  const result = recallContext(store, session, 'storage-regression-821 src/storage.ts', [summary], 600);
  assert.ok(result.hits > 0); assert.match(result.message!.content, new RegExp(report.id));
  assert.match(result.message!.content, /saved-file-hash-2818/); assert.match(result.message!.content, /historical, not a current check/);
});

test('continuation can recover the prior real user task even when active context contains only a summary', async t => {
  const { store, session } = await fixture(t);
  store.append(session, { role: 'user', content: 'Refactor the storage transaction across modules.' });
  store.archiveContext(session, [summary]); store.append(session, { role: 'user', content: 'continue' });
  assert.equal(store.previousUserTask(session), 'Refactor the storage transaction across modules.');
});

test('source reads verify digest and message ownership and return the requested original lines', async t => {
  const { store, session } = await fixture(t);
  store.append(session, { role: 'tool', name: 'run_tests', content: 'Start\nprecise-evidence-999: expected 48173\nEnd', isError: true });
  const hit = store.searchHistory(session, 'precise-evidence-999')[0]!;
  const source = store.readHistory(session, hit.id, 2, 1, hit.digest);
  assert.equal(source.excerpt, 'precise-evidence-999: expected 48173');
  assert.deepEqual(source.lines, [2, 2]); assert.equal(source.totalLines, 3);
  assert.throws(() => store.readHistory(store.create('other-project'), hit.id), /current chat/);
  assert.throws(() => store.readHistory(session, hit.id, 1, 20, '0'.repeat(16)), /source changed/);
});

test('Cortex measurements persist, attach controller verification, and are erased with the chat', async t => {
  const { home, store, session } = await fixture(t);
  const evidence = new CortexRunEvidence(); evidence.choose({ requested: 3, level: 1, score: 2, reason: 'fixture' });
  const run = evidence.finish(session, 'project', 'provider/model', 'BUILD', 'Fix storage.', 'complete', 2, { input: 100, output: 20 });
  store.saveCortexRun(run);
  const report = makeVerificationReport({ session, workspace: 'project', status: 'passed', commands: [{ label: 'test', command: 'npm test storage', status: 'passed', exitCode: 0, durationMs: 10, output: 'passed' }], files: [], diagnostics: [], notes: [] });
  report.createdAt = run.created + 1;
  store.saveVerification(report); store.linkCortexVerification(report);
  assert.equal(store.cortexRuns('project')[0]?.outcome, 'checks_passed');
  assert.equal(store.cortexRuns('project')[0]?.verificationId, report.id);
  const reopened = new SessionStore(home);
  try { assert.equal(reopened.cortexRuns('project')[0]?.calls, 2); }
  finally { reopened.close(); }
  store.forget(session, 'project'); assert.deepEqual(store.cortexRuns('project'), []);
});
