import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const harness = await makeHarness();

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const runtime of ['claude', 'codex']) {
  for (const hasEcho of [false, true]) {
    test(`${runtime} new-session history ${hasEcho ? 'echo' : 'empty response'} preserves the first send and live reply`, async () => {
      harness.window.disconnectWs();
      resetSession(harness, { sessionId: '', mode: 'new' });
      harness.state.appState.runtime = runtime;
      harness.state.wsProjectHash = '-h';
      harness.state.wsRequestId = 'new-session-request';
      harness.state.ws = { readyState: WebSocket.OPEN, send() {}, close() {} };
      const sessionId = runtime === 'codex' ? 'codex:new-thread' : 'new-claude-session';
      const request = deferred();
      let requests = 0;
      harness.setApiHandler(() => {
        requests++;
        return request.promise;
      });

      harness.window.doSend('first question', 'first question', []);
      const pending = harness.state.pendingSentMessages[0];
      const container = harness.document.querySelector('.messages');
      const bubble = harness.document.getElementById(pending.id);
      const user = {
        uuid: 'user-1',
        nativeId: `${runtime === 'codex' ? 'codex' : 'live'}:user:${pending.id}`,
        type: 'user',
        content: 'first question',
        timestamp: new Date(pending.sentAt).toISOString(),
      };
      const assistant = {
        uuid: 'assistant-1',
        type: 'assistant',
        content: [{ type: 'text', text: 'first answer' }],
      };
      harness.hooks.handleWsMessage({
        action: 'send_message_result', sessionId, ok: true,
        requestId: harness.state.wsRequestId, turnId: pending.id,
      });
      const loading = harness.window.loadLatestMessages(sessionId);
      harness.hooks.handleWsMessage({
        action: 'sync_complete', sessionId, status: 'ok', count: hasEcho ? 1 : 0,
      });
      request.resolve({
        messages: hasEcho ? [user] : [],
        hasMore: false,
        needSync: !hasEcho,
        status: 'completed',
      });
      await loading;

      assert.equal(requests, 1);
      assert.equal(harness.document.querySelector('.messages'), container,
        'adopting a session must not replace the live message container');
      assert.equal(harness.document.querySelector(`[data-anchor="${pending.id}"]`), bubble,
        'the first optimistic bubble must stay in place even before REST sees its echo');
      assert.equal(harness.state.pendingSentMessages.length, hasEcho ? 0 : 1);
      assert.equal(harness.state.wsRunning, true,
        'a newly created session snapshot cannot finish the locally started turn');

      for (const event of [
        { action: 'stream_turn_start', seq: 0 },
        { action: 'messages', seq: 1, messages: [user] },
        { action: 'stream_block_start', seq: 2, kind: 'text' },
        { action: 'stream_delta', seq: 3, chunk: 'first answer' },
      ]) {
        harness.hooks.handleWsMessage({ sessionId, turnId: pending.id, ...event });
      }
      await harness.tick(80);
      const preview = container.querySelector('.stream-preview');
      assert.ok(preview);
      assert.equal(bubble.nextElementSibling, preview);
      assert.equal(preview.textContent, 'first answer');
      assert.equal(harness.state.wsRunning, true);

      for (const event of [
        { action: 'stream_block_stop', seq: 4 },
        { action: 'messages', seq: 5, messages: [assistant] },
        { action: 'stream_end', seq: 6, messages: [user, assistant] },
      ]) {
        harness.hooks.handleWsMessage({ sessionId, turnId: pending.id, ...event });
      }
      await harness.tick(80);
      assert.equal(harness.document.querySelector('.messages'), container);
      assert.equal(harness.document.querySelector(`[data-anchor="${pending.id}"]`), bubble);
      assert.equal(bubble.nextElementSibling, preview);
      assert.equal(container.querySelectorAll('.msg-user').length, 1);
      assert.equal(container.querySelectorAll('.assistant-turn').length, 1);
      assert.equal(preview.textContent, 'first answer');
      assert.equal(harness.state.pendingSentMessages.length, 0);
      assert.equal(harness.state.wsRunning, false);
      assert.equal(requests, 1);
    });
  }
}

test.after(() => {
  harness.window.disconnectWs();
  harness.window.close();
});
