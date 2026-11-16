import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudePool } from '../../bridge/headless.mjs';
import { writerConflict, shouldCacheClientTurnAck } from '../../bridge/ws.mjs';

test('a process exiting after its session was respawned keeps the new process in the pool', async () => {
  const pool = new ClaudePool({ bin: '/nonexistent/claude', initTimeout: 1000 });
  const exited = pool.send('sid', 'hi', { resumeId: 'sid' });
  const respawned = { shutdown() {} };
  pool.procs.set('sid', respawned);
  await exited;
  assert.equal(pool.procs.get('sid'), respawned);
  pool.shutdownAll();
});

// Answers each turn like CC.
function fakeClaude(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
require('readline').createInterface({ input: process.stdin })
  .on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'control_request') return out({ type: 'control_response', response: { request_id: msg.request_id, subtype: 'success', response: { applied: { model: 'resolved-id' } } } });
    out({ type: 'system', subtype: 'init', session_id: 'sid' });
    if (msg.message.content[0].text.startsWith('/model')) return out({ type: 'result', subtype: 'success', local_command: 'model', user_message_uuids: [msg.uuid] });
    if (msg.message.content[0].text === 'bg') out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1' }] });
    out({ type: 'result', subtype: 'success', user_message_uuids: [msg.uuid] });
  })
  .on('close', () => process.exit(0));
`, { mode: 0o755 });
  return bin;
}

async function turn(pool, key, text) {
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  await pool.send(key, text, { resumeId: key, onResult: done });
  await finished;
  return pool.procs.get(key);
}
const emit = (proc, o) => proc._onLine(JSON.stringify(o));
const exited = (proc) => new Promise((resolve) => (proc.dead ? resolve() : proc.proc.once('close', resolve)));

test('a Done session exits; background tasks and prompts keep it until they end', async (t) => {
  const pool = new ClaudePool({ bin: fakeClaude(t) });
  t.after(() => pool.shutdownAll());
  const first = await turn(pool, 'sid', 'one');
  assert.equal(first, undefined, 'the result ended the process');
  const proc = await turn(pool, 'sid', 'bg');
  emit(proc, { type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Monitor' } });
  emit(proc, { type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  emit(proc, { type: 'result', subtype: 'success' }); // CC's report-back turn
  assert.equal(pool.procs.get('sid'), proc, 'a waiting prompt keeps its process');
  pool.replyControl('sid', 'r1', { behavior: 'allow', updatedInput: {} });
  assert.equal(pool.procs.get('sid'), proc, 'the turn that asked still has to finish');
  emit(proc, { type: 'result', subtype: 'success' });
  assert.equal(pool.procs.has('sid'), false);
  await exited(proc);
});

test('a prewarmed process takes the send, exits unused, and is replaced after another writer appends', async (t) => {
  const pool = new ClaudePool({ bin: fakeClaude(t), prewarmMs: 100 });
  t.after(() => pool.shutdownAll());
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prewarm-')), 'sid.jsonl');
  fs.writeFileSync(file, '{}\n');
  const warm = async (key) => (await pool.prewarm(key, { resumeId: key, file }), pool.procs.get(key));
  const used = await warm('sid');
  await turn(pool, 'sid', 'one');
  assert.equal(used.inputs.size, 1, 'the send used the prewarmed process');
  const unused = await warm('b');
  await exited(unused);
  assert.equal(pool.procs.has('b'), false, 'unused, it exits after the window');
  const stale = await warm('c');
  fs.appendFileSync(file, '{}\n');
  await turn(pool, 'c', 'two');
  assert.equal(stale.dead && stale.inputs.size, 0, 'a fresh process took the message');
});

test('the result of a turn CC started itself does not finish a waiting message', async (t) => {
  const pool = new ClaudePool({ bin: fakeClaude(t) });
  t.after(() => pool.shutdownAll());
  const proc = await turn(pool, 'sid', 'bg');
  const results = [];
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  await pool.send('sid', 'two', {
    resumeId: 'sid',
    onResult: (_sid, result) => { results.push(result); if (!result.continued) done(); },
  });
  // A background task's wake-up turn ends before CC reads the new message.
  proc._onLine(JSON.stringify({ type: 'result', subtype: 'success' }));
  assert.deepEqual(results.map((r) => [r.consumedInputIds.length, r.continued]), [[0, true]]);
  assert.equal(proc.busy, true);
  await finished;
  assert.deepEqual(results.map((r) => [r.consumedInputIds.length, r.continued]), [[0, true], [1, false]]);
});

test('a permission asked after the turn ended reaches the pool', async (t) => {
  const asked = [];
  const pool = new ClaudePool({ bin: fakeClaude(t), onControlRequest: (sid, req) => asked.push([sid, req.request_id]) });
  t.after(() => pool.shutdownAll());
  const proc = await turn(pool, 'sid', 'bg');
  // A background agent, or a turn CC started itself, asks with no pool turn bound.
  proc._onLine(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Monitor' } }));
  assert.deepEqual(asked, [['sid', 'r1']]);
});

test('a process dying with an unanswered prompt clears it', async (t) => {
  const exits = [];
  const pool = new ClaudePool({ bin: fakeClaude(t), onExit: (sid, hadPrompts) => exits.push([sid, hadPrompts]) });
  t.after(() => pool.shutdownAll());
  const next = await turn(pool, 'sid', 'bg');
  next._onLine(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Monitor' } }));
  const closed = new Promise((resolve) => next.proc.on('close', resolve));
  next.proc.kill();
  await closed;
  assert.deepEqual(exits, [['sid', true]], 'a process dying with a prompt clears it');
});
test('a held Claude session asks first, and takeover stops only the confirmed pid', async () => {
  let live = true; const deps = { findWriter: () => live && { pid: 42, canTerminate: true }, kill: (_, sig) => { if (sig) live = false; else if (!live) throw new Error('ESRCH'); } };
  assert.equal((await writerConflict('sid', false, null, deps)).errorCode, 'claude_active_writer');
  assert.equal((await writerConflict('sid', true, 41, deps)).errorCode, 'claude_writer_changed');
  assert.equal(shouldCacheClientTurnAck({ action: 'send_message_result', turnId: 't', errorCode: 'claude_writer_changed' }), false);
  assert.equal(await writerConflict('sid', true, 42, deps), null);
});

test('/model keeps the applied model for the next process; /model default drops the flag', async (t) => {
  const pool = new ClaudePool({ bin: fakeClaude(t) });
  t.after(() => pool.shutdownAll());
  const settle = async (proc) => { if (proc) await exited(proc); return pool.sessionArgs.get('sid')['--model']; };
  assert.equal(await settle(await turn(pool, 'sid', '/model haiku')), 'resolved-id');
  assert.equal(await settle(await turn(pool, 'sid', '/model default')), null);
});

test('takeover waits for the holder after stopping its client, and stops a holder that stays', async () => {
  for (const stays of [false, true]) {
    const live = new Set([42, 43]); const sent = []; let checks = 0;
    const kill = (pid, sig) => { if (sig) { sent.push(pid); live.delete(pid); } else if (!live.has(pid) || (pid === 43 && !stays && ++checks > 2 && !live.delete(43))) throw new Error('ESRCH'); };
    const deps = { kill, timeoutMs: 500, findWriter: () => live.size && { pid: live.has(42) ? 42 : 43, holderPid: 43 } };
    assert.equal(await writerConflict('sid', true, 42, deps), null);
    assert.deepEqual(sent, stays ? [42, 43] : [42]);
  }
});
