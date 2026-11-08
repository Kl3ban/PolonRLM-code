import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentTeam } from '../src/core/agent-team.js';
import type { AgentInfo } from '../src/core/types.js';

test('agent team delivers only to the selected live peer and bounds messages', () => {
  const researcher: AgentInfo = { id: 'researcher1', role: 'researcher', status: 'running' };
  const reviewer: AgentInfo = { id: 'reviewer1', role: 'reviewer', status: 'running' };
  const finished: AgentInfo = { id: 'finished1', role: 'coder', status: 'done' };
  const team = new AgentTeam([researcher, reviewer, finished]);

  assert.deepEqual(team.peers(researcher.id).map(peer => peer.id), [reviewer.id, finished.id]);
  assert.match(team.send(researcher.id, reviewer.id, 'Check the parser boundary.'), /queued/);
  assert.deepEqual(team.take(reviewer.id), [{ from: researcher.id, role: researcher.role, content: 'Check the parser boundary.' }]);
  assert.deepEqual(team.take(researcher.id), []);
  assert.throws(() => team.send(researcher.id, researcher.id, 'Self message.'), /another agent/);
  assert.match(team.send(researcher.id, finished.id, 'Late message.'), /results for the coordinator/);
  assert.deepEqual(team.pending(finished.id), [{ from: researcher.id, role: researcher.role, content: 'Late message.' }]);
  assert.throws(() => team.send(researcher.id, reviewer.id, '\u001b[2J\u001b[0m'), /Message is empty/);
  for (let index = 0; index < 2; index++) team.send(researcher.id, reviewer.id, `Note ${index}.`);
  assert.throws(() => team.send(researcher.id, reviewer.id, 'One too many.'), /at most 4 messages/);
});
