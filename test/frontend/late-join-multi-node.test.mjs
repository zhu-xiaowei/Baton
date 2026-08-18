import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

async function waitFor(h, predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await h.tick(10);
  }
  return predicate();
}

test('late join restores a missed node from authority and streams the next node', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:late-join-multi-node';
  const turnId = 'turn-late-join-multi-node';
  resetSession(h, { sessionId });
  const event = (seq, action, extra = {}) => ({
    action,
    sessionId,
    turnId,
    seq,
    ...extra,
  });
  const nodeA = {
    uuid: 'assistant-node-a',
    nativeId: 'codex:item:node-a',
    type: 'assistant',
    content: [{ type: 'text', text: 'complete node A' }],
    timestamp: '2026-08-17T00:00:01.000Z',
  };
  const nodeB = {
    uuid: 'assistant-node-b',
    nativeId: 'codex:item:node-b',
    type: 'assistant',
    content: [{ type: 'text', text: 'streamed node B' }],
    timestamp: '2026-08-17T00:00:02.000Z',
  };

  h.hooks.handleWsMessage(event(3, 'stream_delta', { chunk: 'partial A' }));
  h.hooks.handleWsMessage(event(4, 'stream_block_stop'));
  h.hooks.handleWsMessage(event(5, 'messages', { messages: [nodeA] }));
  h.hooks.handleWsMessage(event(6, 'stream_block_start', { kind: 'text' }));
  h.hooks.handleWsMessage(event(7, 'stream_delta', { chunk: 'streamed node B' }));
  await waitFor(h, () =>
    h.document.body.textContent.includes('streamed node B'));

  assert.equal(h.document.body.textContent.includes('partial A'), false);
  assert.equal(
    h.document.body.textContent.split('complete node A').length - 1,
    1,
  );
  assert.equal(
    h.document.body.textContent.split('streamed node B').length - 1,
    1,
  );

  h.hooks.handleWsMessage(event(8, 'stream_block_stop'));
  h.hooks.handleWsMessage(event(9, 'messages', { messages: [nodeB] }));
  h.hooks.handleWsMessage(event(10, 'stream_end', {
    messages: [nodeA, nodeB],
  }));
  await waitFor(h, () =>
    h.document.querySelector(`[data-turn-id="${turnId}"]`)
      ?.classList.contains('stream-committed'));

  assert.equal(h.document.body.textContent.includes('partial A'), false);
  assert.equal(
    h.document.body.textContent.split('complete node A').length - 1,
    1,
  );
  assert.equal(
    h.document.body.textContent.split('streamed node B').length - 1,
    1,
  );
  assert.equal(
    h.document.querySelector(`[data-turn-id="${turnId}"]`)
      ?.classList.contains('stream-committed'),
    true,
  );
});
