import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('thread change events refresh the current root once the summary matches', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:root' });
  h.state.rootSessionId = 'codex:root';
  h.state.sessionThreads = [{
    sessionId: 'codex:root',
    status: 'completed',
  }];

  let refreshes = 0;
  h.window.refreshSessionThreads = async () => {
    refreshes++;
    return [{
      sessionId: 'codex:root',
      status: 'completed',
    }, {
      sessionId: 'codex:child',
      parentSessionId: 'codex:root',
      status: 'running',
    }];
  };

  h.hooks.handleWsMessage({
    action: 'session_threads_changed',
    deviceName: 'other-device',
    roots: [{
      projectHash: '-h',
      rootSessionId: 'codex:root',
      agentCount: 1,
      runningAgentCount: 1,
      needsInputAgentCount: 0,
    }],
  });
  h.hooks.handleWsMessage({
    action: 'session_threads_changed',
    deviceName: 'D',
    roots: [{
      projectHash: '-h',
      rootSessionId: 'codex:other-root',
      agentCount: 1,
      runningAgentCount: 1,
      needsInputAgentCount: 0,
    }],
  });
  await h.tick(250);
  assert.equal(refreshes, 0);

  h.hooks.handleWsMessage({
    action: 'session_threads_changed',
    deviceName: 'D',
    roots: [{
      projectHash: '-h',
      rootSessionId: 'codex:root',
      agentCount: 1,
      runningAgentCount: 1,
      needsInputAgentCount: 0,
    }],
  });

  await h.tick(250);
  assert.equal(refreshes, 1);
  await h.tick(1000);
  assert.equal(refreshes, 1);
});
