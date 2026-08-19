import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  describeCodexWriter,
  restoreCodexTerminal,
  terminateCodexWriter,
} from '../../../bridge/codex-writer.mjs';

function codexHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-writer-'));
  fs.mkdirSync(path.join(home, 'thread-writer-locks'));
  fs.writeFileSync(path.join(home, 'thread-writer-locks', 'thread-1.lock'), '');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('writer adapter only marks standalone Codex TUI processes as terminable', (t) => {
  const home = codexHome(t);
  const tui = describeCodexWriter('thread-1', {
    codexHomes: [home],
    standaloneTuiHolder: () => ({
      pid: 123,
      info: {
        tty: 'ttys001',
        command: '/usr/local/bin/codex resume thread-1',
      },
    }),
    threadStatus: () => 'running',
  });
  assert.deepEqual(tui, {
    pid: 123,
    tty: 'ttys001',
    label: 'Codex terminal (ttys001)',
    canTerminate: true,
    status: 'running',
  });

  const daemon = describeCodexWriter('thread-1', {
    codexHomes: [home],
    lockHolderPid: () => 456,
    processInfo: () => ({
      tty: '??',
      command: '/usr/local/bin/codex app-server --stdio',
    }),
    threadStatus: () => {
      throw new Error('unsafe clients should not trigger a rollout scan');
    },
  });
  assert.equal(daemon.pid, 456);
  assert.equal(daemon.canTerminate, false);
  assert.equal(daemon.label, 'another Codex client');
  assert.equal(daemon.status, null);
});

test('writer termination revalidates the expected PID and idle state before SIGTERM', async (t) => {
  const home = codexHome(t);
  const events = [];
  const describe = () => ({
    pid: 123,
    tty: 'ttys001',
    label: 'Codex terminal (ttys001)',
    canTerminate: true,
    status: 'completed',
  });

  await terminateCodexWriter('thread-1', 123, {
    codexHomes: [home],
    describe,
    requireIdle: true,
    kill: (pid, signal) => events.push({ type: 'kill', pid, signal }),
    restoreTerminal: (tty) => events.push({ type: 'restore', tty }),
  });
  assert.deepEqual(events, [
    { type: 'kill', pid: 123, signal: 'SIGTERM' },
    { type: 'restore', tty: 'ttys001' },
  ]);

  await assert.rejects(
    terminateCodexWriter('thread-1', 999, { describe, kill: () => {} }),
    (error) => error.code === 'CODEX_WRITER_CHANGED',
  );

  await assert.rejects(
    terminateCodexWriter('thread-1', 123, {
      describe: () => ({ ...describe(), status: 'running' }),
      requireIdle: true,
      kill: () => {},
    }),
    (error) => error.code === 'CODEX_ACTIVE_WRITER',
  );
});

test('Codex terminal restoration writes the normal TUI cleanup sequence to its character device', () => {
  const writes = [];
  const restored = restoreCodexTerminal('ttys001', {
    platform: 'darwin',
    stat: (devicePath) => {
      assert.equal(devicePath, '/dev/ttys001');
      return { isCharacterDevice: () => true };
    },
    writeFile: (devicePath, content) => writes.push({ devicePath, content }),
  });

  assert.equal(restored, true);
  assert.deepEqual(writes, [{
    devicePath: '/dev/ttys001',
    content: '\x1b[<1u\x1b[<u\x1b[>4;0m\x1b[?2004l\x1b[?1004l\x1b[0 q\x1b[?25h',
  }]);
  assert.equal(restoreCodexTerminal('../tmp/not-a-tty', {
    platform: 'darwin',
    stat: () => {
      throw new Error('unsafe paths must not be inspected');
    },
  }), false);
});

test('writer revalidation targets the expected PID without repeating a full lock scan', (t) => {
  const home = codexHome(t);
  const calls = [];
  const writer = describeCodexWriter('thread-1', {
    codexHomes: [home],
    expectedPid: 123,
    pidHoldsLock: (lockPath, pid) => {
      calls.push({ lockPath, pid });
      return true;
    },
    lockHolderPid: () => {
      throw new Error('full lock scan should not run during revalidation');
    },
    processInfo: () => ({
      tty: 'ttys001',
      command: '/usr/local/bin/codex resume thread-1',
    }),
    threadStatus: () => 'completed',
  });

  assert.equal(writer.pid, 123);
  assert.equal(writer.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, 123);

  const changed = describeCodexWriter('thread-1', {
    codexHomes: [home],
    expectedPid: 123,
    pidHoldsLock: () => false,
    lockHolderPid: () => {
      throw new Error('full lock scan should not run during revalidation');
    },
  });
  assert.equal(changed.pid, null);
  assert.equal(changed.canTerminate, false);
});
