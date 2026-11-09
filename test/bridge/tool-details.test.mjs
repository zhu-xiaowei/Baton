import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createToolDetailsReader, readToolIndex, readToolDetails, readToolDetailsAsync, toolDetails } from '../../bridge/tool-details.mjs';
import { extractCodexMessages } from '../../bridge/codex-extract.mjs';
import { toolPreview } from '../../bridge/tool-preview.mjs';
import { findClaudeSubagentFile } from '../../bridge/claude-subagent.mjs';
import { parseStorageSessionId } from '../../bridge/session-identity.mjs';

const SESSION = '11111111-1111-4111-8111-111111111111';
const claudeAt = (file) => ({ identityOf: parseStorageSessionId, adapterOf: () => ({ findSessionFile: () => file }) });

test('Claude details preserve full input/output; previews cut each field', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-details-'));
  const file = path.join(directory, 'session.jsonl');
  const input = '🙂"\\'.repeat(15000);
  const output = '完整输出\n'.repeat(20000);
  fs.writeFileSync(file, [
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'one', name: 'Bash', input: { command: input, cmd: input } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'one', content: output, codexCommandActions: [{ type: 'unknown', cmd: input }] }] }, toolUseResult: { totalDurationMs: 12, totalToolUseCount: 2, stdout: output, file: { base64: 'unused image' } } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'two', name: 'Read', input: { file_path: '/file' } }] } }),
  ].join('\n'));
  try {
    const data = await toolDetails({ sessionId: SESSION, toolUseIds: ['one', 'two'] }, claudeAt(file));
    assert.equal(data.details[0].toolUse.input.command, input);
    assert.equal(data.details[0].toolUse.input.cmd, undefined);
    assert.equal(data.details[0].toolResult.content, output);
    assert.deepEqual(data.details[0].toolResult.codexCommandActions, [{ type: 'unknown' }]);
    assert.deepEqual(data.details[0].toolResult._agentMeta, { totalDurationMs: 12, totalToolUseCount: 2 });
    assert.equal(data.details[1].toolResult, null);
    const preview = await toolDetails({ sessionId: SESSION, toolUseIds: ['one'], preview: true }, claudeAt(file));
    const { toolUse, toolResult } = preview.details[0];
    assert.ok(toolUse.truncated && toolResult.truncated, 'previews are marked truncated');
    for (const [cut, full] of [[toolUse.input.command, input], [toolResult.content, output]]) {
      assert.ok([...cut].length <= 501 && full.startsWith(cut.replace(/…$/, '')), 'each field cut to its preview');
    }
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

test('bad requests and missing original data are rejected', async () => {
  const none = claudeAt(null);
  await assert.rejects(toolDetails({ sessionId: SESSION, toolUseIds: ['one'] }, none), /unavailable/);
  for (const sessionId of ['', '../x', `${SESSION}:subagent:../../x`, `codex:${SESSION}:subagent:agent-a`]) {
    await assert.rejects(toolDetails({ sessionId, toolUseIds: ['one'] }, none), /invalid session/, sessionId);
  }
  for (const toolUseIds of [[], 'one', [1], ['x'.repeat(513)], Array(129).fill('a')]) {
    await assert.rejects(toolDetails({ sessionId: SESSION, toolUseIds }, none), /invalid toolUseIds/);
  }
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
    const details = await toolDetails({ sessionId: session, toolUseIds: ['child-tool'] }, {
      identityOf: parseStorageSessionId, adapterOf: () => ({ findSessionFile: id => findClaudeSubagentFile(id, directory) }),
    });
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
