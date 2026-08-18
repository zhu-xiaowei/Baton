import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('entering an existing session subscribes before requesting pending permission state', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: '' });
  const sent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  h.window.subscribeSession('codex:thread-approval');

  assert.deepEqual(sent, [
    {
      action: 'subscribe',
      sessionId: 'codex:thread-approval',
    },
    {
      action: 'reveal_permission',
      sessionId: 'codex:thread-approval',
      device: 'D',
    },
  ]);
});
