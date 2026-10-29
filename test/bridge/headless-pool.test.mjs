import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudePool } from '../../bridge/headless.mjs';

test('a process exiting after its session was respawned keeps the new process in the pool', async () => {
  const pool = new ClaudePool({ bin: '/nonexistent/claude', initTimeout: 1000 });
  const exited = pool.send('sid', 'hi', { resumeId: 'sid' });
  const respawned = { shutdown() {} };
  pool.procs.set('sid', respawned);
  await exited;
  assert.equal(pool.procs.get('sid'), respawned);
  pool.shutdownAll();
});

// Answers each turn like CC; FAKE_LINGER keeps it alive after EOF.
function fakeClaude(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!${process.execPath}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
require('readline').createInterface({ input: process.stdin })
  .on('line', (line) => {
    const msg = JSON.parse(line);
    out({ type: 'system', subtype: 'init', session_id: 'sid' });
    out({ type: 'result', subtype: 'success', user_message_uuids: [msg.uuid] });
  })
  .on('close', () => { if (!process.env.FAKE_LINGER) process.exit(0); setInterval(() => {}, 1000); });
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

test('reaping waits for background work and the replacement starts after the old process exits', async (t) => {
  const pool = new ClaudePool({ bin: fakeClaude(t), idleTtl: 0 });
  t.after(() => pool.shutdownAll());
  const first = await turn(pool, 'sid', 'one');

  first._onLine(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1' }] }));
  pool.reapIdle();
  assert.equal(first.closing, false, 'a background agent keeps its process');
  first._onLine(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }));
  // CC wakes itself when the task ends; that turn is not a pool turn.
  first._onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }));
  pool.reapIdle();
  assert.equal(first.closing, false, 'a self-started turn keeps its process');
  first._onLine(JSON.stringify({ type: 'result', subtype: 'success' }));

  pool.reapIdle();
  assert.equal(first.closing, true);
  assert.equal(pool.procs.get('sid'), first, 'a closing process stays tracked until it exits');
  const second = await turn(pool, 'sid', 'two');
  assert.equal(first.dead, true);
  assert.notEqual(second.proc.pid, first.proc.pid, 'the next message starts a fresh process');
});

test('the result of a turn CC started itself does not finish a waiting message', async (t) => {
  const pool = new ClaudePool({ bin: fakeClaude(t) });
  t.after(() => pool.shutdownAll());
  const proc = await turn(pool, 'sid', 'one');
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

test('a process that ignores EOF is terminated after the grace period',async (t) => {
  const pool = new ClaudePool({ bin: fakeClaude(t), env: { FAKE_LINGER: '1' }, exitGrace: 50 });
  t.after(() => pool.shutdownAll());
  const proc = await turn(pool, 'sid', 'one');
  proc.shutdown();
  await proc.closed;
  assert.equal(proc.proc.signalCode, 'SIGTERM');
  assert.equal(pool.procs.has('sid'), false);
});
