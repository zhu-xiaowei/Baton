import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('entering an existing session subscribes on its Bridge and keeps the viewer row on the server', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: '' });
  h.state.rootSessionId = 'codex:thread-root';
  const sent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  h.window.subscribeSession('codex:thread-approval');

  assert.deepEqual(sent, [
    // The Bridge pushes a waiting permission prompt again on every subscription.
    { action: 'subscribe', sessionId: 'codex:thread-approval', device: 'D' },
    { action: 'subscribe', sessionId: 'ROOT#codex:thread-root' },
  ]);
});
