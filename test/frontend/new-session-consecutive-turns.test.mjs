import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness } from './harness.mjs';

test('new Codex session keeps three rapid equal prompts paired when bindings and acks reorder', async () => {
  const harness = await makeHarness();
  const sessionId = 'codex:new-session-three-turns';
  const firstStream = 'stream-first';
  const secondStream = 'stream-second';
  const thirdStream = 'stream-third';
  const now = Date.now();
  const sentAt = [now - 2000, now - 1000, now];
  harness.state.appState.runtime = 'codex';
  harness.state.appState.device = 'test-ec2-ap';
  harness.state.appState.session = '__new__';
  harness.state.wsSessionId = null;
  harness.state.wsAllMessages = [];
  harness.state.wsMessageUuids = new Set();
  harness.state.wsMessageCount = 0;
  harness.state.wsRenderedCount = 0;
  harness.state.pendingSentMessages = [{
    id: 'sent-first',
    text: '你是我吗',
    delivered: false,
    sentAt: sentAt[0],
    echoScanFrom: 0,
  }];
  harness.document.querySelector('.messages').innerHTML =
    '<div class="msg-user" id="sent-first" data-pending="1" data-anchor="sent-first">'
    + '你是我吗<div class="msg-meta"><span class="msg-time sending-status">sending...</span></div></div>';
  globalThis.api = harness.window.api = async function () {
    return { messages: [], hasMore: false };
  };

  harness.hooks.handleWsMessage({
    action: 'send_message_result',
    ok: true,
    sessionId,
    clientId: 'sent-first',
    streamId: firstStream,
  });
  await harness.tick(10);

  assert.equal(harness.state.wsSessionId, sessionId);
  assert.equal(harness.state.streamAnchors[firstStream], 'sent-first');

  harness.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    streamId: firstStream,
    clientId: 'sent-first',
    messages: [{
      uuid: 'first-user',
      nativeId: 'codex:user:first',
      type: 'user',
      content: '你是我吗',
      timestamp: '2026-08-15T11:02:47.410Z',
    }, {
      uuid: 'first-answer',
      nativeId: 'codex:item:first-answer',
      type: 'assistant',
      content: [{ type: 'text', text: '第一条回答' }],
      timestamp: '2026-08-15T11:02:48.763Z',
    }],
  });

  function appendPending(id, when) {
    harness.state.pendingSentMessages.push({
      id,
      text: '你是我吗',
      delivered: false,
      sentAt: when,
      echoScanFrom: harness.state.wsAllMessages.length,
    });
    harness.document.querySelector('.messages').insertAdjacentHTML(
      'beforeend',
      '<div class="msg-user" id="' + id + '" data-pending="1" data-anchor="' + id + '">'
      + '你是我吗<div class="msg-meta"><span class="msg-time sending-status">sending...</span></div></div>',
    );
  }

  appendPending('sent-second', sentAt[1]);
  appendPending('sent-third', sentAt[2]);

  // Q2 receives the explicit binding first, then rows without clientId.
  harness.hooks.handleWsMessage({
    action: 'send_message_binding',
    sessionId,
    clientId: 'sent-second',
    streamId: secondStream,
  });
  harness.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    streamId: secondStream,
    messages: [{
      uuid: 'second-user',
      nativeId: 'codex:user:second',
      type: 'user',
      content: '你是我吗',
      timestamp: '2026-08-15T11:02:51.710Z',
    }, {
      uuid: 'second-answer',
      nativeId: 'codex:item:second-answer',
      type: 'assistant',
      content: [{ type: 'text', text: '第二条回答' }],
      timestamp: '2026-08-15T11:02:53.116Z',
    }],
  });

  // Q3's rows overtake its binding/result. Each row carries clientId, so the
  // envelope itself must establish the exact anchor before rendering.
  harness.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    streamId: thirdStream,
    clientId: 'sent-third',
    messages: [{
      uuid: 'third-user',
      nativeId: 'codex:user:third',
      type: 'user',
      content: '你是我吗',
      timestamp: '2026-08-15T11:02:54.710Z',
    }, {
      uuid: 'third-answer',
      nativeId: 'codex:item:third-answer',
      type: 'assistant',
      content: [{ type: 'text', text: '第三条回答' }],
      timestamp: '2026-08-15T11:02:56.116Z',
    }],
  });

  // Final acknowledgements may return in a different order than sends.
  harness.hooks.handleWsMessage({
    action: 'send_message_result',
    ok: true,
    sessionId,
    clientId: 'sent-third',
    streamId: thirdStream,
  });
  harness.hooks.handleWsMessage({
    action: 'send_message_result',
    ok: true,
    sessionId,
    clientId: 'sent-second',
    streamId: secondStream,
  });
  await harness.tick(20);

  const rows = Array.from(harness.document.querySelector('.messages').children);
  assert.deepEqual(rows.map((row) => row.className), [
    'msg-user',
    'assistant-turn',
    'msg-user',
    'assistant-turn',
    'msg-user',
    'assistant-turn',
  ]);
  assert.match(rows[1].textContent, /第一条回答/);
  assert.match(rows[3].textContent, /第二条回答/);
  assert.match(rows[5].textContent, /第三条回答/);

  const displayedTimes = ['sent-first', 'sent-second', 'sent-third'].map((id) =>
    harness.document.getElementById(id).querySelector('.sending-status').textContent
  );
  assert.deepEqual(displayedTimes, sentAt.map((time) => new Date(time).toLocaleTimeString()));
});
