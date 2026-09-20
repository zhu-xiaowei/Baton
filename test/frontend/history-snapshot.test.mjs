import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceHistoryTail } from '../../web/js/history-snapshot.js';

const message = (uuid, content = uuid) => ({ uuid, type: 'assistant', content });

test('a snapshot replaces the entire tail after one boundary lookup', () => {
  const local = ['one', 'two', 'three', 'stale'].map(value => message(value));
  const snapshot = [message('two', 'updated'), message('four')];
  const result = replaceHistoryTail(local, snapshot);
  assert.deepEqual(result.messages, [local[0], ...snapshot]);
  assert.equal(result.preservedCount, 1);
  assert.equal(result.messages[0], local[0]);
  assert.equal(local[1].content, 'two');
  assert.equal(snapshot.length, 2);
});

test('a 200-message snapshot preserves an already paginated prefix', () => {
  const local = Array.from({ length: 1000 }, (_, index) => message(String(index + 1)));
  const snapshot = Array.from({ length: 200 }, (_, index) => message(String(index + 901)));
  const result = replaceHistoryTail(local, snapshot);
  assert.equal(result.preservedCount, 900);
  assert.equal(result.messages.length, 1100);
  assert.equal(result.messages[899], local[899]);
  assert.equal(result.messages[900], snapshot[0]);
  assert.equal(result.messages.at(-1).uuid, '1100');
});

test('missing or ambiguous boundaries replace the whole history', () => {
  const snapshot = [message('boundary')];
  for (const local of [[], [message('other')], [message('boundary'), message('boundary')]]) {
    assert.deepEqual(replaceHistoryTail(local, snapshot), {
      messages: snapshot, preservedCount: 0,
    });
  }
});

test('a unique native ID can identify a boundary whose UUID changed', () => {
  const prefix = message('prefix');
  const local = [prefix, { ...message('live-id'), nativeId: 'item:one' }, message('stale')];
  const snapshot = [{ ...message('stored-id'), nativeId: 'item:one' }];
  assert.deepEqual(replaceHistoryTail(local, snapshot).messages, [prefix, ...snapshot]);
});

test('missing IDs and reused native IDs never use text or timestamps as a boundary', () => {
  const local = [message('prefix'), { nativeId: 'reused', type: 'user' }, { nativeId: 'reused', type: 'user' }];
  for (const snapshot of [[{ nativeId: 'reused', type: 'user' }], [{ type: 'user', content: 'prefix' }]]) {
    assert.equal(replaceHistoryTail(local, snapshot).preservedCount, 0);
  }
});

test('an empty authoritative snapshot clears old history', () => {
  assert.deepEqual(replaceHistoryTail([message('old')], []), {
    messages: [], preservedCount: 0,
  });
});
