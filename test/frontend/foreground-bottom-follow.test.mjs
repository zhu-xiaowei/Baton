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

test('foreground recovery follows new content without a delayed bottom snap', async () => {
  const h = await makeHarness();
  const sessionId = 'codex:foreground-bottom-follow';
  resetSession(h, { sessionId });
  const content = h.document.getElementById('content');
  let height = 1000;
  let top = 100;
  Object.defineProperties(content, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, get: () => height },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value) => { top = value; },
    },
  });
  h.state.stickBottom = true;
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send() {},
  };
  h.setApiResponse({
    messages: [{
      uuid: 'foreground-user',
      type: 'user',
      content: 'question',
    }, {
      uuid: 'foreground-answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'large restored update' }],
    }],
    hasMore: false,
    status: 'running',
  });

  assert.equal(h.window.resumeSessionForeground(), true);
  assert.equal(await waitFor(h, () => top === 1000), true);

  height = 1800;
  await h.tick(220);

  assert.equal(top, 1000);
  h.hooks.handleWsMessage({
    action: 'messages', sessionId,
    messages: [{ uuid: 'new-visible-message', type: 'assistant', content: 'new content' }],
  });
  assert.equal(await waitFor(h, () => top === 1800), true);
  assert.equal(h.state.stickBottom, true);
  h.window.close();
});
