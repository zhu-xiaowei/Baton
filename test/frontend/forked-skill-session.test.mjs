import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const harness = await makeHarness();

test('a running forked-skill session with no history shows an empty list and the spinner', async () => {
  resetSession(harness, { sessionId: 'skill-session' });
  harness.state.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  harness.state.deviceOnlineMap = { D: true };
  harness.document.getElementById('content').innerHTML = '<div class="messages skeleton-messages"></div>';
  harness.setApiHandler(() => ({ messages: [], hasMore: false, status: 'running' }));

  await harness.window.loadLatestMessages('skill-session');
  assert.equal(harness.document.querySelector('.skeleton-messages'), null);
  assert.ok(harness.document.querySelector('.messages'));
  assert.equal(harness.document.querySelector('.empty'), null);
  assert.equal(harness.state.wsRunning, true);
});

test.after(() => {
  harness.window.disconnectWs();
  harness.window.close();
});
