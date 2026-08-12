import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

test('normal completion stops loading when the latest user turn ends', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:completion-loading' });
  h.state.appState.runtime = 'codex';
  h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };

  h.window.doSend('answer once', 'answer once', []);
  const pending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: h.state.wsSessionId,
    ok: true,
    clientId: pending.id,
    streamId: 'stream-complete',
  });
  h.hooks.pushStreamFrame('stream-complete', {
    t: 'start', seq: 0, blockId: 0, kind: 'text',
  });
  h.hooks.pushStreamFrame('stream-complete', {
    t: 'delta', seq: 1, blockId: 0, chunk: 'done',
  });
  h.hooks.pushStreamFrame('stream-complete', {
    t: 'stop', seq: 2, blockId: 0,
  });
  h.hooks.handleStreamEnd('stream-complete', 3);

  assert.equal(
    h.state.wsRunning,
    false,
    'the latest user turn stream_end is the loading terminal signal',
  );

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: h.state.wsSessionId,
    streamId: 'stream-complete',
    messages: [{
      uuid: 'assistant-complete',
      nativeId: 'codex:item:assistant-complete',
      type: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      timestamp: '2026-08-12T06:00:00.000Z',
    }],
  });
  await h.tick(250);

  assert.equal(h.state.wsRunning, false);
  assert.equal(h.document.querySelectorAll('.assistant-text').length, 1);
  assert.equal(h.document.querySelector('.assistant-text').textContent, 'done');
});
