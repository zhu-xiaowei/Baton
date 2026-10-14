import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const harness = await makeHarness();

test('a running forked-skill session with no history leaves the loading skeleton', async () => {
  resetSession(harness, { sessionId: 'skill-session' });
  harness.state.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  harness.state.deviceOnlineMap = { D: true };
  globalThis.skeletonMessages = () => '<div class="messages skeleton-messages"></div>';
  harness.setApiHandler(() => ({ messages: [], hasMore: false, needSync: true, status: 'running' }));

  await harness.window.loadLatestMessages('skill-session');
  assert.ok(harness.document.querySelector('.skeleton-messages'));

  // updateSpinner hides the spinner while the skeleton is present.
  const spinnerChecks = [];
  globalThis.updateSpinner = harness.window.updateSpinner = () => {
    spinnerChecks.push(!harness.document.querySelector('.skeleton-messages'));
  };
  harness.hooks.handleWsMessage({
    action: 'sync_complete', sessionId: 'skill-session', status: 'ok', count: 0,
  });
  assert.equal(harness.document.querySelector('.skeleton-messages'), null);
  assert.ok(harness.document.querySelector('.messages'));
  assert.equal(harness.state.wsRunning, true);
  assert.equal(spinnerChecks.at(-1), true, 'the spinner is re-evaluated after the skeleton clears');
});

test.after(() => {
  harness.window.disconnectWs();
  harness.window.close();
});
