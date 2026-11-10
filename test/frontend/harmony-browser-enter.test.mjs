import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

const TABLET_UA = 'Mozilla/5.0 (Tablet; OpenHarmony 5.0) ArkWeb/5.0';

async function pressEnter(options) {
  const h = await makeHarness(options);
  resetSession(h, { sessionId: 'harmony-enter' });
  h.state.activeThreadCanSend = true;
  h.state.stagedImages = [];
  const sent = [];
  h.state.ws = { readyState: WebSocket.OPEN, send(p) { sent.push(JSON.parse(p)); }, close() {} };
  const input = h.document.getElementById('msg-input');
  input.value = 'line one';
  const event = new h.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  input.dispatchEvent(event);
  await h.tick(10);
  return { input, event, sends: sent.filter(m => m.action === 'send_message').length };
}

// The HarmonyOS system browser shares that UA but keeps the desktop Enter-to-send convention.
test('Enter in the HarmonyOS browser still sends', async () => {
  const { input, event, sends } = await pressEnter({ userAgent: TABLET_UA });
  assert.equal(input.getAttribute('enterkeyhint'), null);
  assert.equal(event.defaultPrevented, true);
  assert.equal(sends, 1);
});
