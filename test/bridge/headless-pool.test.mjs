import assert from 'node:assert/strict';
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
