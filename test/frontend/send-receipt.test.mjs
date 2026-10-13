import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('send reliability keeps receipt, retry, and failure states distinct', async () => {
  const h = await makeHarness();
  const failPendingTurns = async () => {
    for (const pending of [...h.state.pendingSentMessages]) {
      h.hooks.handleWsMessage({
        action: 'send_message_result',
        turnId: pending.id,
        ok: false,
        error: 'test cleanup',
      });
    }
    await h.tick(0);
  };

  resetSession(h, { sessionId: 'codex:receipt' });
  const receivedSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { receivedSent.push(JSON.parse(payload)); },
  };

  h.window.doSend('received', 'received', []);
  const receivedPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_received',
    turnId: receivedPending.id,
  });
  await h.tick(30);

  // A Server receipt is not a Bridge result: the same turn is resent.
  assert.equal(receivedSent.length, 2);
  assert.deepEqual(receivedSent[1], receivedSent[0]);
  assert.equal(receivedPending.delivered, undefined);
  assert.equal(
    h.document.querySelector('.sending-status').textContent,
    'sending...',
  );
  await failPendingTurns();

  resetSession(h, { sessionId: 'codex:retry' });
  const retriedSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { retriedSent.push(JSON.parse(payload)); },
  };

  h.window.doSend('retry', 'retry', []);
  await h.tick(30);

  assert.equal(retriedSent.length, 2);
  assert.equal(retriedSent[1].turnId, retriedSent[0].turnId);
  assert.deepEqual(retriedSent[1], retriedSent[0]);
  await failPendingTurns();

  resetSession(h, { sessionId: '__new__', mode: 'new' });
  h.state.wsProjectHash = '-project';
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  h.window.doSend('hello', 'hello', []);
  const failedPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    turnId: failedPending.id,
    ok: false,
    error: 'Previous message did not reach the Bridge. Retry.',
    errorCode: 'previous_turn_missing',
  });
  await h.tick(0);

  assert.equal(failedPending.failed, true);
  assert.equal(h.state.wsRunning, false);
  assert.equal(
    h.document.querySelector('.sending-status').textContent,
    'Previous message did not reach the Bridge. · Retry',
  );
  assert.equal(h.document.querySelectorAll('.sending-status .send-retry').length, 1);

  resetSession(h, { sessionId: 'codex:retry-order' });
  const orderedSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { orderedSent.push(JSON.parse(payload)); },
  };
  h.window.doSend('still running', 'still running', []);
  const firstPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_received',
    turnId: firstPending.id,
  });
  h.window.doSend('retry me', 'retry me', []);
  const retryPending = h.state.pendingSentMessages[1];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    turnId: retryPending.id,
    ok: false,
    error: 'Previous message did not reach the Bridge. Retry.',
    errorCode: 'previous_turn_missing',
  });
  await h.tick(0);
  await h.window.retryPendingSend(retryPending.id);

  assert.equal(orderedSent.length, 3);
  assert.equal(orderedSent[2].previousTurnId, firstPending.id);
  assert.equal(orderedSent[2].turnId, retryPending.id);
  assert.equal(
    h.document.querySelector('.messages').lastElementChild.id,
    retryPending.id,
  );
  await failPendingTurns();

  h.window.subscribeSession('codex:external-running');
  resetSession(h, { sessionId: 'codex:external-running' });
  const externalSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { externalSent.push(JSON.parse(payload)); },
  };
  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId: h.state.wsSessionId,
    turnId: 'external-runtime-turn',
    seq: 0,
  });
  h.window.doSend('follow up on terminal task', 'follow up on terminal task', []);
  const acceptedFollowup = h.state.pendingSentMessages[0];
  assert.equal(externalSent[0].previousTurnId, '');
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: h.state.wsSessionId,
    turnId: acceptedFollowup.id,
    ok: true,
  });
  h.window.doSend('already accepted predecessor', 'already accepted predecessor', []);
  assert.equal(externalSent[1].previousTurnId, '');
  await failPendingTurns();

  h.window.subscribeSession('codex:queued-predecessor');
  resetSession(h, { sessionId: 'codex:queued-predecessor' });
  const queuedSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send(payload) { queuedSent.push(JSON.parse(payload)); },
  };
  h.window.doSend('queued', 'queued', []);
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    turnId: h.state.pendingSentMessages[0].id,
    ok: true,
    queued: true,
  });
  h.window.doSend('after queued', 'after queued', []);
  assert.equal(queuedSent[1].previousTurnId, '');
  await failPendingTurns();

  const sessionId = 'codex:terminal-result-race';
  resetSession(h, { sessionId });
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };

  h.window.doSend('hi', 'hi', []);
  const racedPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId,
    turnId: racedPending.id,
    seq: 1,
    error: 'unavailable',
  });
  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId,
    turnId: racedPending.id,
    seq: 0,
  });

  assert.equal(h.state.pendingSentMessages.length, 1);
  assert.equal(racedPending.turnEnded, true);
  assert.equal(
    h.document.querySelector('.sending-status').textContent,
    'sending...',
  );

  const detail = 'Codex app-server exited (1): launch failed';
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId,
    turnId: racedPending.id,
    ok: false,
    error: detail,
  });

  assert.equal(racedPending.failed, true);
  assert.equal(
    h.document.querySelector('.sending-status').textContent.includes(detail),
    true,
  );
  assert.match(
    h.document.querySelector('.sending-status').textContent,
    /Retry/,
  );

  resetSession(h, { sessionId });
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  h.window.doSend('accepted', 'accepted', []);
  const acceptedPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'stream_turn_start',
    sessionId: h.state.wsSessionId,
    turnId: acceptedPending.id,
    seq: 0,
  });
  h.hooks.handleWsMessage({
    action: 'stream_end',
    sessionId: h.state.wsSessionId,
    turnId: acceptedPending.id,
    seq: 1,
    error: 'runtime_error',
  });
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: h.state.wsSessionId,
    turnId: acceptedPending.id,
    ok: true,
  });

  assert.equal(h.state.pendingSentMessages.length, 0);
  assert.equal(
    h.document.getElementById(acceptedPending.id).hasAttribute('data-pending'),
    false,
  );
  assert.doesNotMatch(
    h.document.getElementById(acceptedPending.id).textContent,
    /Retry/,
  );
  h.window.close();
});
