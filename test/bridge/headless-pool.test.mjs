import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ClaudePool } from '../../bridge/headless.mjs';

// Like Claude Code with a running background task: stays alive after stdin EOF.
const FAKE_CLAUDE = `#!/usr/bin/env node
let started = false;
process.stdin.on('data', () => {
  if (started) return;
  started = true;
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid' }) + '\\n');
});
setInterval(() => {}, 1000);
`;

test('a reaped process exiting late keeps the respawned process in the pool', async context => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-pool-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 });
  const pool = new ClaudePool({ bin, idleTtl: 0 });
  const live = [];
  context.after(() => {
    pool.shutdownAll();
    for (const proc of live) proc.proc.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await pool.send('sid', 'first', { resumeId: 'sid', cwd: dir });
  const reaped = pool.procs.get('sid');
  live.push(reaped);
  reaped.busy = false;
  reaped.lastActiveAt = 1;
  pool.reapIdle();
  assert.equal(pool.owns('sid'), false);

  await pool.send('sid', 'second', { resumeId: 'sid', cwd: dir });
  const current = pool.procs.get('sid');
  live.push(current);
  assert.notEqual(current, reaped);

  reaped.proc.kill('SIGTERM');
  await once(reaped.proc, 'close');
  assert.equal(pool.procs.get('sid'), current);
  assert.equal(pool.owns('sid'), true);
});
