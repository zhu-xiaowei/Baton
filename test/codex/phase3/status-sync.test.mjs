import assert from 'node:assert/strict';
import test from 'node:test';
import { statusSyncFixture } from './status-sync-fixture.mjs';

test('the real metadata publisher sends five native active roots and the archived tree independently', async () => {
  const { target, active, calls } = await statusSyncFixture();
  const sessions = calls.filter((call) => call.endpoint.endsWith('sync-sessions')).flatMap((call) => call.body.sessions);
  assert.deepEqual(sessions.filter((session) => !session.parentSessionId && session.status === 'running')
    .map((session) => session.id).sort(), [...active].sort());
  const root = sessions.find((session) => session.id === target);
  assert.equal(root.status, 'completed');
  assert.equal(root.agentCount, 11);
  assert.equal(root.runningAgentCount, 0);
  const archive = calls.filter((call) => call.endpoint.endsWith('sync-archives'))
    .flatMap((call) => call.body.observations).find((row) => row.sessionId === `codex:${target}`);
  assert.equal(archive.archiveState, 'archived');
});
