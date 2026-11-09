import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractClaudeMessages } from '../../bridge/extract.mjs';
import { extractCodexMessages } from '../../bridge/codex-extract.mjs';
import { ClaudeHistoryReader } from '../../bridge/history/claude-reader.mjs';
import { CodexHistoryReader } from '../../bridge/history/codex-reader.mjs';

const TITLES = new Set(['ai-title', 'custom-title', 'last-prompt']);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'history-readers-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const json = (rows) => rows.map((row) => JSON.stringify(row));

function claudeTranscript(turns) {
  const lines = [{ type: 'queue-operation', operation: 'enqueue' }];
  let parent = null;
  const push = (row) => { lines.push(row); parent = row.uuid || parent; };
  for (let t = 0; t < turns; t++) {
    const ts = new Date(Date.UTC(2026, 10, 1, 0, 0, t)).toISOString();
    push({ type: 'user', uuid: `u${t}`, parentUuid: parent, timestamp: ts, message: { role: 'user', content: `prompt ${t}` } });
    lines.push({ type: 'api-request-blob', payload: 'x'.repeat(2000) });
    push({ type: 'assistant', uuid: `a${t}`, parentUuid: parent, timestamp: ts,
      message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'thinking' }, { type: 'tool_use', id: `t${t}`, name: 'Bash', input: { command: `echo ${t}`, description: 'Echo' } }] } });
    push({ type: 'user', uuid: `r${t}`, parentUuid: parent, timestamp: ts,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${t}`, content: 'y'.repeat(800) }] } });
    if (t % 7 === 3) { // a meta prompt hides the prompt answering it
      push({ type: 'user', uuid: `m${t}`, parentUuid: parent, isMeta: true, timestamp: ts, message: { role: 'user', content: 'meta' } });
      push({ type: 'user', uuid: `h${t}`, parentUuid: `m${t}`, timestamp: ts, message: { role: 'user', content: 'hidden' } });
    }
    if (t % 11 === 5) {
      lines.push({ type: 'ai-title', aiTitle: `title ${t}`, sessionId: 's' });
      push({ type: 'user', uuid: `c${t}`, parentUuid: parent, isCompactSummary: true, timestamp: ts, message: { role: 'user', content: `summary ${t}` } });
      lines.push({ type: 'attachment', uuid: `q${t}`, parentUuid: `a${t}`, timestamp: ts, attachment: { type: 'queued_command', source_uuid: `qs${t}`, prompt: `queued ${t}` } });
      lines.push({ type: 'system', subtype: 'local_command', uuid: `l${t}`, timestamp: ts, content: '<local-command-stdout>done</local-command-stdout>' });
    }
    push({ type: 'assistant', uuid: `e${t}`, parentUuid: parent, timestamp: ts, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `answer ${t}` }] } });
  }
  return json(lines);
}

function codexRollout(turns) {
  let second = 0;
  const ts = () => new Date(Date.UTC(2026, 10, 1, 0, 0, second++)).toISOString();
  const line = (type, payload) => ({ timestamp: ts(), type, payload });
  const lines = [line('session_meta', { id: 'native-1', cwd: '/tmp/p', originator: 'codex-tui', cli_version: '1', model_provider: 'openai' })];
  const background = [];
  for (let t = 0; t < turns; t++) {
    const turn = `turn-${t}`;
    lines.push(line('event_msg', { type: 'task_started', turn_id: turn }));
    lines.push(line('turn_context', { model: 'gpt', turn_id: turn }));
    lines.push(line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `prompt ${t % 4}` }] }));
    lines.push(line('event_msg', { type: 'user_message', message: `prompt ${t % 4}`, images: [] }));
    lines.push(line('response_item', { type: 'reasoning', summary: [], encrypted_content: 'z'.repeat(500) }));
    for (let c = 0; c < 3; c++) {
      const id = `call_${t}_${c}`;
      const bg = c === 2 && (t % 5 === 1 || t % 5 === 3);
      lines.push(line('response_item', { type: 'function_call', name: 'exec_command', call_id: id, arguments: JSON.stringify({ cmd: `ls ${t} ${c}` }) }));
      lines.push(line('response_item', { type: 'function_call_output', call_id: id,
        output: bg ? `Chunk ID: 1\nProcess running with session ID ${9000 + t}\nOutput:\n` : `Process exited with code 0\nOutput:\n${'o'.repeat(600)}` }));
      if (bg) background.push({ id, process: 9000 + t, done: t + (t % 5 === 1 ? 3 : 2), completes: t % 5 === 1 });
      else lines.push(line('event_msg', { type: 'item_completed', turn_id: turn, item: { type: 'CommandExecution', id, command: `ls ${t} ${c}`, exit_code: 0, status: 'completed', aggregated_output: 'o'.repeat(600), parsed_cmd: [{ type: 'list_files', cmd: 'ls', path: '.' }], source: 'agent' } }));
      lines.push(line('event_msg', { type: 'token_count', info: null }));
    }
    // Waits on background terminals turns later; some processes never finish, so only the process id links them.
    for (const job of background.filter((b) => b.done === t)) {
      const wait = `call_wait_${job.process}`;
      lines.push(line('response_item', { type: 'function_call', name: 'write_stdin', call_id: wait, arguments: JSON.stringify({ session_id: job.process, chars: '' }) }));
      lines.push(line('response_item', { type: 'function_call_output', call_id: wait,
        output: job.completes ? 'Process exited with code 0\nOutput:\nready' : `Process running with session ID ${job.process}\nOutput:\n` }));
      if (job.completes) lines.push(line('event_msg', { type: 'item_completed', turn_id: turn, item: { type: 'CommandExecution', id: job.id, command: 'npm run dev', exit_code: 0, status: 'completed', aggregated_output: 'ready', parsed_cmd: [{ type: 'unknown', cmd: 'npm run dev' }], source: 'agent' } }));
    }
    if (t % 3 === 2) { // a mid-turn prompt whose two copies sit a few lines apart
      lines.push(line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] }));
      lines.push(line('event_msg', { type: 'token_count', info: null }));
      lines.push(line('event_msg', { type: 'user_message', message: 'continue', images: [] }));
    }
    if (t % 9 === 4) lines.push({ timestamp: ts(), type: 'compacted', payload: { message: '', replacement_history: [{ type: 'function_call', call_id: `call_${t - 1}_0` }] } });
    lines.push(line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `answer ${t}` }] }));
    if (t < turns - 1) lines.push(line('event_msg', { type: 'task_complete', turn_id: turn }));
  }
  return json(lines);
}

const fullClaude = async (file) => (await extractClaudeMessages(file, 's', { watermarks: new Map() })).messages
  .filter((row) => !TITLES.has(row.type));
const fullCodex = (file) => extractCodexMessages(file, 'native-1').messages;

// Pages back from the newest one until the start; every page must equal the full extraction's slice.
async function assertEveryPage(reader, full, limit) {
  const want = full.map((row) => JSON.stringify(row));
  let page = await reader.latest(limit);
  let end = full.length;
  assert.deepEqual(page.map((row) => JSON.stringify(row)), want.slice(Math.max(0, end - limit)), 'latest page');
  let pages = 1;
  while (end - page.length > 0) {
    end -= page.length;
    page = await reader.before(full[end].orderKey, limit);
    assert.deepEqual(page.map((row) => JSON.stringify(row)), want.slice(Math.max(0, end - limit), end), `page ending at ${end}`);
    pages++;
  }
  const after = await reader.after(full[full.length - 6].orderKey);
  assert.deepEqual(after.map((row) => JSON.stringify(row)), want.slice(-5), 'after');
  return pages;
}

test('Claude pages match the full extraction, skipping titles, meta answers and non-message lines', async () => {
  const file = path.join(tmp, 'claude.jsonl');
  fs.writeFileSync(file, claudeTranscript(120).join('\n') + '\n');
  const full = await fullClaude(file);
  const reader = new ClaudeHistoryReader(file);
  reader.update();
  assert.ok(await assertEveryPage(reader, full, 37) > 5);
  assert.equal(reader.stableLine(), Infinity);
  const ids = new Set(full.map((row) => row.uuid));
  assert.ok(!ids.has('m3') && !ids.has('h3'), 'a meta prompt and the prompt it hides are not rows');
  assert.equal(full.find((row) => row.uuid === 'c5').type, 'summary', 'a compaction summary is a summary row');
  assert.ok(ids.has('qs5') && ids.has('l5'), 'queued commands and local command output stay');
});

test('Codex pages match the full extraction across turns, background processes and compactions', async () => {
  const file = path.join(tmp, 'rollout-codex.jsonl');
  fs.writeFileSync(file, codexRollout(60).join('\n') + '\n');
  const full = fullCodex(file);
  const reader = new CodexHistoryReader(file, 'native-1');
  reader.update();
  for (const limit of [7, 40, 200]) assert.ok(await assertEveryPage(reader, full, limit) >= 1);
  assert.notEqual(reader.stableLine(), Infinity, 'the last turn has not completed');
});

// Every window start: a boundary between two lines that belong together is where a missing rule shows.
async function assertEveryWindow(reader, full, sizes) {
  const byLine = new Map();
  for (const row of full) {
    const line = Number(row.orderKey.split('#')[1]);
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(JSON.stringify(row));
  }
  const count = reader.index.count;
  for (const size of sizes) {
    for (let lo = 0; lo < count; lo++) {
      const hi = Math.min(count, lo + size);
      const want = [];
      for (let line = lo; line < hi; line++) want.push(...(byLine.get(line) || []));
      assert.deepEqual((await reader.rows(lo, hi)).map((row) => JSON.stringify(row)), want, `window [${lo}, ${hi})`);
    }
  }
}

test('every window of both readers matches the full extraction', async () => {
  const claude = path.join(tmp, 'claude-windows.jsonl');
  fs.writeFileSync(claude, claudeTranscript(40).join('\n') + '\n');
  const claudeReader = new ClaudeHistoryReader(claude);
  claudeReader.update();
  await assertEveryWindow(claudeReader, await fullClaude(claude), [1, 2, 5]);
  const codex = path.join(tmp, 'rollout-windows.jsonl');
  fs.writeFileSync(codex, codexRollout(30).join('\n') + '\n');
  const codexReader = new CodexHistoryReader(codex, 'native-1');
  codexReader.update();
  // Skipping compactions as dependencies only saves reads; results are the same either way.
  await assertEveryWindow(codexReader, fullCodex(codex), [1, 3, 9]);
});

test('the Codex extractor visits only the given lines and returns the same rows for all of them', () => {
  const file = path.join(tmp, 'rollout-order.jsonl');
  const lines = codexRollout(8);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const order = lines.map((_, i) => i);
  assert.deepEqual(extractCodexMessages(file, 'native-1', { lines, order }).messages, fullCodex(file));
});

test('appends, an unterminated last line, and a replaced file keep the index consistent', async () => {
  for (const [name, make, Reader, full] of [
    ['claude-grow.jsonl', claudeTranscript, ClaudeHistoryReader, fullClaude],
    ['rollout-grow.jsonl', codexRollout, CodexHistoryReader, fullCodex],
  ]) {
    const file = path.join(tmp, name);
    const data = Buffer.from(make(40).join('\n') + '\n');
    const reader = new Reader(file, 'native-1');
    let written = 0;
    fs.writeFileSync(file, '');
    for (const cut of [0.3, 0.3001, 0.55, 0.8, 1].map((p) => Math.floor(data.length * p))) {
      fs.appendFileSync(file, data.subarray(written, cut)); // cuts land mid-line
      written = cut;
      reader.update();
      const want = (await full(file)).map((row) => JSON.stringify(row));
      assert.deepEqual((await reader.latest(500)).map((row) => JSON.stringify(row)), want.slice(-500), `${name} at ${cut}`);
    }
    const epoch = reader.epoch;
    fs.rmSync(file);
    fs.writeFileSync(file, make(5).join('\n') + '\n');
    reader.update();
    assert.notEqual(reader.epoch, epoch, `${name}: a replaced file has a new epoch`);
    assert.deepEqual((await reader.latest(500)).map((row) => JSON.stringify(row)), (await full(file)).map((row) => JSON.stringify(row)));
  }
});
