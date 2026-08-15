import assert from 'node:assert/strict';
import test from 'node:test';
import { dedupeCodexUserMessages } from '../../web/js/message-dedup.js';

function user(nativeId, timestamp, content = '你是我吗') {
  return {
    uuid: nativeId,
    nativeId,
    type: 'user',
    timestamp,
    content,
  };
}

test('Codex turn and client mirrors collapse to the client-scoped user row', () => {
  const messages = dedupeCodexUserMessages([
    user('codex:turn:turn-1:user', '2026-08-15T10:34:02.428Z'),
    user('codex:user:client-1', '2026-08-15T10:34:02.429Z'),
    { type: 'assistant', timestamp: '2026-08-15T10:34:04.089Z', content: [] },
  ]);

  assert.equal(messages.length, 2);
  assert.equal(messages[0].nativeId, 'codex:user:client-1');
});

test('intentional repeated user messages remain distinct', () => {
  const messages = dedupeCodexUserMessages([
    user('codex:user:client-1', '2026-08-15T10:34:02.000Z'),
    user('codex:user:client-2', '2026-08-15T10:34:02.010Z'),
    user('codex:turn:turn-2:user', '2026-08-15T10:34:03.000Z'),
    user('codex:user:client-3', '2026-08-15T10:34:03.500Z'),
  ]);

  assert.equal(messages.length, 4);
});
