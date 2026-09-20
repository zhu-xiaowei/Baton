import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

async function completeStrictTurn(h, sessionId, turnId, options = {}) {
  var userMessage = {
    uuid: 'user-' + turnId,
    nativeId: 'codex:user:' + turnId,
    type: 'user',
    content: 'question',
    timestamp: '2026-08-22T00:00:00.000Z',
  };
  var finalMessage = {
    uuid: 'assistant-' + turnId,
    nativeId: 'codex:item:' + turnId,
    type: 'assistant',
    content: [{ type: 'text', text: 'finished' }],
    timestamp: '2026-08-22T00:00:01.000Z',
    ...(options.stopReason ? { stopReason: options.stopReason } : {}),
  };
  h.document.querySelector('.messages').insertAdjacentHTML(
    'beforeend',
    `<div class="msg-user" data-anchor="${turnId}">question</div>`,
  );
  var events = [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 2, 'stream_delta', { chunk: 'finished' }),
    event(sessionId, turnId, 3, 'stream_block_stop'),
    event(sessionId, turnId, 4, 'messages', { messages: [finalMessage] }),
  ];
  if (options.includeStreamEnd !== false) {
    events.push(event(sessionId, turnId, 5, 'stream_end', {
      messages: [userMessage, finalMessage],
    }));
  }
  for (var item of events) h.hooks.handleWsMessage(item);
  await h.tick(100);
}

test('strict lifecycle remains authoritative without the stream-end freshness timer', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:strict-late-row';
  resetSession(h, { sessionId });

  const realNow = Date.now;
  var now = realNow();
  Date.now = function () { return now; };
  try {
    await completeStrictTurn(h, sessionId, 'turn-strict-late');
    assert.equal(h.state.wsRunning, false);

    now += 5000;
    h.hooks.handleWsMessage({
      action: 'messages',
      sessionId,
      messages: [{
        uuid: 'late-watcher-copy',
        type: 'assistant',
        content: [{ type: 'text', text: 'finished' }],
        timestamp: '2026-08-22T00:00:02.000Z',
      }],
    });

    assert.equal(h.state.wsRunning, false);

    h.hooks.handleWsMessage({
      action: 'messages',
      sessionId,
      messages: [{
        uuid: 'external-user',
        type: 'user',
        content: 'continue externally',
        timestamp: '2026-08-22T00:00:03.000Z',
      }],
    });
    assert.equal(h.state.wsRunning, true);

    h.hooks.handleWsMessage({
      action: 'messages',
      sessionId,
      messages: [{
        uuid: 'external-assistant',
        type: 'assistant',
        content: [{ type: 'text', text: 'done externally' }],
        stopReason: 'end_turn',
        timestamp: '2026-08-22T00:00:04.000Z',
      }],
    });
    assert.equal(h.state.wsRunning, false);

    const fallbackTurnId = 'turn-terminal-fallback';
    await completeStrictTurn(h, sessionId, fallbackTurnId, {
      includeStreamEnd: false,
      stopReason: 'end_turn',
    });

    assert.equal(h.state.wsRunning, true);
    assert.equal(
      h.document.querySelector(`[data-turn-id="${fallbackTurnId}"]`)
        ?.classList.contains('stream-preview'),
      true,
    );
    var fallbackTurn = h.document.querySelector(
      `[data-turn-id="${fallbackTurnId}"]`,
    );
    assert.equal(fallbackTurn?.textContent.split('finished').length - 1, 1);

    h.hooks.handleWsMessage(event(sessionId, fallbackTurnId, 5, 'stream_end'));
    assert.equal(h.state.wsRunning, false);
    fallbackTurn = h.document.querySelector(
      `[data-turn-id="${fallbackTurnId}"]`,
    );
    assert.equal(fallbackTurn?.textContent.split('finished').length - 1, 1);
  } finally {
    Date.now = realNow;
  }
});
