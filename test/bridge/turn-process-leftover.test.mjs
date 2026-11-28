import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

test('a tracked non-detached process left by a previous Bridge is killed on startup', { skip: process.platform === 'win32' }, async () => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-'));
  fs.mkdirSync(path.join(process.env.HOME, '.baton-bridge'));
  const { trackLeftover, killLeftovers } = await import('../../bridge/turn-process.mjs');
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  trackLeftover(child);
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)));
  killLeftovers();
  assert.equal(await exited, 'SIGKILL');
});
