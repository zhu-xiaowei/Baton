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
    out({ type: 'system', subtype: 'init', session_id: 'sid' });
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

test('a process with background tasks is not reaped until they end', async (t) => {
  const pool = new ClaudePool({ bin: fakeClaude(t), idleTtl: 60_000 });
  t.after(() => pool.shutdownAll());
  const proc = await turn(pool, 'sid', 'one');
  proc.lastActiveAt = 1;
  proc._onLine(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a1' }] }));
  proc.lastActiveAt = 1;
  pool.reapIdle();
  assert.equal(pool.procs.get('sid'), proc, 'a background agent keeps its process');
  // The turn CC starts when the task ends is measured from the end of the task.
  proc._onLine(JSON.stringify({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }));
  pool.reapIdle();
  assert.equal(pool.procs.get('sid'), proc);
  proc.lastActiveAt = 1;
  pool.reapIdle();
  assert.equal(pool.procs.has('sid'), false);
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
