import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('initial history requests 200 messages while forward recovery remains unlimited', async () => {
  const sessionId = 'history-default-page-size';
  resetSession(h, { sessionId });
  const calls = [];
  h.setApiHandler(async (endpoint, params) => {
    calls.push({ endpoint, params });
    return { messages: [], hasMore: false };
  });

  await h.window.bufferAndFetch(sessionId, '');
  await h.window.bufferAndFetch(sessionId, '2026-09-20T00:00:00.000Z');

  assert.deepEqual(calls, [{
    endpoint: '/api/bridge/messages',
    params: { session: sessionId, limit: 200, device: 'D', project: '-h' },
  }, {
    endpoint: '/api/bridge/messages',
    params: { session: sessionId, after: '2026-09-20T00:00:00.000Z', device: 'D', project: '-h' },
  }]);
});

test('REST failure still commits complete watcher history and releases the barrier', async () => {
  const sessionId = 'history-rest-failure';
  resetSession(h, { sessionId });
  const request = deferred();
  h.setApiHandler(() => request.promise);

  const loading = h.window.bufferAndFetch(sessionId, '');
  await h.tick(0);
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    messages: [{
      uuid: 'buffered',
      type: 'assistant',
      content: [{ type: 'text', text: 'survives failure' }],
      timestamp: '2026-08-27T00:00:00.000Z',
    }],
  });
  request.reject(new Error('offline'));

  const result = await loading;
  assert.equal(result.ok, false);
  assert.deepEqual(
    h.state.wsAllMessages.map((message) => message.uuid),
    ['buffered'],
  );

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    messages: [{
      uuid: 'after',
      type: 'assistant',
      content: [{ type: 'text', text: 'after barrier' }],
      timestamp: '2026-08-27T00:00:01.000Z',
    }],
  });
  assert.deepEqual(
    h.state.wsAllMessages.map((message) => message.uuid),
    ['buffered', 'after'],
  );
});

test('identical overlapping history requests share one active barrier', async () => {
  const sessionId = 'history-overlap';
  resetSession(h, { sessionId });
  const request = deferred();
  let calls = 0;
  h.setApiHandler(() => {
    calls++;
    return request.promise;
  });

  const first = h.window.bufferAndFetch(sessionId, '');
  const second = h.window.bufferAndFetch(sessionId, '');
  await h.tick(0);
  assert.equal(calls, 1);

  request.resolve({
    messages: [{
      uuid: 'one',
      type: 'user',
      content: 'one',
      timestamp: '2026-08-27T00:00:00.000Z',
    }],
    hasMore: false,
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.added, 1);
  assert.equal(secondResult.added, 1);
  assert.deepEqual(h.state.wsAllMessages.map((message) => message.uuid), ['one']);
});

test('history recovery restores physical bottom only when follow intent remains active', async () => {
  const sessionId = 'history-bottom-follow';
  resetSession(h, { sessionId });
  const content = h.document.getElementById('content');
  Object.defineProperties(content, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  content.scrollTop = 100;
  h.state.stickBottom = true;
  h.setApiResponse({
    messages: [{
      uuid: 'one',
      type: 'user',
      content: 'one',
      timestamp: '2026-08-27T00:00:00.000Z',
    }],
    hasMore: false,
  });

  await h.window.bufferAndFetch(sessionId, '');
  assert.equal(content.scrollTop, 100);
  await h.tick(10);
  assert.equal(content.scrollTop, 1000);

  content.scrollTop = 100;
  h.state.stickBottom = false;
  h.setApiResponse({
    messages: [{
      uuid: 'one',
      type: 'user',
      content: 'one',
      timestamp: '2026-08-27T00:00:00.000Z',
    }, {
      uuid: 'two',
      type: 'assistant',
      content: [{ type: 'text', text: 'two' }],
      timestamp: '2026-08-27T00:00:01.000Z',
    }],
    hasMore: false,
  });

  await h.window.bufferAndFetch(sessionId, '');
  await h.tick(10);
  assert.equal(content.scrollTop, 100);
});
