import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

// Fast-forward the 12s send timeout so the real reconcilePendingSend runs.
let clockOffset = 0;
const realNow = Date.now;
Date.now = () => realNow() + clockOffset;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 10000 ? 40 : ms, ...args);

let shared;
async function setup(sessionId) {
  const h = shared || (shared = await makeHarness());
  resetSession(h, { sessionId });
  h.state.activeThreadCanSend = true;
  h.state.stagedImages = [];
  const sent = [];
  h.state.ws = { readyState: WebSocket.OPEN, send(p) { sent.push(JSON.parse(p)); }, close() {} };
  const input = h.document.getElementById('msg-input');
  return { h, sent, input };
}
async function timeOut(h) { clockOffset += 13000; await h.tick(120); }
const visibleUsers = (h) => [...h.document.querySelectorAll('.messages .msg-user')].filter(el => !el.hidden);
const sendTurnIds = (sent) => [...new Set(sent.filter(m => m.action === 'send_message').map(m => m.turnId))];
const echo = (turnId, text) => ({ uuid: 'u-' + turnId, nativeId: 'codex:user:' + turnId, type: 'user', content: text, timestamp: new Date().toISOString() });

test('no receipt: nothing shown, composer keeps editable text', async () => {
  const { h, input } = await setup('codex:v1');
  input.value = 'hello v1';
  h.window.sendMessage();
  await timeOut(h);
  assert.equal(visibleUsers(h).length, 0);
  assert.equal(input.value, 'hello v1');
  assert.equal(input.readOnly, false);
});

test('send again reuses the turnId; one bubble after receipt; input cleared', async () => {
  const { h, input, sent } = await setup('codex:v2');
  input.value = 'hello v2';
  h.window.sendMessage();
  await timeOut(h);
  h.window.sendMessage();
  const ids = sendTurnIds(sent);
  assert.equal(ids.length, 1);
  h.hooks.handleWsMessage({ action: 'send_message_received', turnId: ids[0] });
  await h.tick(10);
  assert.equal(h.document.querySelectorAll('.messages .msg-user').length, 1);
  assert.equal(visibleUsers(h).length, 1);
  assert.equal(input.value, '');
});

test('late echo after rollback clears the composer and shows one bubble', async () => {
  const { h, input, sent } = await setup('codex:v3');
  input.value = 'hello v3';
  h.window.sendMessage();
  await timeOut(h);
  h.hooks.handleWsMessage({ action: 'messages', sessionId: 'codex:v3', messages: [echo(sent[0].turnId, 'hello v3')] });
  await h.tick(30);
  assert.equal(visibleUsers(h).length, 1);
  assert.equal(input.value, '');
});


test('missing receipt probes the socket and a rebuilt socket resends the same turn', async () => {
  const { h, input, sent } = await setup('codex:v4');
  const dead = h.state.ws;
  input.value = 'hello v4';
  h.window.sendMessage();
  await h.tick(150);
  assert.ok(sent.some(m => m.action === 'heartbeat'));
  assert.notEqual(h.state.ws, dead);
  const fresh = [];
  h.state.ws.readyState = WebSocket.OPEN;
  h.state.ws.send = (p) => fresh.push(JSON.parse(p));
  h.state.ws.onopen();
  const resent = fresh.filter(m => m.action === 'send_message' && m.turnId === sent[0].turnId);
  assert.equal(resent.length, 1);
});

test('receipt after the bubble node was replaced still clears the composer', async () => {
  const { h, input, sent } = await setup('codex:v5');
  input.value = 'hello v5';
  h.window.sendMessage();
  h.document.getElementById(sent[0].turnId).remove();
  h.hooks.handleWsMessage({ action: 'send_message_received', turnId: sent[0].turnId });
  await h.tick(10);
  assert.equal(input.value, '');
});
