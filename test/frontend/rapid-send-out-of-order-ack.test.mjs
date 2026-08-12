import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { replay } from './replay.mjs';

test('a later ack cannot retire an earlier queued bubble', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:rapid-send' });
  h.state.appState.runtime = 'codex';

  await replay(h, [
    { u: '1' },
    { u: '2' },
    { u: '3' },
    { u: '4' },
    { u: '5' },
    { ack: '1', streamId: 'stream-1' },
    // Reproduce the real API Gateway race: 2's ack is delayed while later
    // sends are already acknowledged.
    { ack: '3', streamId: 'stream-3' },
    { ack: '4', streamId: 'stream-4' },
    { ack: '5', streamId: 'stream-5' },
    { start: true, sid: 'stream-1', block: 0, kind: 'text' },
    { delta: true, sid: 'stream-1', block: 0, text: '1' },
    { stop: true, sid: 'stream-1', block: 0 },
    { authAsst: '1', streamId: 'stream-1' },
    { end: true, sid: 'stream-1', finalSeq: 3 },
  ]);

  const second = Array.from(h.document.querySelectorAll('.msg-user')).find(
    (node) => (node.textContent || '').trim() === '2',
  );
  assert.ok(second, 'the queued second message must remain visible');
  assert.equal(second.getAttribute('data-anchor'), second.id);
  assert.equal(second.getAttribute('data-pending'), '1');

  h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
  h.window.startWs('codex:next-session');
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:rapid-send',
    ok: true,
    clientId: second.id,
    streamId: 'late-old-stream',
  });
  assert.equal(
    h.state.streamAnchors['late-old-stream'],
    undefined,
    'a late ack from the previous session must not restore its anchor',
  );
});
