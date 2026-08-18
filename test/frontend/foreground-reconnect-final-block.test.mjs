import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, ...extra };
}

function textMessage(uuid, nativeId, text, timestamp) {
  return {
    uuid,
    nativeId,
    type: 'assistant',
    content: [{ type: 'text', text }],
    timestamp,
  };
}

function toolUse(uuid, nativeId, toolUseId, timestamp) {
  return {
    uuid,
    nativeId,
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: toolUseId,
      name: 'WebSearch',
      input: { query: 'docs', action: 'search' },
    }],
    timestamp,
    stopReason: 'tool_use',
  };
}

test('REST merge and repeated foreground recovery preserve the final block and clear loading', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-final-block';
  const turnId = 'turn-foreground-final-block';
  const toolUseId = 'tool-search';
  resetSession(h, { sessionId });

  const user = {
    uuid: 'final-user',
    nativeId: 'codex:user:' + turnId,
    type: 'user',
    content: 'continue',
    timestamp: '2026-08-18T16:05:00.000Z',
  };
  const intro = textMessage(
    'intro-live',
    'codex:item:intro',
    'intro text',
    '2026-08-18T16:05:01.000Z',
  );
  const use = toolUse(
    'tool-use-live',
    'codex:item:tool:tool-use',
    toolUseId,
    '2026-08-18T16:05:02.000Z',
  );
  const result = {
    uuid: 'tool-result-live',
    nativeId: 'codex:item:tool:tool-result',
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: 'search complete',
      is_error: false,
    }],
    timestamp: '2026-08-18T16:05:02.000Z',
  };

  for (const item of [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', { messages: [user] }),
    event(sessionId, turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 3, 'stream_delta', { chunk: 'intro text' }),
    event(sessionId, turnId, 4, 'stream_block_stop'),
    event(sessionId, turnId, 5, 'messages', { messages: [intro] }),
    event(sessionId, turnId, 6, 'stream_block_start', {
      kind: 'tool_use',
      name: 'WebSearch',
    }),
    event(sessionId, turnId, 7, 'stream_tool_input', {
      chunk: '{"query":"docs","action":"search"}',
    }),
    event(sessionId, turnId, 8, 'stream_block_stop'),
    event(sessionId, turnId, 9, 'messages', { messages: [use] }),
    event(sessionId, turnId, 10, 'messages', { messages: [result] }),
  ]) h.hooks.handleWsMessage(item);
  await h.tick(40);

  let resolveRest;
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  h.setApiHandler(() => new Promise((resolve) => { resolveRest = resolve; }));
  const firstRecovery = h.hooks.beginSessionConnectionRecovery();
  h.hooks.startSessionConnectionRecovery(firstRecovery);

  const finalText = 'final answer '.repeat(180);
  const finalMessage = textMessage(
    'final-live',
    'codex:item:final',
    finalText,
    '2026-08-18T16:05:03.000Z',
  );
  for (const item of [
    event(sessionId, turnId, 11, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 12, 'stream_delta', { chunk: finalText }),
    event(sessionId, turnId, 13, 'stream_block_stop'),
    event(sessionId, turnId, 14, 'messages', { messages: [finalMessage] }),
    event(sessionId, turnId, 15, 'stream_end', {
      messages: [user, intro, use, result, finalMessage],
    }),
  ]) h.hooks.handleWsMessage(item);

  resolveRest({
    messages: [{
      ...result,
      uuid: 'tool-result-history',
    }],
    hasMore: false,
  });
  await h.tick(10);

  assert.equal(h.state.wsRunning, true, 'the final text may still be revealing');
  const secondRecovery = h.hooks.beginSessionConnectionRecovery();
  assert.deepEqual(
    secondRecovery.turnIds,
    [],
    'a turn with stream_end already consumed must not re-enter recovery',
  );

  await h.tick(150);
  const content = h.document.querySelector('.messages').textContent;
  assert.equal((content.match(/intro text/g) || []).length, 1);
  assert.equal(
    h.document.querySelectorAll(`[data-tool-id="${toolUseId}"]`).length,
    1,
  );
  assert.equal((content.match(/final answer/g) || []).length, 180);
  assert.equal(h.state.wsRunning, false);
});
