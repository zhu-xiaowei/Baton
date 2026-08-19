import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const sessionId = 'codex:permission-gap';
const turnId = 'turn-permission-gap';

function event(seq, action, extra = {}) {
  return {
    action,
    sessionId,
    turnId,
    seq,
    ...extra,
  };
}

test('permission controls remain usable when an earlier stream frame is missing', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId });
  const shown = [];
  const resolved = [];
  globalThis.showPermissionPrompt = h.window.showPermissionPrompt = (message) => {
    shown.push(message.requestId);
  };
  globalThis.resolvePermissionPrompt = h.window.resolvePermissionPrompt = (requestId) => {
    resolved.push(requestId);
    return true;
  };

  h.hooks.handleWsMessage(event(0, 'stream_turn_start'));
  h.hooks.handleWsMessage(event(2, 'permission_request', {
    requestId: 'approval-gap',
    kind: 'tool',
    toolName: 'Bash',
    input: { command: 'pwd' },
  }));

  assert.deepEqual(shown, []);
  await h.tick(160);
  assert.deepEqual(shown, ['approval-gap']);

  h.hooks.handleWsMessage(event(3, 'permission_resolved', {
    requestId: 'approval-gap',
  }));
  await h.tick(160);
  assert.deepEqual(resolved, ['approval-gap']);

  h.hooks.handleWsMessage(event(1, 'stream_block_start', { kind: 'text' }));
  await h.tick(10);
  assert.deepEqual(shown, ['approval-gap']);
  assert.deepEqual(resolved, ['approval-gap']);
});
