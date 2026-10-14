import assert from 'node:assert/strict';
import test from 'node:test';
import { compactToolFields, configureToolPreviews, toolPreview, toolPreviews, toolResultStats } from '../../bridge/tool-preview.mjs';
import { LiveTurnStream } from '../../bridge/live-turn-stream.mjs';
import { prepareWsPayload } from '../../bridge/ws.mjs';
import { uploadMessages } from '../../bridge/extract.mjs';
import { initHttp } from '../../bridge/http.mjs';
import { deliverRealtimeMessages } from '../../bridge/realtime-delivery.mjs';

configureToolPreviews(true);

function message() {
  return {
    uuid: 'tool-message',
    type: 'assistant',
    content: [
      { type: 'thinking', thinking: 'keep reasoning', signature: 'unused' },
      { type: 'text', text: 'full answer'.repeat(300) },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: '🙂'.repeat(600), file_path: 'x'.repeat(600) } },
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'a'.repeat(600) + '\nProcess exited with code 1', is_error: true },
    ],
    toolUseResult: { text: 'b'.repeat(900), totalDurationMs: 123 },
  };
}

test('preview preserves structure, identifiers and text without mutating the source', () => {
  const original = message();
  const preview = toolPreview(original);
  assert.equal([...preview.content[2].input.command].length, 500);
  assert.equal(preview.content[2].input.file_path, original.content[2].input.file_path);
  assert.equal(preview.content[3].content.length, 500);
  assert.equal(preview.content[3].codexExitCode, 1);
  assert.equal(preview.content[3].is_error, true);
  assert.deepEqual(preview.toolUseResult, { totalDurationMs: 123 });
  assert.equal(preview.content[2].truncated, true);
  assert.equal(preview.content[3].truncated, true);
  assert.equal(preview.truncated, undefined);
  assert.equal(preview.content[0].signature, undefined);
  assert.deepEqual(preview.content[1], original.content[1]);
  assert.equal([...original.content[2].input.command].length, 600);
  assert.equal(original.content[0].signature, 'unused');
  assert.equal(toolPreview(preview), preview);
  assert.deepEqual(toolPreview(structuredClone(preview)), preview);
});

test('short input remains unmarked and ordinary text remains complete', () => {
  const original = { type: 'assistant', content: [{ type: 'tool_use', input: { command: 'x'.repeat(500) } }] };
  assert.equal(toolPreview(original), original);
  assert.equal(toolPreview({ content: 'x'.repeat(1000) }).content.length, 1000);
});

test('preview preserves arbitrary JSON keys as data', () => {
  const input = JSON.parse('{"__proto__":{"text":"' + 'x'.repeat(600) + '"}}');
  const preview = toolPreview({ content: [{ type: 'tool_use', input }] });
  assert.equal(Object.hasOwn(preview.content[0].input, '__proto__'), true);
  assert.equal(preview.content[0].input.__proto__.text.length, 500);
  assert.equal(Object.getPrototypeOf(preview.content[0].input), Object.prototype);
});

test('HTTP synchronization always writes previews even below the item size limit', async () => {
  initHttp({ server: 'https://test.invalid', apiKey: 'test' });
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true };
  };
  try {
    await uploadMessages('session', [message()]);
    assert.equal(calls[0].messages[0].content[2].truncated, true);
    assert.equal(calls[0].messages[0].content[2].input.command, '🙂'.repeat(500));
    assert.deepEqual(calls[0].messages[0].toolUseResult, { totalDurationMs: 123 });
  } finally { globalThis.fetch = previous; }
});

test('stream input keeps sequence continuity and terminal previews do not trigger transport recovery', () => {
  const sent = [];
  const stream = new LiveTurnStream({ sessionId: 'session', turnId: 'turn', send: (event) => sent.push(event) });
  stream.sendBlockStart({ blockId: 1, kind: 'tool_use' });
  stream.sendToolInput({ blockId: 9, chunk: 'ignored' });
  stream.sendToolInput({ blockId: 1, chunk: 'a'.repeat(400) });
  stream.sendToolInput({ blockId: 1, chunk: 'b'.repeat(200) });
  stream.sendToolInput({ blockId: 1, chunk: 'c'.repeat(200) });
  stream.sendAuthoritative(message());
  stream.sendEnd();
  const inputs = sent.filter((event) => event.action === 'stream_tool_input');
  assert.equal(inputs.map((event) => event.chunk).join(''), 'a'.repeat(400) + 'b'.repeat(100));
  assert.equal(inputs.at(-1).previewTruncated, true);
  assert.deepEqual(sent.map((event) => event.seq), sent.map((_, index) => index));
  const end = prepareWsPayload(sent.at(-1), new Set());
  assert.equal(end.recoveryRequired, undefined);
  assert.equal(end.truncated, undefined);
  assert.equal(end.messages[0].content[2].truncated, true);
});

test('Edit keeps paths and status without storing code in input or result metadata', () => {
  const original = [
    { uuid: 'edit-use', content: [{ type: 'tool_use', id: 'edit', name: 'Edit', input: {
      file_path: '/file.js', old_string: 'before', new_string: 'after',
    } }] },
    { uuid: 'edit-result', content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'code from a failed patch', is_error: true }],
      toolUseResult: { filePath: '/file.js', oldString: 'before', newString: 'after',
        originalFile: 'large original source', structuredPatch: [{ lines: ['-before', '+after'] }], replaceAll: false } },
  ];
  const preview = toolPreviews(original);
  assert.deepEqual(preview[0].content[0].input, { file_path: '/file.js' });
  assert.equal(preview[0].content[0].truncated, true);
  assert.equal(preview[1].content[0].content, 'code from a failed patch');
  assert.equal(preview[1].content[0].is_error, true);
  assert.equal(preview[1].content[0].truncated, undefined);
  assert.equal(Object.hasOwn(preview[1], 'toolUseResult'), false);
  assert.equal(original[0].content[0].input.old_string, 'before');
  assert.equal(original[1].toolUseResult.originalFile, 'large original source');
  assert.deepEqual(toolPreviews(preview), preview);
});

test('failed Edit output has the same truncation in live and single-message history paths', () => {
  for (const content of ['String to replace not found', '🙂'.repeat(600)]) {
    const result = { uuid: 'result', content: [{
      type: 'tool_result', tool_use_id: 'edit', content, is_error: true,
    }] };
    const history = toolPreview(result);
    const sent = [];
    const stream = new LiveTurnStream({ sessionId: 's', turnId: 't', send: event => sent.push(event) });
    stream.sendAuthoritative({ uuid: 'use', content: [{
      type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/file', old_string: 'old', new_string: 'new' },
    }] });
    stream.sendAuthoritative({ ...result, toolUseResult: { oldString: 'old', newString: 'new' } });
    assert.deepEqual(sent.at(-1).messages[0].content, history.content);
    assert.equal(!!history.content[0].truncated, [...content].length > 500);
    assert.equal([...history.content[0].content].length, Math.min([...content].length, 500));
  }
});

test('long streamed JSON is replaced by a valid structured preview before block stop', () => {
  for (const name of ['Bash', 'Write', 'Edit']) {
    const events = [];
    const stream = new LiveTurnStream({ sessionId: 's', turnId: name, send: event => events.push(event) });
    const input = { file_path: '/file.js', command: 'x'.repeat(1000), content: 'y'.repeat(1000) };
    const json = JSON.stringify(input);
    stream.sendBlockStart({ blockId: 1, kind: 'tool_use', name });
    stream.sendToolInput({ blockId: 1, chunk: json.slice(0, 400) });
    stream.sendToolInput({ blockId: 1, chunk: json.slice(400) });
    stream.sendBlockStop({ blockId: 1 });
    const replacement = events.find(event => event.replaceInput);
    assert.ok(replacement);
    const preview = JSON.parse(replacement.chunk);
    assert.equal(preview.file_path, '/file.js');
    assert.equal(preview.command?.length, name === 'Edit' ? undefined : 500);
    assert.equal(events.at(-1).action, 'stream_block_stop');
    assert.deepEqual(events.map(event => event.seq), events.map((_, index) => index));
  }
});

test('Edit stream sends no code while preserving sequence and terminal summaries', () => {
  const sent = [];
  const stream = new LiveTurnStream({ sessionId: 'session', turnId: 'edit-turn', send: event => sent.push(event) });
  stream.sendBlockStart({ blockId: 1, kind: 'tool_use', name: 'Edit' });
  stream.sendToolInput({ blockId: 1, chunk: '{"file_path":"/file.js","old_string":"secret old",' });
  stream.sendToolInput({ blockId: 1, chunk: '"new_string":"secret new"}' });
  stream.sendAuthoritative({ uuid: 'use', content: [{ type: 'tool_use', name: 'Edit', id: 'edit',
    input: { file_path: '/file.js', old_string: 'secret old', new_string: 'secret new' } }] });
  stream.sendAuthoritative({ uuid: 'result', content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'secret diff output' }],
    toolUseResult: { oldString: 'secret old', newString: 'secret new' } });
  stream.sendEnd();
  assert.doesNotMatch(JSON.stringify(sent), /secret/);
  assert.deepEqual(sent.map(event => event.seq), sent.map((_, index) => index));
  const inputs = sent.filter(event => event.action === 'stream_tool_input');
  assert.ok(inputs.filter(event => !event.replaceInput).every(event => event.chunk === '' && event.previewTruncated));
  assert.deepEqual(JSON.parse(inputs.find(event => event.replaceInput).chunk), { file_path: '/file.js' });
  assert.equal(sent.at(-1).recoveryRequired, undefined);
});

test('unused result metadata is omitted without changing complete OUT content', () => {
  const original = {
    content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'complete output', is_error: false }],
    toolUseResult: { stdout: 'unused'.repeat(1000), stderr: '', file: { base64: 'unused image' } },
  };
  const preview = toolPreview(original);
  assert.equal(Object.hasOwn(preview, 'toolUseResult'), false);
  assert.deepEqual(preview.content, original.content);
  assert.equal(preview.content[0].truncated, undefined);
  assert.equal(original.toolUseResult.stdout.length, 6000);
});

test('Agent result metadata preserves only its numeric statistics including zero', () => {
  assert.deepEqual(toolResultStats({
    totalDurationMs: 2500, totalToolUseCount: 0, stdout: 'discard', usage: { tokens: 123 },
  }), { totalDurationMs: 2500, totalToolUseCount: 0 });
  assert.equal(toolResultStats({ stdout: 'discard' }), null);
  const stats = { totalDurationMs: 2500, totalToolUseCount: 12 };
  assert.equal(toolResultStats(stats), stats);
  const sent = [];
  const stream = new LiveTurnStream({ sessionId: 'session', turnId: 'stats', send: event => sent.push(event) });
  stream.sendAuthoritative({ uuid: 'result', content: [], toolUseResult: { ...stats, stdout: 'discard' } });
  stream.sendEnd();
  assert.deepEqual(sent.at(-1).messages[0].toolUseResult, stats);
});

test('command compaction removes only duplicates and unused action commands', () => {
  const original = {
    type: 'tool_use', id: 'bash', name: 'Bash',
    input: {
      command: 'rg needle /src', cmd: 'rg needle /src',
      codexCommandActions: [{ type: 'search', path: '/src', query: 'needle', cmd: 'rg needle /src' }],
    },
  };
  const compact = compactToolFields(original);
  assert.deepEqual(compact.input, {
    command: 'rg needle /src',
    codexCommandActions: [{ type: 'search', path: '/src', query: 'needle' }],
  });
  assert.equal(original.input.cmd, original.input.command);
  assert.equal(original.input.codexCommandActions[0].cmd, original.input.command);
  assert.equal(compactToolFields(compact), compact);
  for (const input of [{ cmd: 'sole command' }, { command: 'primary', cmd: 'different' }]) {
    const block = { type: 'tool_use', name: 'Bash', input };
    assert.equal(compactToolFields(block), block);
  }
  const custom = { type: 'tool_use', name: 'Custom', input: { command: 'same', cmd: 'same' } };
  assert.equal(compactToolFields(custom), custom);
  const result = {
    type: 'tool_result', tool_use_id: 'bash', content: 'keep full output',
    codexCommandKind: 'explore',
    codexCommandActions: [{ type: 'read', path: '/src/file.js', name: 'file.js', cmd: 'cat /src/file.js' }],
  };
  assert.deepEqual(compactToolFields(result), {
    ...result, codexCommandActions: [{ type: 'read', path: '/src/file.js', name: 'file.js' }],
  });
});

test('HTTP and realtime delivery omit redundant command copies without creating truncation', async () => {
  const messages = [{
    uuid: 'use', type: 'assistant', content: [{
      type: 'tool_use', id: 'bash', name: 'Bash',
      input: { command: 'echo ok', cmd: 'echo ok', codexCommandActions: [{ type: 'unknown', cmd: 'x'.repeat(2000) }] },
    }],
  }, {
    uuid: 'result', type: 'user', content: [{
      type: 'tool_result', tool_use_id: 'bash', content: 'ok',
      codexCommandActions: [{ type: 'unknown', cmd: 'x'.repeat(2000) }],
    }],
  }];
  const expected = toolPreviews(messages);
  assert.equal(expected[0].content[0].truncated, undefined);
  assert.equal(expected[1].content[0].truncated, undefined);
  assert.equal(expected[0].content[0].input.cmd, undefined);
  assert.deepEqual(expected[1].content[0].codexCommandActions, [{ type: 'unknown' }]);
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true }; };
  try {
    initHttp({ server: 'https://test.invalid', apiKey: 'test' });
    await uploadMessages('session', messages);
    assert.deepEqual(requests[0].messages, expected);
  } finally { globalThis.fetch = previous; }
  const sent = [];
  await deliverRealtimeMessages('session', messages, {
    wsSendWithAckFn: async event => { sent.push(event); return true; },
    uploadMessagesFn: async () => { throw new Error('Unexpected fallback'); },
  });
  assert.deepEqual(sent[0].messages, expected);
  const stream = new LiveTurnStream({ sessionId: 'session', turnId: 'compact', send: event => sent.push(event) });
  messages.forEach(message => stream.sendAuthoritative(message));
  stream.sendEnd();
  assert.deepEqual(sent.at(-1).messages, expected);
});
