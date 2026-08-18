import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function turnEvent(seq, action, extra = {}) {
  return {
    action,
    sessionId: 'codex:permission-resume',
    turnId: 'turn-permission-resume',
    seq,
    ...extra,
  };
}

test('a recovered permission resumes the strict turn before the next output', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:permission-resume' });
  const shown = [];
  const resolved = [];
  globalThis.showPermissionPrompt = h.window.showPermissionPrompt = (message) => {
    shown.push(message.requestId);
  };
  globalThis.resolvePermissionPrompt = h.window.resolvePermissionPrompt = (requestId) => {
    resolved.push(requestId);
    return true;
  };

  h.hooks.handleWsMessage(turnEvent(12, 'permission_request', {
    requestId: 'approval-1',
    kind: 'tool',
    toolName: 'Bash',
    input: { command: 'echo approved' },
  }));

  assert.deepEqual(shown, ['approval-1']);

  h.hooks.handleWsMessage(turnEvent(13, 'permission_resolved', {
    requestId: 'approval-1',
  }));
  h.hooks.handleWsMessage(turnEvent(14, 'messages', {
    messages: [{
      uuid: 'tool-result-1',
      type: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'approved output',
      }],
    }],
  }));
  assert.equal(
    h.state.wsAllMessages.some((message) => message.uuid === 'tool-result-1'),
    true,
    'OUT authority is consumed before a later block or stream_end',
  );

  h.hooks.handleWsMessage(turnEvent(15, 'stream_block_start', {
    kind: 'text',
  }));
  h.hooks.handleWsMessage(turnEvent(16, 'stream_delta', {
    chunk: 'continued immediately',
  }));

  await h.tick(30);
  assert.deepEqual(resolved, ['approval-1']);
  assert.equal(
    h.document.querySelector('[data-turn-id="turn-permission-resume"]')
      ?.textContent,
    'continued immediately',
  );
});
