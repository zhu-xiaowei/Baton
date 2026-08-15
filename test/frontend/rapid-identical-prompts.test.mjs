import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness } from './harness.mjs';

test('four equal prompts keep click order when native user echoes beat bindings', async () => {
  const harness = await makeHarness();
  const sessionId = 'codex:rapid-native-echoes';
  const base = new Date('2026-08-15T11:42:31.000Z').getTime();
  const sends = Array.from({ length: 4 }, (_, index) => ({
    clientId: `sent-${base + index * 1000}-${index}`,
    streamId: `stream-${index + 1}`,
    sentAt: base + index * 1000,
    answer: `回答${index + 1}`,
  }));

  harness.state.appState.runtime = 'codex';
  harness.state.appState.device = 'test-ec2-ap';
  harness.state.appState.session = sessionId;
  harness.state.wsSessionId = sessionId;
  harness.state.wsAllMessages = [];
  harness.state.wsMessageUuids = new Set();
  harness.state.wsMessageCount = 0;
  harness.state.wsRenderedCount = 0;
  harness.state.pendingSentMessages = sends.map((send, index) => ({
    id: send.clientId,
    seq: index,
    text: '你是我吗',
    delivered: false,
    sentAt: send.sentAt,
    echoScanFrom: 0,
  }));
  harness.document.querySelector('.messages').innerHTML = sends.map((send) =>
    `<div class="msg-user" id="${send.clientId}" data-pending="1" data-anchor="${send.clientId}">`
    + '你是我吗<div class="msg-meta"><span class="msg-time sending-status">sending...</span></div></div>'
  ).join('');

  // Canonical Codex user rows can arrive through the watcher before the
  // send_message_binding relay. Their native id already contains the exact
  // clientUserMessageId (our streamId), so they must wait rather than
  // text-match another identical optimistic bubble.
  for (const send of sends.slice().reverse()) {
    harness.hooks.handleWsMessage({
      action: 'messages',
      sessionId,
      messages: [{
        uuid: `user-${send.streamId}`,
        nativeId: `codex:user:${send.streamId}`,
        type: 'user',
        content: '你是我吗',
        timestamp: new Date(send.sentAt + 900).toISOString(),
      }],
    });
  }

  for (const send of [sends[3], sends[1], sends[2], sends[0]]) {
    harness.hooks.handleWsMessage({
      action: 'send_message_binding',
      sessionId,
      clientId: send.clientId,
      streamId: send.streamId,
    });
  }
  await harness.tick(20);

  // Replies can also arrive in any order; stream identity alone decides which
  // question owns each assistant turn.
  for (const send of sends.slice().reverse()) {
    harness.hooks.handleWsMessage({
      action: 'messages',
      sessionId,
      streamId: send.streamId,
      clientId: send.clientId,
      messages: [{
        uuid: `answer-${send.streamId}`,
        nativeId: `codex:item:${send.streamId}`,
        type: 'assistant',
        content: [{ type: 'text', text: send.answer }],
        timestamp: new Date(send.sentAt + 1500).toISOString(),
      }],
    });
  }
  await harness.tick(20);

  const rows = Array.from(harness.document.querySelector('.messages').children);
  assert.deepEqual(rows.map((row) => row.className), [
    'msg-user', 'assistant-turn',
    'msg-user', 'assistant-turn',
    'msg-user', 'assistant-turn',
    'msg-user', 'assistant-turn',
  ]);
  for (let index = 0; index < sends.length; index++) {
    const user = rows[index * 2];
    const answer = rows[index * 2 + 1];
    assert.equal(user.dataset.anchor, sends[index].clientId);
    assert.equal(user.dataset.ts, new Date(sends[index].sentAt).toISOString());
    assert.match(answer.textContent, new RegExp(sends[index].answer));
    assert.equal(
      user.querySelector('.sending-status').textContent,
      new Date(sends[index].sentAt).toLocaleTimeString(),
    );
  }
});
