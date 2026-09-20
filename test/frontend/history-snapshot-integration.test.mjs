import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();
globalThis.showWsBanner = h.window.showWsBanner = () => {};
const sessionId = 'codex:snapshot';
const message = (index, content = 'message ' + index) => ({
  uuid: String(index), type: 'assistant', content,
});
const page = (start, count = 200) => Array.from({ length: count }, (_, index) => message(start + index));
const respond = data => h.setApiHandler(async () => data);

function setup() {
  h.window.disconnectWs();
  resetSession(h, { sessionId });
  h.state.rootSessionId = sessionId;
  h.state.appState.runtime = 'codex';
  h.state.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
  h.state.stickBottom = false;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('refresh preserves paginated history and its oldest cursor while replacing the tail', async () => {
  setup();
  respond({ messages: page(1, 300), hasMore: true, oldestTimestamp: 'old-cursor' });
  await h.window.loadLatestMessages(sessionId);
  respond({ messages: [message(201, 'updated boundary'), ...page(202, 199)], hasMore: true, oldestTimestamp: 'new-cursor' });
  await h.window.loadLatestMessages(sessionId);
  assert.equal(h.state.wsAllMessages.length, 400);
  assert.equal(h.state.wsAllMessages[200].content, 'updated boundary');
  assert.equal(h.state.wsOldestTimestamp, 'old-cursor');
  assert.equal(h.state.wsHasMore, true);
  assert.equal(h.document.querySelectorAll('[data-message-id="201"]').length, 1);
});

test('a missing boundary replaces the full window and resets pagination', async () => {
  setup();
  respond({ messages: page(1, 300), hasMore: false, oldestTimestamp: 'old' });
  await h.window.loadLatestMessages(sessionId);
  respond({ messages: page(500), hasMore: true, oldestTimestamp: '500-cursor' });
  await h.window.loadLatestMessages(sessionId);
  assert.equal(h.state.wsAllMessages.length, 200);
  assert.equal(h.state.wsAllMessages[0].uuid, '500');
  assert.equal(h.state.wsOldestTimestamp, '500-cursor');
  assert.equal(h.document.querySelector('[data-message-id="1"]'), null);
});

test('an unchanged snapshot keeps DOM identity, manual expansion and scroll position', async () => {
  setup();
  respond({ messages: page(1, 3), status: 'completed' });
  await h.window.loadLatestMessages(sessionId);
  const content = h.document.getElementById('content');
  const container = content.querySelector('.messages');
  const row = container.firstElementChild;
  row.classList.add('expanded');
  content.scrollTop = 123;
  const result = await h.window.loadLatestMessages(sessionId);
  assert.equal(result.ok, true);
  assert.equal(content.querySelector('.messages'), container);
  assert.equal(row.classList.contains('expanded'), true);
  assert.equal(content.scrollTop, 123);
});

test('a failed refresh keeps the old view and pending send intact', async () => {
  setup();
  respond({ messages: page(1, 2) });
  await h.window.loadLatestMessages(sessionId);
  h.window.doSend('pending', 'pending', []);
  const pending = h.state.pendingSentMessages[0];
  const container = h.document.querySelector('.messages');
  h.setApiHandler(async () => { throw new Error('offline'); });
  const result = await h.window.loadLatestMessages(sessionId);
  assert.equal(result.ok, false);
  assert.equal(h.document.querySelector('.messages'), container);
  assert.equal(h.state.pendingSentMessages[0], pending);
  assert.equal(h.document.getElementById(pending.id)?.isConnected, true);
  clearTimeout(pending.transportTimer);
});

test('a successful refresh discards old optimistic bubbles absent from REST', async () => {
  setup();
  h.window.doSend('old pending', 'old pending', []);
  const pending = h.state.pendingSentMessages[0];
  const request = deferred();
  h.setApiHandler(() => request.promise);
  const loading = h.window.loadLatestMessages(sessionId);
  assert.ok(h.document.getElementById(pending.id));
  request.resolve({ messages: page(1, 2), status: 'completed' });
  await loading;
  assert.equal(h.document.getElementById(pending.id), null);
  assert.equal(h.state.pendingSentMessages.length, 0);
  assert.equal(h.state.wsRunning, false);
});

test('stale responses cannot overwrite a reentered session with the same ID', async () => {
  setup();
  const request = deferred();
  h.setApiHandler(() => request.promise);
  const stale = h.window.loadLatestMessages(sessionId);
  setup();
  respond({ messages: page(500, 2) });
  await h.window.loadLatestMessages(sessionId);
  request.resolve({ messages: page(1, 2) });
  assert.equal((await stale).stale, true);
  assert.equal(h.state.wsAllMessages[0].uuid, '500');
});

test('five sends during REST loading stay ordered despite reversed WS completion', async () => {
  setup();
  const request = deferred();
  h.setApiHandler(() => request.promise);
  const loading = h.window.loadLatestMessages(sessionId);
  for (let index = 1; index <= 5; index++) h.window.doSend(String(index), String(index), []);
  const pending = h.state.pendingSentMessages.slice();
  for (let index = 4; index >= 0; index--) {
    const turnId = pending[index].id;
    const user = { uuid: 'user-' + index, nativeId: 'codex:user:' + turnId, type: 'user', content: String(index + 1) };
    const assistant = message('answer-' + index, 'answer ' + (index + 1));
    const events = [
      { action: 'stream_turn_start', seq: 0 },
      { action: 'messages', seq: 1, messages: [user] },
      { action: 'stream_block_start', seq: 2, kind: 'text' },
      { action: 'stream_delta', seq: 3, chunk: assistant.content },
      { action: 'stream_block_stop', seq: 4 },
      { action: 'messages', seq: 5, messages: [assistant] },
      { action: 'stream_end', seq: 6, messages: [user, assistant] },
    ];
    for (const order of [0, 2, 3, 4, 5, 6, 1]) {
      h.hooks.handleWsMessage({ sessionId, turnId, ...events[order] });
    }
  }
  assert.equal(h.document.body.textContent.includes('answer 1'), false);
  request.resolve({ messages: page(100, 1), status: 'completed' });
  await loading;
  await h.tick(200);
  const users = Array.from(h.document.querySelectorAll('.msg-user'));
  assert.deepEqual(users.map(node => node.dataset.anchor), pending.map(item => item.id));
  for (let index = 0; index < users.length; index++) {
    assert.equal(users[index].nextElementSibling.dataset.turnId, pending[index].id);
    assert.equal(users[index].nextElementSibling.textContent, 'answer ' + (index + 1));
  }
  assert.equal(h.state.pendingSentMessages.length, 0);
  assert.equal(h.state.wsRunning, false);
});

test('a REST echo for a later in-flight send is not duplicated or moved ahead of earlier sends', async () => {
  setup();
  const request = deferred();
  h.setApiHandler(() => request.promise);
  const loading = h.window.loadLatestMessages(sessionId);
  for (let index = 1; index <= 5; index++) h.window.doSend(String(index), String(index), []);
  const pending = h.state.pendingSentMessages.slice();
  request.resolve({ messages: [{
    uuid: 'echo-five', nativeId: 'codex:user:' + pending[4].id,
    type: 'user', content: '5',
  }, { ...message('answer-five', 'answer 5'), turnId: pending[4].id }], status: 'completed' });
  await loading;
  const users = Array.from(h.document.querySelectorAll('.msg-user'));
  assert.deepEqual(users.map(node => node.dataset.anchor), pending.map(item => item.id));
  assert.equal(users.at(-1).nextElementSibling.textContent, 'answer 5');
  assert.equal(h.document.querySelectorAll('[data-message-id="echo-five"]').length, 1);
  assert.equal(h.state.pendingSentMessages.length, 4);
  assert.equal(h.state.wsRunning, true);
  for (const item of pending) clearTimeout(item.transportTimer);
});

test('initial skeleton hands off to buffered WS messages when REST fails or needs sync', async () => {
  for (const fail of [true, false]) {
    setup();
    h.document.querySelector('.messages').classList.add('skeleton-messages');
    const request = deferred();
    h.setApiHandler(() => request.promise);
    const loading = h.window.loadLatestMessages(sessionId);
    h.hooks.handleWsMessage({ action: 'messages', sessionId, messages: [message('buffered', 'visible WS result')] });
    if (fail) request.reject(new Error('offline'));
    else request.resolve({ messages: [], needSync: true });
    await loading;
    assert.equal(h.document.querySelector('.skeleton-messages'), null);
    assert.match(h.document.querySelector('.messages').textContent, /visible WS result/);
  }
});

test.after(() => { h.window.disconnectWs(); h.window.close(); });
