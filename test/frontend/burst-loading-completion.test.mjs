import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

test('only the latest sent user turn controls burst loading completion', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:burst-loading' });
  h.state.appState.runtime = 'codex';
  h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };

  for (let i = 1; i <= 20; i++) h.window.doSend(String(i), String(i), []);
  const sends = [...h.state.pendingSentMessages];

  for (let i = 0; i < sends.length; i++) {
    h.hooks.handleWsMessage({
      action: 'send_message_result',
      sessionId: h.state.wsSessionId,
      ok: true,
      clientId: sends[i].id,
      streamId: `stream-${i + 1}`,
    });
  }

  for (let i = 0; i < sends.length; i++) {
    const streamId = `stream-${i + 1}`;
    h.hooks.pushStreamFrame(streamId, {
      t: 'start', seq: 0, blockId: 0, kind: 'text',
    });
    h.hooks.pushStreamFrame(streamId, {
      t: 'delta', seq: 1, blockId: 0, chunk: String(i + 1),
    });
    h.hooks.handleStreamEnd(streamId, 3);

    assert.equal(
      h.state.wsRunning,
      i < sends.length - 1,
      i < sends.length - 1
        ? 'an older stream_end must not stop loading'
        : 'the latest sent user turn must stop loading',
    );
  }
});
