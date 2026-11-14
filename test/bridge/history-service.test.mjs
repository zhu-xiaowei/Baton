import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryService } from '../../bridge/history-service.mjs';
import { createHistoryPages } from '../../bridge/history-pages.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-service-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const write = (file, rows) => fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
const ts = (i) => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();

function claudeRows(turns, from = 0) {
  const rows = [];
  for (let t = from; t < from + turns; t++) {
    rows.push({ type: 'user', uuid: `u${t}`, timestamp: ts(t), message: { role: 'user', content: `prompt ${t}` } });
    rows.push({ type: 'assistant', uuid: `a${t}`, timestamp: ts(t), message: { role: 'assistant', stop_reason: 'tool_use', content: [
      { type: 'thinking', thinking: 'secret', signature: 'sig' },
      { type: 'tool_use', id: `t${t}`, name: 'Bash', input: { command: 'ls', description: 'List' } }] } });
    rows.push({ type: 'user', uuid: `r${t}`, timestamp: ts(t), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `t${t}`, content: t % 2 ? 'short error: failed' : 'x'.repeat(900) }] } });
  }
  return rows;
}

const pages = createHistoryPages();
const claude = { runtime: 'claude', nativeSessionId: 's' };

test('history pages: interval, hasMore, gap fill, stable cursor, titles and visible-only rows', async () => {
  const file = path.join(tmp, 'claude.jsonl');
  write(file, [{ type: 'ai-title', aiTitle: 'Old', sessionId: 's' }, ...claudeRows(100), { type: 'ai-title', aiTitle: 'New', sessionId: 's' }]);
  const target = { ...claude, file };
  const latest = await pages.history(target, { limit: 50 });
  assert.equal(latest.messages.length, 50);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.oldestTimestamp, latest.messages[0].orderKey);
  assert.equal(latest.stableCursor, latest.messages.at(-1).orderKey, 'Claude rows never change');
  assert.deepEqual(latest.titles.map((row) => row.content), ['New']);
  const [thinking, tool] = latest.messages.find((row) => row.uuid === 'a99').content;
  assert.deepEqual(thinking, { type: 'thinking', truncated: true });
  assert.equal(tool.input.command, 'ls');
  const results = latest.messages.filter((row) => row.uuid.startsWith('r')).map((row) => row.content[0]);
  assert.ok(results.some((block) => block.content === 'short error: failed'), 'short results stay for the header state');
  assert.ok(results.some((block) => block.truncated && !('content' in block)), 'truncated bodies come on expand');

  const older = await pages.history(target, { before: latest.oldestTimestamp, limit: 50 });
  assert.equal(older.messages.at(-1).uuid, 'u83', 'the page just before a83, the oldest of the latest 50');
  assert.equal(older.stableCursor, undefined, 'only pages that reach the end carry a cursor');

  fs.appendFileSync(file, claudeRows(2, 100).map((row) => JSON.stringify(row)).join('\n') + '\n');
  const delta = await pages.history(target, { after: latest.stableCursor, epoch: latest.epoch });
  assert.deepEqual(delta.messages.map((row) => row.uuid), ['u100', 'a100', 'r100', 'u101', 'a101', 'r101']);
  assert.equal(delta.hasMore, false);
  const none = await pages.history(target, { after: delta.stableCursor, epoch: latest.epoch });
  assert.deepEqual(none.messages, []);
  assert.equal(none.stableCursor, delta.stableCursor);

  const gap = await pages.history(target, { after: older.messages[10].orderKey, limit: 20 });
  assert.equal(gap.hasMore, true, 'more than a page is newer than the cache');
  const fill = await pages.history(target, { before: gap.oldestTimestamp, after: older.messages[10].orderKey, limit: 500 });
  assert.equal(fill.hasMore, false, 'the gap closes');
  assert.equal(fill.messages[0].orderKey > older.messages[10].orderKey, true);

  const reset = await pages.history(target, { after: latest.stableCursor, epoch: 'other' });
  assert.equal(reset.historyReset, true);
  assert.equal(reset.messages.at(-1).uuid, 'r101');
  assert.equal((await pages.history(target, { before: 'O2#000000099999#0000' })).historyReset, true, 'a cursor past the end');
});

test('a Codex turn in progress keeps the stable cursor before its prompt', async () => {
  const file = path.join(tmp, 'rollout-stable.jsonl');
  let i = 0;
  const line = (type, payload) => ({ timestamp: ts(i++), type, payload });
  const turn = (n, done) => [
    line('event_msg', { type: 'task_started', turn_id: `turn-${n}` }),
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `prompt ${n}` }] }),
    line('event_msg', { type: 'user_message', message: `prompt ${n}`, images: [] }),
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${n}` }] }),
    ...(done ? [line('event_msg', { type: 'task_complete', turn_id: `turn-${n}` })] : []),
  ];
  write(file, [line('session_meta', { id: 'n', cwd: '/tmp/p' }), ...turn(1, true), ...turn(2, false)]);
  const target = { file, runtime: 'codex', nativeSessionId: 'n' };
  const running = await pages.history(target, {});
  const prompt2 = running.messages.findIndex((row) => JSON.stringify(row.content).includes('prompt 2'));
  assert.equal(running.stableCursor, running.messages[prompt2 - 1].orderKey, 'the row before the open turn');
  fs.appendFileSync(file, JSON.stringify(line('event_msg', { type: 'task_complete', turn_id: 'turn-2' })) + '\n');
  const done = await pages.history(target, { after: running.stableCursor });
  assert.equal(done.stableCursor, done.messages.at(-1).orderKey, 'a finished turn is stable');
});

test('Sessions resolve to root, subagent and Codex child files; threads list root then subagents', async () => {
  const dir = path.join(tmp, 'projects', '-p');
  fs.mkdirSync(path.join(dir, 'root', 'subagents'), { recursive: true });
  const rootFile = path.join(dir, 'root.jsonl');
  write(rootFile, claudeRows(2));
  write(path.join(dir, 'root', 'subagents', 'agent-a1.jsonl'), claudeRows(1));
  const codexFile = path.join(tmp, 'rollout-child.jsonl');
  write(codexFile, [{ timestamp: ts(0), type: 'session_meta', payload: { id: 'kid', cwd: '/tmp/p' } }]);
  const rootRow = { sessionId: 'root', status: 'running', own: 'running', preview: 'Root', project: '-p', agentCount: 1,
    rec: { file: rootFile, runtime: 'claude', id: 'root', dir, ms: Date.parse(ts(5)), size: 10 }, children: [] };
  const index = {
    readyPromise: Promise.resolve(),
    snapshot: () => ({ catalog: { roots: [rootRow] } }),
    records: new Map([[codexFile, { file: codexFile, runtime: 'codex', id: 'kid' }]]),
    statuses: new Map([['codex:kid', 'needs_input']]),
    threadNames: new Map(),
  };
  const service = new HistoryService({ index, pages });
  const subId = (await service.threads({ sessionId: 'root' })).threads[1]?.sessionId;
  assert.deepEqual(service.resolve('root'), { file: rootFile, runtime: 'claude', nativeSessionId: 'root', status: 'running' });
  assert.equal(service.resolve(subId).file, path.join(dir, 'root', 'subagents', 'agent-a1.jsonl'));
  assert.deepEqual(service.resolve('codex:kid'), { file: codexFile, runtime: 'codex', nativeSessionId: 'kid', status: 'needs_input' });
  assert.equal(service.resolve('missing'), null);
  assert.equal(service.resolve('root:subagent:../../root'), null, 'a subagent id cannot leave the subagents directory');
  await assert.rejects(service.history({ sessionId: 'missing' }), /unknown_session/);
  const { rootSessionId, threads } = await service.threads({ sessionId: 'root' });
  assert.equal(rootSessionId, 'root');
  assert.deepEqual(threads.map((t) => [t.threadKind, t.canSend, t.parentSessionId]), [['main', true, undefined], ['subagent', false, 'root']]);
  const claudeReply = await service.history({ sessionId: 'root' });
  assert.equal(claudeReply.status, 'running');
  assert.equal(claudeReply.preview, undefined, 'Claude titles come as rows');
  rootRow.rec = { file: codexFile, runtime: 'codex', id: 'kid' };
  assert.equal((await service.history({ sessionId: 'root' })).preview, 'Root', 'other runtimes get the list title');
});

test('the default service reads pages in a worker', async () => {
  const file = path.join(tmp, 'worker.jsonl');
  write(file, claudeRows(3));
  const index = { readyPromise: Promise.resolve(), snapshot: () => ({ catalog: { roots: [
    { sessionId: 'w', status: 'completed', rec: { file, runtime: 'claude', id: 'w' } }] } }), records: new Map(), statuses: new Map() };
  const result = await new HistoryService({ index }).history({ sessionId: 'w' });
  assert.equal(result.messages.length, 9);
  assert.equal(result.status, 'completed');
});
