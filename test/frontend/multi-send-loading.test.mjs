import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

test('interrupt keeps loading for queued turns and stops immediately on the last turn', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:loading' });
  h.state.appState.runtime = 'codex';
  h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };

  h.window.doSend('1', '1', []);
  h.window.doSend('2', '2', []);
  const [first, second] = h.state.pendingSentMessages;
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: h.state.wsSessionId,
    ok: true,
    clientId: first.id,
    streamId: 'stream-1',
  });
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: h.state.wsSessionId,
    ok: true,
    clientId: second.id,
    streamId: 'stream-2',
  });

  h.hooks.pushStreamFrame('stream-1', {
    t: 'start', seq: 0, blockId: 0, kind: 'text',
  });
  h.hooks.pushStreamFrame('stream-1', {
    t: 'delta', seq: 1, blockId: 0, chunk: '1',
  });
  assert.equal(h.state.wsRunning, true);

  h.window.interruptSession();
  assert.equal(
    h.state.wsRunning,
    true,
    'interrupting the active turn must keep loading while another question is queued',
  );
  h.hooks.handleStreamEnd('stream-1', 2);
  assert.equal(h.state.wsRunning, true);

  h.hooks.pushStreamFrame('stream-2', {
    t: 'start', seq: 0, blockId: 0, kind: 'text',
  });
  h.hooks.pushStreamFrame('stream-2', {
    t: 'delta', seq: 1, blockId: 0, chunk: '2',
  });
  assert.equal(h.state.wsRunning, true);

  h.window.interruptSession();
  assert.equal(
    h.state.wsRunning,
    false,
    'interrupting the final outstanding turn must stop loading immediately',
  );
  h.hooks.pushStreamFrame('stream-2', {
    t: 'stop', seq: 2, blockId: 0,
  });
  assert.equal(h.state.wsRunning, false, 'late frames from the interrupted turn must not relight loading');
});
