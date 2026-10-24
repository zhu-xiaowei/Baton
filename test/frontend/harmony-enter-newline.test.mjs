import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

// HarmonyOS tablet UAs lack "Mobile"; Enter must still insert a newline, not send.
test('Enter on HarmonyOS does not send and keeps the default newline', async () => {
  const h = await makeHarness({ userAgent: 'Mozilla/5.0 (Tablet; OpenHarmony 5.0) ArkWeb/5.0' });
  resetSession(h, { sessionId: 'harmony-enter' });
  h.state.activeThreadCanSend = true;
  h.state.stagedImages = [];
  const sent = [];
  h.state.ws = { readyState: WebSocket.OPEN, send(p) { sent.push(JSON.parse(p)); }, close() {} };
  const input = h.document.getElementById('msg-input');
  assert.equal(input.getAttribute('enterkeyhint'), 'enter');
  input.value = 'line one';
  const event = new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  await h.tick(10);
  assert.equal(event.defaultPrevented, false);
  assert.equal(sent.filter(m => m.action === 'send_message').length, 0);
  assert.equal(input.value, 'line one');
});
