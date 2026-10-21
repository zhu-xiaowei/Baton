import assert from 'node:assert/strict';
import test from 'node:test';

import { createStreamCallbacks } from '../../bridge/ws.mjs';

test('a message sent during a Goal continuation joins it, and the next send starts fresh', async () => {
  const sessionId = 'codex:goal-interject';
  const options = { runtime: 'codex', nativeSessionId: 'goal-interject', syncStatus: false };
  const goal = createStreamCallbacks(sessionId, 'goal-turn', '', () => {}, {
    ...options, goalContinuation: true,
  });

  const interjection = createStreamCallbacks(sessionId, 'user-1', '', () => {}, {
    ...options, userInitiated: true,
  });
  assert.equal(interjection, goal);

  goal.onResult(sessionId, { consumedInputIds: ['user-1'] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(goal.liveTurn.isEnded(), true);

  const next = createStreamCallbacks(sessionId, 'user-2', '', () => {}, {
    ...options, userInitiated: true,
  });
  assert.notEqual(next, goal);
  next.onResult(sessionId, { consumedInputIds: ['user-2'] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(next.liveTurn.isEnded(), true);
});
