import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();

test('older history merge updates state without rebuilding the visible page', async () => {
  resetSession(h, { sessionId: 'pagination-session', mode: 'existing' });

  const current = {
    uuid: 'current-message',
    type: 'user',
    content: 'current',
    timestamp: '2026-09-01T01:00:00.000Z',
  };
  const older = {
    uuid: 'older-message',
    type: 'user',
    content: 'older',
    timestamp: '2026-09-01T00:00:00.000Z',
  };
  const container = h.document.querySelector('.messages');
  container.innerHTML = '<div class="loading-older">Loading...</div>'
    + '<div class="msg-user" data-message-id="current-message">current</div>';
  const loader = container.firstElementChild;
  const currentNode = container.lastElementChild;

  h.state.wsAllMessages = [current];
  h.state.wsMessageUuids = new Set([current.uuid]);
  h.state.wsMessageCount = 1;
  h.state.wsRenderedCount = 1;
  h.state.wsHasMore = true;
  h.state.wsOldestTimestamp = current.timestamp;
  h.state.wsRunning = false;
  const pendingMessages = [{ id: 'pending-turn', text: 'pending' }];
  h.state.pendingSentMessages = pendingMessages;
  let apiCall = null;
  h.setApiHandler(async (endpoint, params) => {
    apiCall = { endpoint, params };
    return {
      messages: [older],
      hasMore: false,
      oldestTimestamp: older.timestamp,
    };
  });

  const loaded = await h.window.loadOlderMessages('pagination-session');

  assert.deepEqual(loaded.map((message) => message.uuid), [older.uuid]);
  assert.deepEqual(
    h.state.wsAllMessages.map((message) => message.uuid),
    [older.uuid, current.uuid],
  );
  assert.equal(container.firstElementChild, loader);
  assert.equal(container.lastElementChild, currentNode);
  assert.equal(container.children.length, 2);
  assert.equal(h.state.wsHasMore, false);
  assert.equal(h.state.wsRunning, false);
  assert.equal(h.state.pendingSentMessages, pendingMessages);
  assert.deepEqual(apiCall, {
    endpoint: '/api/bridge/messages',
    params: {
      session: 'pagination-session',
      before: current.timestamp,
      device: 'D',
    },
  });
});

test('an older page cannot commit after switching sessions', async () => {
  resetSession(h, { sessionId: 'pagination-session-a', mode: 'existing' });
  h.state.wsAllMessages = [{
    uuid: 'session-a-current',
    type: 'user',
    content: 'session A',
    timestamp: '2026-09-01T01:00:00.000Z',
  }];
  h.state.wsHasMore = true;
  h.state.wsOldestTimestamp = '2026-09-01T01:00:00.000Z';
  let resolvePage;
  h.setApiHandler(() => new Promise((resolve) => {
    resolvePage = resolve;
  }));

  const loading = h.window.loadOlderMessages('pagination-session-a');
  await h.tick(0);
  resetSession(h, { sessionId: 'pagination-session-b', mode: 'existing' });
  h.state.wsAllMessages = [{
    uuid: 'session-b-current',
    type: 'user',
    content: 'session B',
    timestamp: '2026-09-01T02:00:00.000Z',
  }];
  resolvePage({
    messages: [{
      uuid: 'session-a-older',
      type: 'user',
      content: 'older session A',
      timestamp: '2026-09-01T00:00:00.000Z',
    }],
    hasMore: false,
    oldestTimestamp: '2026-09-01T00:00:00.000Z',
  });

  assert.equal(await loading, null);
  assert.deepEqual(
    h.state.wsAllMessages.map((message) => message.uuid),
    ['session-b-current'],
  );
});
