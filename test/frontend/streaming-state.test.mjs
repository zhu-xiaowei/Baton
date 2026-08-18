import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamCoordinator } from '../../web/js/streaming.js';

function event(action, seq, extra = {}) {
  return {
    action,
    sessionId: 'session-1',
    turnId: 'turn-1',
    seq,
    ...extra,
  };
}

function frame(coordinator, action, seq, extra = {}) {
  const types = {
    stream_block_start: 'start',
    stream_delta: 'delta',
    stream_tool_input: 'input',
    stream_block_stop: 'stop',
  };
  return coordinator.ingestFrame({
    ...event(action, seq, extra),
    type: types[action],
  });
}

test('block-start seq is the only live block identity', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  frame(coordinator, 'stream_block_start', 1, { kind: 'text' });
  frame(coordinator, 'stream_delta', 2, { chunk: 'hello' });

  const turn = coordinator.getTurn('turn-1');
  assert.deepEqual([...turn.blocks.keys()], [1]);
  assert.equal(turn.blocks.get(1).text, 'hello');
});

test('later block input is buffered while the previous text is revealing', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  frame(coordinator, 'stream_block_start', 1, { kind: 'text' });
  frame(coordinator, 'stream_delta', 2, { chunk: 'first' });
  frame(coordinator, 'stream_block_stop', 3);
  coordinator.takeOperations();

  frame(coordinator, 'stream_block_start', 4, {
    kind: 'tool_use',
    name: 'Bash',
  });
  frame(coordinator, 'stream_tool_input', 5, {
    chunk: '{"command":"pwd"}',
  });
  frame(coordinator, 'stream_block_stop', 6);

  assert.equal(coordinator.takeOperations().length, 0);
  assert.equal(
    coordinator.getTurn('turn-1').blocks.get(4).inputJson,
    '{"command":"pwd"}',
  );

  assert.equal(coordinator.completeBlockReveal('turn-1', 1), true);
  const operations = coordinator.takeOperations();
  assert.ok(operations.some((operation) =>
    operation.type === 'createBlock' && operation.blockId === 4));
});

test('empty thinking block commits without blocking the following text', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  frame(coordinator, 'stream_block_start', 1, { kind: 'thinking' });
  frame(coordinator, 'stream_block_stop', 2);
  frame(coordinator, 'stream_block_start', 3, { kind: 'text' });
  frame(coordinator, 'stream_delta', 4, { chunk: 'answer' });

  const operations = coordinator.takeOperations();
  assert.equal(operations.some((operation) =>
    operation.type === 'createBlock' && operation.blockId === 1), false);
  assert.ok(operations.some((operation) =>
    operation.type === 'createBlock' && operation.blockId === 3));
});

test('authority matches ordered streamed blocks without wire block ids', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  frame(coordinator, 'stream_block_start', 1, { kind: 'thinking' });
  frame(coordinator, 'stream_block_stop', 2);
  frame(coordinator, 'stream_block_start', 3, { kind: 'text' });
  frame(coordinator, 'stream_delta', 4, { chunk: 'draft' });
  frame(coordinator, 'stream_block_stop', 5);
  coordinator.takeOperations();

  coordinator.ingestAuthoritative({
    ...event('messages', 6),
    messageId: 'message-1',
    message: {
      uuid: 'message-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'final' }],
    },
  });

  assert.equal(coordinator.getTurn('turn-1').blocks.get(3).authorityAssigned, true);
  assert.equal(coordinator.getTurn('turn-1').blocks.get(1).authorityAssigned, false);
  coordinator.completeBlockReveal('turn-1', 3);
  assert.ok(coordinator.takeOperations().some((operation) =>
    operation.type === 'patchBlock'
    && operation.blockId === 3
    && operation.block.text === 'final'));
});

test('authority arriving before its block waits for the matching start', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  coordinator.ingestAuthoritative({
    ...event('messages', 1),
    messageId: 'message-1',
    message: {
      uuid: 'message-1',
      type: 'assistant',
      content: [{ type: 'tool_use', name: 'Bash', id: 'tool-1', input: {} }],
    },
  });
  assert.equal(coordinator.getTurn('turn-1').unassignedAuthorityBlocks.length, 1);

  frame(coordinator, 'stream_block_start', 2, {
    kind: 'tool_use',
    name: 'Bash',
  });
  assert.equal(coordinator.getTurn('turn-1').unassignedAuthorityBlocks.length, 0);
  assert.equal(coordinator.getTurn('turn-1').blocks.get(2).authorityAssigned, true);
});

test('authority dedupes different UUIDs that share one native identity', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  frame(coordinator, 'stream_block_start', 1, { kind: 'text' });
  frame(coordinator, 'stream_delta', 2, { chunk: 'answer' });

  assert.equal(coordinator.ingestAuthoritative({
    ...event('messages', 3),
    message: {
      uuid: 'live-uuid',
      nativeId: 'native-answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    },
  }), true);
  assert.equal(coordinator.ingestAuthoritative({
    ...event('messages', 4),
    message: {
      uuid: 'history-uuid',
      nativeId: 'native-answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    },
  }), false);
});

test('reconnect preserves an active partial block for authoritative replacement', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  frame(coordinator, 'stream_block_start', 1, { kind: 'text' });
  frame(coordinator, 'stream_delta', 2, { chunk: 'draft' });
  coordinator.takeOperations();

  assert.equal(coordinator.prepareTurnsForReconnect(['turn-1']), 1);
  assert.deepEqual(coordinator.takeOperations(), []);
  assert.ok(coordinator.getTurn('turn-1'));
  assert.equal(coordinator.hasActiveTurns(), true);

  coordinator.ingestAuthoritative({
    ...event('messages', 3),
    message: {
      uuid: 'assistant-final',
      nativeId: 'native-final',
      type: 'assistant',
      content: [{ type: 'text', text: 'complete answer' }],
    },
  });
  assert.deepEqual(
    coordinator.takeOperations().map((operation) => operation.type),
    ['commitBlock', 'patchBlock'],
  );
  assert.equal(
    coordinator.getTurn('turn-1').blocks.get(1).text,
    'complete answer',
  );
});

test('reconnect preserves completed and partial blocks without DOM operations', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  frame(coordinator, 'stream_block_start', 1, { kind: 'text' });
  frame(coordinator, 'stream_delta', 2, { chunk: 'complete' });
  frame(coordinator, 'stream_block_stop', 3);
  coordinator.takeOperations();
  assert.equal(coordinator.completeBlockReveal('turn-1', 1), true);
  coordinator.takeOperations();

  frame(coordinator, 'stream_block_start', 4, { kind: 'text' });
  frame(coordinator, 'stream_delta', 5, { chunk: 'partial' });
  coordinator.takeOperations();

  assert.equal(coordinator.prepareTurnsForReconnect(['turn-1']), 1);
  assert.deepEqual(coordinator.takeOperations(), []);
  assert.equal(coordinator.getTurn('turn-1').blocks.size, 2);
});

test('reconnect authority replaces the old partial block but not later live blocks', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  frame(coordinator, 'stream_block_start', 1, { kind: 'text' });
  frame(coordinator, 'stream_delta', 2, { chunk: 'old partial' });
  coordinator.takeOperations();
  coordinator.prepareTurnsForReconnect(['turn-1']);

  coordinator.ingestAuthoritative({
    ...event('messages', 3),
    message: {
      uuid: 'old-final',
      type: 'assistant',
      content: [{ type: 'text', text: 'old complete' }],
    },
  });
  coordinator.takeOperations();

  frame(coordinator, 'stream_block_start', 4, { kind: 'text' });
  frame(coordinator, 'stream_delta', 5, { chunk: 'new partial' });
  coordinator.takeOperations();
  coordinator.ingestAuthoritative({
    ...event('messages', 6),
    message: {
      uuid: 'new-final',
      type: 'assistant',
      content: [{ type: 'text', text: 'new complete' }],
    },
  });

  assert.equal(
    coordinator.takeOperations().some((operation) =>
      operation.type === 'patchBlock' && operation.blockId === 4),
    false,
  );
  assert.equal(
    coordinator.getTurn('turn-1').blocks.get(4).text,
    'new partial',
  );
});

test('turns display serially even when a later turn is fully buffered', () => {
  const coordinator = new StreamCoordinator();
  coordinator.startTurn(event('stream_turn_start', 0));
  coordinator.startTurn({
    ...event('stream_turn_start', 0),
    turnId: 'turn-2',
  });
  coordinator.ingestFrame({
    ...event('stream_block_start', 1),
    turnId: 'turn-2',
    type: 'start',
    kind: 'text',
  });
  coordinator.ingestFrame({
    ...event('stream_delta', 2),
    turnId: 'turn-2',
    type: 'delta',
    chunk: 'second',
  });
  coordinator.ingestFrame({
    ...event('stream_block_stop', 3),
    turnId: 'turn-2',
    type: 'stop',
  });
  coordinator.endTurn({ ...event('stream_end', 4), turnId: 'turn-2' });
  assert.equal(coordinator.takeOperations().some((operation) =>
    operation.turnId === 'turn-2'), false);

  frame(coordinator, 'stream_block_start', 1, { kind: 'text' });
  frame(coordinator, 'stream_delta', 2, { chunk: 'first' });
  frame(coordinator, 'stream_block_stop', 3);
  coordinator.endTurn(event('stream_end', 4));
  coordinator.takeOperations();
  coordinator.completeBlockReveal('turn-1', 1);

  assert.ok(coordinator.takeOperations().some((operation) =>
    operation.type === 'createTurn' && operation.turnId === 'turn-2'));
  assert.equal(coordinator.getTurn('turn-1'), null);
});
