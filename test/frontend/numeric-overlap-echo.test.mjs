import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { replay } from './replay.mjs';

test('an overlapping numeric echo cannot retire another stream anchor', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:numeric-overlap' });
  h.state.appState.runtime = 'codex';

  await replay(h, [
    { u: '31' },
    { u: '1' },
    { ack: '31', streamId: 'stream-31' },
    { ack: '1', streamId: 'stream-1' },
    {
      inMsg: {
        uuid: 'user-31',
        nativeId: 'codex:user:stream-31',
        type: 'user',
        content: '31',
        timestamp: '2026-08-12T07:30:00.000Z',
      },
      streamId: 'stream-31',
    },
  ]);

  const one = Array.from(h.document.querySelectorAll('.msg-user')).find(
    (node) => (node.textContent || '').trim() === '1',
  );
  assert.ok(one, 'the pending 1 bubble must remain visible after the 31 echo');
  assert.equal(one.getAttribute('data-anchor'), one.id);
  assert.equal(one.getAttribute('data-pending'), '1');
});
