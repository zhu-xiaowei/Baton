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

  harness.state.appState.runtime = 'claude';
  const lostTurnId = 'claude-lost-end';
  const lostUser = { uuid: 'lost-user', turnId: lostTurnId, type: 'user', content: 'next question' };
  const lostAnswer = { uuid: 'lost-answer', turnId: lostTurnId, type: 'assistant', content: 'recovered answer' };
  for (const [seq, message] of [
    { action: 'stream_turn_start' },
    { action: 'messages', messages: [lostUser] },
    { action: 'stream_block_start', kind: 'text' },
  ].entries()) {
    const envelope = await authenticateFrame(JSON.stringify({ action: 'realtime_direct_frame', v: 1,
      bindingId: 'binding', event: { sessionId, turnId: lostTurnId, seq, ...message } }), key);
    data.onmessage({ data: JSON.stringify(envelope) });
  }
  await harness.tick(50);
  assert.equal(harness.state.wsRunning, true);
  let recoveryRequests = 0;
  harness.setApiHandler(() => {
    recoveryRequests++;
    return recoveryRequests === 1
      ? { messages: [user, answer, lostUser], status: 'running' }
      : { messages: [user, answer, lostUser, lostAnswer], status: 'completed' };
  });
  harness.document.body.insertAdjacentHTML('afterbegin', '<div id="top-right"><button class="git-status-entry"></button></div>');
  data.readyState = 3;
  data.onclose();
  await harness.tick(50);
  assert.equal(control.readyState, 1, 'the control socket stays connected throughout the data gap');
  assert.equal(recoveryRequests, 1, 'losing the data socket must recover even without stream_end');
  assert.equal(harness.state.wsRunning, true);
  assert.ok(harness.document.getElementById('ws-reconnect-indicator'));
  await harness.tick(3050);
  const reconnectRequest = control.sent.findLast(message => message.action === 'realtime_direct');
  assert.notEqual(reconnectRequest.requestId, request.requestId);
  deliverControl({ type: 'offer', requestId: reconnectRequest.requestId, bindingId: 'reconnected-binding',
    controlId: 'control', endpoint: 'https://data.example.test/v1', joinToken: 'new-token' });
  sockets[2].readyState = 1;
  sockets[2].onopen();
  deliverControl({ type: 'ready', requestId: reconnectRequest.requestId,
    bindingId: 'reconnected-binding', frameKey: key });
  await harness.tick(50);
  assert.equal(recoveryRequests, 2, 'the restored data binding must recover messages completed during the gap');
  assert.match(harness.document.querySelector('.messages').textContent, /recovered answer/);
  assert.equal(harness.state.wsRunning, false);
  assert.equal(harness.document.getElementById('ws-reconnect-indicator'), null);

  harness.window.doSend('pending before data gap', 'pending before data gap', []);
  const pending = harness.state.pendingSentMessages[0];
  sockets[2].readyState = 3;
  sockets[2].onclose();
  await harness.tick(50);
  assert.equal(recoveryRequests, 3);
  assert.equal(harness.state.pendingSentMessages.includes(pending), true);
  assert.equal(harness.document.getElementById(pending.id)?.isConnected, true);
  assert.equal(harness.state.wsRunning, true, 'recovering an old answer must not complete a pending question');
});
