import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToolDetailsReader, readToolIndex, readToolDetails, readToolDetailsAsync, handleToolDetails } from '../../bridge/tool-details.mjs';
import { extractCodexMessages } from '../../bridge/codex-extract.mjs';
import { WS_FRAME_LIMIT } from '../../bridge/config.mjs';
import { toolPreview } from '../../bridge/tool-preview.mjs';
import { findClaudeSubagentFile } from '../../bridge/claude-subagent.mjs';
import { parseStorageSessionId } from '../../bridge/session-identity.mjs';

test('Claude details preserve full input/output and use existing bounded text frames', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-details-'));
  const file = path.join(directory, 'session.jsonl');
  const input = '🙂"\\'.repeat(15000);
  const output = '\u5b8c\u6574\u8f93\u51fa\n'.repeat(20000);
  fs.writeFileSync(file, [
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'one', name: 'Bash', input: { command: input, cmd: input } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: output, codexCommandActions: [{ type: 'unknown', cmd: input }] }] }, toolUseResult: { totalDurationMs: 12, totalToolUseCount: 2, stdout: output, file: { base64: 'unused image' } } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'two', name: 'Read', input: { file_path: '/file' } }] } }),
  ].join('\n'));
  try {
    const frames = [];
    await handleToolDetails({ requestId: 'request', replyConnectionId: 'app', toolUseIds: ['one', 'two'] }, {
      identity: { sessionId: 'session', nativeSessionId: 'session', runtime: 'claude' },
      adapter: { findSessionFile: () => file },
      send: (frame) => frames.push(frame),
    });
    assert.ok(frames.length > 1);
    assert.ok(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame)) <= WS_FRAME_LIMIT));
    assert.deepEqual(frames.map((frame) => frame.sequence), frames.map((_, index) => index));
    assert.equal(frames.at(-1).complete, true);
    const data = JSON.parse(frames.map((frame) => frame.content).join(''));
    assert.equal(data.details[0].toolUse.input.command, input);
    assert.equal(data.details[0].toolUse.input.cmd, undefined);
    assert.equal(data.details[0].toolResult.content, output);
    assert.deepEqual(data.details[0].toolResult.codexCommandActions, [{ type: 'unknown' }]);
    assert.deepEqual(data.details[0].toolResult._agentMeta, { totalDurationMs: 12, totalToolUseCount: 2 });
    assert.equal(data.details[1].toolResult, null);
    assert.ok(frames.every((frame) => frame.action === 'tool_details' && frame.replyConnectionId === 'app'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Codex details reuse stable normalized tool IDs from the native rollout', () => {
  const file = new URL('../codex/phase1/fixtures/codex/rollout-2026-08-06T00-00-00-22222222-2222-4222-8222-222222222222.jsonl', import.meta.url);
  const session = '22222222-2222-4222-8222-222222222222';
  const messages = extractCodexMessages(file, session).messages;
  const tool = messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .find((block) => block.type === 'tool_use');
  assert.ok(tool);
  const result = readToolDetails(file, session, 'codex', [tool.id]);
  const expected = structuredClone(tool);
  delete expected.input.cmd;
  assert.deepEqual(result.details[0].toolUse, expected);
  assert.equal(tool.input.cmd, tool.input.command);
  assert.equal(result.details[0].toolResult.tool_use_id, tool.id);
});

test('missing original data returns an RPC error without a history message', async () => {
  const sent = [];
  await handleToolDetails({ requestId: 'request', replyConnectionId: 'app', toolUseIds: ['one'] }, {
    identity: { sessionId: 'session', nativeSessionId: 'session', runtime: 'claude' },
    adapter: { findSessionFile: () => null },
    send: (frame) => sent.push(frame),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ok, false);
  assert.equal(sent[0].action, 'tool_details');
});

test('Claude subagent details use the original child-session file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-details-'));
  const parent = '22222222-2222-4222-8222-222222222222';
  const session = `${parent}:subagent:agent-a1b2c3`;
  const childDirectory = path.join(directory, 'project', parent, 'subagents');
  fs.mkdirSync(childDirectory, { recursive: true });
  fs.writeFileSync(path.join(childDirectory, 'agent-a1b2c3.jsonl'), JSON.stringify({
    message: { content: [{ type: 'tool_use', id: 'child-tool', name: 'Read', input: { file_path: '/child.js' } }] },
  }) + '\n');
  try {
    const frames = [];
    await handleToolDetails({ requestId: 'request', replyConnectionId: 'app', toolUseIds: ['child-tool'] }, {
      identity: parseStorageSessionId(session),
      adapter: { findSessionFile: id => findClaudeSubagentFile(id, directory) },
      send: frame => frames.push(frame),
    });
    assert.equal(frames.at(-1).complete, true);
    assert.equal(frames[0].sessionId, session);
    const details = JSON.parse(frames.map(frame => frame.content).join(''));
    assert.equal(details.details[0].toolUse.input.file_path, '/child.js');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('incremental Codex Edit results omit code while detail reads keep the original', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-details-'));
  const file = path.join(directory, 'rollout.jsonl');
  const session = '33333333-3333-4333-8333-333333333333';
  const rows = [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch',
      call_id: 'patch-call', input: '*** Begin Patch\n*** Update File: source.js\n@@\n-before code\n+after code\n*** End Patch' } },
    { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'patch-call',
      success: true, stdout: 'after code from patch output' } },
  ];
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n'));
  try {
    const incremental = extractCodexMessages(file, session, { startLine: 1 }).messages;
    const result = incremental.find(message => message.content?.some(block => block.type === 'tool_result'));
    assert.ok(result);
    assert.equal(result.content[0].content, 'after code from patch output');
    assert.equal(toolPreview(result).content[0].content, 'Applied changes successfully.');
    assert.equal(toolPreview(structuredClone(result)).content[0].content, 'Applied changes successfully.');
    assert.equal(toolPreview(JSON.parse(JSON.stringify(result))).content[0]._toolName, undefined);
    const use = extractCodexMessages(file, session).messages
      .flatMap(message => message.content || []).find(block => block.type === 'tool_use');
    const details = readToolDetails(file, session, 'codex', [use.id]);
    assert.equal(details.details[0].toolUse.input.old_string, 'before code');
    assert.equal(details.details[0].toolUse.input.new_string, 'after code');
    assert.equal(details.details[0].toolResult.content, 'after code from patch output');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the detail reader indexes a stable file once and rebuilds after it changes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'detail-index-'));
  const file = path.join(directory, 'session.jsonl');
  const row = id => JSON.stringify({ message: { content: [{
    type: 'tool_use', id, name: 'Bash', input: { command: id },
  }] } });
  fs.writeFileSync(file, Array.from({ length: 20 }, (_, id) => row(String(id))).join('\n'));
  let reads = 0;
  const read = createToolDetailsReader((...args) => { reads++; return readToolIndex(...args); });
  try {
    for (let id = 0; id < 20; id++) assert.equal(read(file, 'session', 'claude', [String(id)]).details[0].toolUse.id, String(id));
    assert.equal(reads, 1);
    fs.appendFileSync(file, '\n' + row('new'));
    assert.equal(read(file, 'session', 'claude', ['new']).details[0].toolUse.id, 'new');
    assert.equal(reads, 2);
    const pending = readToolDetailsAsync(file, 'session', 'claude', ['new']);
    assert.ok(pending instanceof Promise);
    assert.equal((await pending).details[0].toolUse.id, 'new');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
