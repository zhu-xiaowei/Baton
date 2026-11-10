import assert from 'node:assert/strict';
import test from 'node:test';

import { truncateToBytes } from '../../bridge/extract.mjs';
import { fitWsPayload } from '../../bridge/ws.mjs';

function toolMessage(input, output) {
  return {
    uuid: 'message-1',
    nativeId: 'native-1',
    type: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: input },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: output,
      },
    ],
  };
}

test('messages within the byte budget keep complete tool IN and OUT', () => {
  const input = `start-${'i'.repeat(3000)}-end`;
  const output = `start-${'o'.repeat(6000)}-end`;
  const message = toolMessage(input, output);

  assert.equal(truncateToBytes(message, 360_000), message);
  assert.equal(message.content[0].input.command, input);
  assert.equal(message.content[1].content, output);
});

test('oversized messages compact tool IN and OUT before generic truncation', () => {
  const input = `input-head-${'i'.repeat(8000)}-input-tail`;
  const output = `output-head-${'o'.repeat(12_000)}-output-tail`;
  const compact = truncateToBytes(toolMessage(input, output), 7000);
  const compactInput = compact.content[0].input.command;
  const compactOutput = compact.content[1].content;

  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 7000);
  assert.equal(compactInput, input.slice(0, 500));
  assert.equal(compactOutput, output.slice(0, 500));
  assert.equal(compact.content[0].truncated, true);
  assert.equal(compact.content[1].truncated, true);
});

test('oversized messages events keep compact tool IN and OUT on the wire', () => {
  const input = `input-head-${'i'.repeat(8000)}-input-tail`;
  const output = `output-head-${'o'.repeat(12_000)}-output-tail`;
  const compact = fitWsPayload({
    action: 'messages',
    sessionId: 'session-1',
    turnId: 'turn-1',
    seq: 1,
    messages: [toolMessage(input, output)],
  }, 7000);

  assert.equal(compact.truncated, true);
  assert.equal(compact.messages.length, 1);
  assert.equal(compact.messages[0].uuid, 'message-1');
  assert.equal(compact.messages[0].nativeId, 'native-1');
  assert.equal(compact.messages[0].content[0].input.command, input.slice(0, 500));
  assert.equal(compact.messages[0].content[1].content, output.slice(0, 500));
  assert.equal(compact.messages[0].content[0].truncated, true);
  assert.equal(compact.messages[0].content[1].truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 7000);
});

test('messages fall back to an empty placeholder only when structure cannot fit', () => {
  const compact = fitWsPayload({
    action: 'messages',
    sessionId: 'session-1',
    turnId: 'turn-1',
    seq: 1,
    messages: [{
      uuid: 'message-1',
      nativeId: 'native-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(4000) }],
    }],
  }, 120);

  assert.deepEqual(compact.messages, []);
  assert.equal(compact.truncated, true);
});
