import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness } from './harness.mjs';

test('new Codex session merges buffered live and persisted user echoes by stream identity', async () => {
  const harness = await makeHarness();
  const sessionId = 'codex:new-session';
  const streamId = 'new-session-stream';
  const timestamp = '2026-08-12T15:04:16.489Z';
  harness.state.appState.runtime = 'codex';
  harness.state.appState.device = 'MacBook-Pro';
  harness.state.appState.session = '__new__';
  harness.state.wsSessionId = sessionId;
  harness.state.wsAllMessages = [];
  harness.state.wsMessageUuids = new Set();
  harness.state.wsMessageCount = 0;
  harness.state.wsRenderedCount = 0;
  harness.state.pendingSentMessages = [{
    id: 'sent-new',
    text: 'hello',
    delivered: true,
  }];
  harness.state.streamAnchors = { [streamId]: 'sent-new' };
  harness.document.querySelector('.messages').innerHTML =
    '<div class="msg-user" id="sent-new" data-pending="1" data-anchor="sent-new">hello</div>';

  var resolveFetch;
  const fetchPromise = new Promise(function (resolve) { resolveFetch = resolve; });
  globalThis.api = harness.window.api = function () { return fetchPromise; };
  const loading = harness.window.bufferAndFetch(sessionId, '');
  await harness.tick(0);

  harness.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    streamId,
    messages: [{
      uuid: 'live-user',
      nativeId: `codex:user:${streamId}`,
      type: 'user',
      content: 'hello',
      timestamp,
    }],
  });
  resolveFetch({
    messages: [{
      uuid: 'persisted-user',
      nativeId: `codex:user:${streamId}`,
      type: 'user',
      content: 'hello',
      timestamp,
    }],
    hasMore: false,
  });
  await loading;
  harness.hooks.updateLastTurn();

  assert.equal(harness.state.wsAllMessages.length, 1);
  assert.equal(harness.state.wsAllMessages[0]._streamId, streamId);
  assert.equal(harness.document.querySelectorAll('.msg-user').length, 1);
  assert.equal(
    harness.document.getElementById('sent-new').hasAttribute('data-pending'),
    false,
  );
});
