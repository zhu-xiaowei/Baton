import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('local command output renders under its own prompt after an earlier answer', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'claude-command-after-answer' });
  h.state.appState.runtime = 'claude';
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: h.state.wsSessionId,
    messages: [
      { uuid: 'u1', type: 'user', content: 'hello', timestamp: '2026-10-13T08:00:00.000Z' },
      { uuid: 'a1', type: 'assistant', content: [{ type: 'text', text: 'OK' }], stopReason: 'end_turn', timestamp: '2026-10-13T08:00:01.000Z' },
    ],
  });
  await h.tick();
  h.window.doSend('/status', '/status', []);
  const pending = h.state.pendingSentMessages[0];

  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: h.state.wsSessionId,
    turnId: pending.id,
    ok: true,
    commandOutput: 'Claude Code settings',
  });
  await h.tick();

  const rows = [...h.document.querySelector('.messages').children]
    .map((element) => `${element.className.split(' ')[0]}:${element.textContent.trim().slice(0, 7)}`);
  assert.deepEqual(rows, ['msg-user:hello', 'assistant-turn:OK', 'msg-user:/status', 'assistant-turn:Claude ']);
});
