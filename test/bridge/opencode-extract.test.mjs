import test from 'node:test';
import assert from 'node:assert/strict';
import { messageRows } from '../../bridge/opencode-extract.mjs';

test('OpenCode rows become Baton tool, prompt and turn-end rows', () => {
  const tool = { type: 'tool', id: 't1', name: 'shell', state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a' }], metadata: { exit: 1 } } };
  const [step, result] = messageRows({ id: 'm1', type: 'assistant', data: { content: [{ type: 'text', text: 'hi' }, tool], finish: 'tool-calls' } }, 3);
  assert.deepEqual([step.content[1], step.orderKey, step.stopReason], [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }, 'O2#000000000003#0000', 'tool_use']);
  assert.deepEqual([result.uuid, result.content[0].is_error, result.content[0].exitCode, result.orderKey], ['m1#r:t1', true, 1, 'O2#000000000003#0001']);
  const [user] = messageRows({ id: 'u1', type: 'user', data: { text: 'x', metadata: { baton: { turnId: 'T' } },
    files: [{ mime: 'image/png', data: 'AA', source: { uri: 'file:///h/.baton-bridge/tmp/k.png' } }] } });
  assert.deepEqual([user.uuid, user.nativeId, user.content], ['u1', 'live:user:T', [{ type: 'text', text: 'x' }]]);
  assert.equal(messageRows({ id: 'i', type: 'idle', data: { outcome: 'interrupted' } })[0].content[0].text, '[Request interrupted by user]');
});
