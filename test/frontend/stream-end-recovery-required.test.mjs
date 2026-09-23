import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();

test('compact stream_end stops ordered and gapped turns with REST recovery', async () => {
  var sessionId = 'codex:compact-end';
  var turnId = 'turn-compact-end';
  let requests = 0;
  resetSession(h, { sessionId });
  h.setApiHandler(async () => {
    requests++;
    return {
      messages: [],
      hasMore: false,
      status: 'completed',
    };
  });

  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId,
    turnId,
    seq: 0,
  });
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId,
    turnId,
    seq: 1,
    messages: [],
    truncated: true,
  });
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId,
    turnId,
    seq: 2,
    recoveryRequired: true,
  });

  assert.equal(h.state.wsRunning, false);
  await h.tick(250);
  assert.equal(requests, 1);
  assert.equal(h.state.wsRunning, false);

  turnId = 'turn-gapped-compact-end';
  requests = 0;
  resetSession(h, { sessionId });
  h.setApiHandler(async () => {
    requests++;
    return {
      messages: [],
      hasMore: false,
      status: 'completed',
    };
  });

  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId,
    turnId,
    seq: 0,
  });
  h.hooks.handleWsMessage({
    action: 'stream_block_start',
    sessionId,
    turnId,
    seq: 1,
    kind: 'text',
  });
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId,
    turnId,
    seq: 3,
    recoveryRequired: true,
  });

  assert.equal(h.state.wsRunning, true);
  await h.tick(20);
  assert.equal(h.state.wsRunning, true);
  await h.tick(60);
  assert.equal(h.state.wsRunning, false);
  await h.tick(180);
  assert.equal(requests, 1);
  assert.equal(h.state.wsRunning, false);

  turnId = 'turn-reordered-compact-end';
  requests = 0;
  resetSession(h, { sessionId });
  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId,
    turnId,
    seq: 0,
  });
  h.hooks.handleWsMessage({
    action: 'stream_block_start',
    sessionId,
    turnId,
    seq: 1,
    kind: 'text',
  });
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId,
    turnId,
    seq: 3,
    recoveryRequired: true,
  });
  assert.equal(h.state.wsRunning, true);
  h.hooks.handleWsMessage({
    action: 'stream_block_stop',
    sessionId,
    turnId,
    seq: 2,
  });
  assert.equal(h.state.wsRunning, false);
  await h.tick(200);
  assert.equal(requests, 1);
});

for (const runtime of ['claude', 'codex']) {
  for (const streaming of [false, true]) {
    test(`${runtime} interrupted-turn recovery preserves the next ${streaming ? 'streaming' : 'pending'} question`, async () => {
      h.window.disconnectWs();
      const sessionId = `${runtime}:interrupt-next-question`;
      const turnId = 'interrupted-turn';
      resetSession(h, { sessionId });
      h.state.rootSessionId = sessionId;
      h.state.appState.runtime = runtime;
      h.state.wsHasMore = true;
      h.state.wsOldestTimestamp = 'older-page-cursor';
      const sent = [];
      h.state.ws = {
        readyState: WebSocket.OPEN,
        send(payload) { sent.push(JSON.parse(payload)); },
        close() {},
      };
      let resolveRest;
      let requests = 0;
      h.setApiHandler(() => {
        requests++;
        return new Promise(resolve => { resolveRest = resolve; });
      });
      const user = { uuid: 'first-user', turnId, type: 'user', content: 'first question' };
      const interrupt = {
        uuid: `live_interrupt_${turnId}`,
        nativeId: `live:interrupt:${turnId}`,
        turnId,
        type: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
      };
      h.hooks.handleWsMessage({ action: 'stream_turn_start', sessionId, turnId, seq: 0 });
      h.hooks.handleWsMessage({ action: 'messages', sessionId, turnId, seq: 1, messages: [user] });
      h.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert.ok(sent.some(payload => payload.action === 'interrupt' && payload.turnId === turnId));
      h.hooks.handleWsMessage({ action: 'messages', sessionId, turnId, seq: 2, messages: [interrupt] });
      h.hooks.handleWsMessage({ action: 'stream_end', sessionId, turnId, seq: 3, recoveryRequired: true });
      assert.equal(h.document.querySelectorAll('.msg-interrupt').length, 1);

      h.window.doSend('second question', 'second question', []);
      const pending = h.state.pendingSentMessages[0];
      const container = h.document.querySelector('.messages');
      const bubble = h.document.getElementById(pending.id);
      const nextUser = {
        uuid: 'second-user',
        nativeId: `${runtime === 'codex' ? 'codex' : 'live'}:user:${pending.id}`,
        type: 'user',
        content: 'second question',
      };
      h.hooks.handleWsMessage({ action: 'send_message_result', sessionId, turnId: pending.id, ok: true });
      const startEvents = [
        { action: 'stream_turn_start', seq: 0 },
        { action: 'messages', seq: 1, messages: [nextUser] },
        { action: 'stream_block_start', seq: 2, kind: 'text' },
        { action: 'stream_delta', seq: 3, chunk: 'second answer' },
      ];
      if (streaming) {
        for (const event of startEvents) {
          h.hooks.handleWsMessage({ sessionId, turnId: pending.id, ...event });
        }
      }
      const overlappingRefresh = streaming ? h.window.loadLatestMessages(sessionId) : null;
      await h.tick(200);
      assert.equal(requests, 1);
      const loading = overlappingRefresh || h.window.loadLatestMessages(sessionId);
      const preview = container.querySelector(`[data-turn-id="${pending.id}"]`);
      if (streaming) assert.equal(preview?.textContent, 'second answer');
      resolveRest({
        messages: [user, {
          uuid: 'recovered-first-answer', turnId, type: 'assistant', content: 'recovered first answer',
        }, interrupt],
        hasMore: false,
        status: 'completed',
      });
      await loading;

      assert.equal(bubble.isConnected, true, 'the next question must never disappear during old-turn recovery');
      assert.equal(h.document.querySelector('.messages'), container);
      assert.equal(h.document.querySelector(`[data-anchor="${pending.id}"]`), bubble);
      assert.equal(h.state.pendingSentMessages.includes(pending), !streaming);
      assert.equal(h.state.wsRunning, true, 'an older completed snapshot must not stop the next turn');
      assert.equal(h.state.wsHasMore, true);
      assert.equal(h.state.wsOldestTimestamp, 'older-page-cursor');
      assert.match(container.textContent, /recovered first answer/);
      assert.equal(container.querySelectorAll('.msg-interrupt').length, 1);
      if (streaming) {
        assert.equal(preview.isConnected, true);
        assert.equal(bubble.nextElementSibling, preview);
        assert.equal(preview.textContent, 'second answer');
      } else {
        for (const event of startEvents) {
          h.hooks.handleWsMessage({ sessionId, turnId: pending.id, ...event });
        }
      }
      const answer = { uuid: 'second-answer', type: 'assistant', content: 'second answer continued' };
      for (const event of [
        { action: 'stream_delta', seq: 4, chunk: ' continued' },
        { action: 'stream_block_stop', seq: 5 },
        { action: 'messages', seq: 6, messages: [answer] },
        { action: 'stream_end', seq: 7, messages: [nextUser, answer] },
      ]) {
        h.hooks.handleWsMessage({ sessionId, turnId: pending.id, ...event });
      }
      await h.tick(80);
      assert.equal(h.document.querySelector(`[data-anchor="${pending.id}"]`), bubble);
      assert.equal(bubble.nextElementSibling.textContent, 'second answer continued');
      assert.equal(container.querySelectorAll('.msg-user').length, 2);
      assert.equal(h.state.pendingSentMessages.length, 0);
      assert.equal(h.state.wsRunning, false);
    });
  }
}

test.after(() => { h.window.disconnectWs(); h.window.close(); });
