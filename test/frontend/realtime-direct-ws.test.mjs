import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateFrame } from '../../bridge/terminal-direct-protocol.mjs';
import { makeHarness, resetSession } from './harness.mjs';

test('direct data enters the unchanged history barrier, sequence queue and stream renderer', async context => {
  const harness = await makeHarness();
  const sessionId = 'codex:direct-session';
  resetSession(harness, { sessionId });
  harness.state.WS_URL = 'wss://control.example.test/v1';
  harness.state.ws = null;
  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    send(payload) { this.sent.push(JSON.parse(payload)); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = FakeWebSocket;
  harness.window.WebSocket = FakeWebSocket;
  globalThis.showWsBanner = harness.window.showWsBanner = () => {};
  context.after(() => { harness.window.disconnectWs(); harness.window.close(); });
  harness.window.connectWs();
  const control = sockets[0];
  control.readyState = 1;
  control.onopen();
  await harness.tick(20);
  const request = control.sent.find(message => message.action === 'realtime_direct');
  assert.ok(request);
  const deliverControl = message => control.onmessage({ data: JSON.stringify({ action: 'realtime_direct', v: 1,
    requestId: request.requestId, ...message }) });
  deliverControl({ type: 'offer', bindingId: 'binding', controlId: 'control',
    endpoint: 'https://data.example.test/v1', joinToken: 'token' });
  assert.equal(sockets.length, 2);
  const data = sockets[1];
  data.readyState = 1;
  data.onopen();
  assert.equal(data.sent[0].op, 'join');
  const key = 'ab'.repeat(32);
  deliverControl({ type: 'ready', bindingId: 'binding', frameKey: key });
  const turnId = 'direct-turn';
  const user = { uuid: 'direct-user', nativeId: `codex:user:${turnId}`, type: 'user', content: 'question' };
  const answer = { uuid: 'direct-answer', type: 'assistant', content: [{ type: 'text', text: 'direct answer' }] };
  const events = [
    { action: 'stream_turn_start' },
    { action: 'messages', messages: [user] },
    { action: 'stream_block_start', kind: 'text' },
    { action: 'stream_delta', chunk: 'direct answer' },
    { action: 'stream_block_stop' },
    { action: 'messages', messages: [answer] },
    { action: 'stream_end', messages: [user, answer] },
  ].map((message, seq) => ({ sessionId, turnId, seq, ...message }));
  for (const index of [0, 1, 3, 2, 5, 4, 6]) {
    const envelope = await authenticateFrame(JSON.stringify({ action: 'realtime_direct_frame', v: 1,
      bindingId: 'binding', event: events[index] }), key);
    data.onmessage({ data: JSON.stringify(envelope) });
  }
  await harness.tick(150);
  const turn = harness.document.querySelector(`[data-turn-id="${turnId}"]`);
  assert.ok(turn);
  assert.equal(turn.textContent.split('direct answer').length - 1, 1);
  assert.equal(turn.classList.contains('stream-committed'), true);
  assert.ok(harness.document.querySelector(`.msg-user[data-anchor="${turnId}"]`));
  assert.equal(control.sent.some(message => message.action.startsWith('stream_')), false);
});
