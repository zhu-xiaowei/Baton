import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  describeCodexWriter,
  terminateCodexWriter,
} from '../../../bridge/codex-writer.mjs';

function codexHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentpeek-writer-'));
  fs.mkdirSync(path.join(home, 'thread-writer-locks'));
  fs.writeFileSync(path.join(home, 'thread-writer-locks', 'thread-1.lock'), '');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('writer adapter only marks standalone Codex TUI processes as terminable', (t) => {
  const home = codexHome(t);
  const tui = describeCodexWriter('thread-1', {
    codexHomes: [home],
    lockHolderPid: () => 123,
    processInfo: () => ({
      tty: 'ttys001',
      command: '/usr/local/bin/codex resume thread-1',
    }),
  });
  assert.deepEqual(tui, {
    pid: 123,
    tty: 'ttys001',
    label: 'Codex terminal (ttys001)',
    canTerminate: true,
  });

  const daemon = describeCodexWriter('thread-1', {
    codexHomes: [home],
    lockHolderPid: () => 456,
    processInfo: () => ({
      tty: '??',
      command: '/usr/local/bin/codex app-server --stdio',
    }),
  });
  assert.equal(daemon.pid, 456);
  assert.equal(daemon.canTerminate, false);
  assert.equal(daemon.label, 'another Codex client');
});

test('writer termination revalidates the expected PID before SIGTERM', async (t) => {
  const home = codexHome(t);
  const killed = [];
  const describe = () => ({
    pid: 123,
    tty: 'ttys001',
    label: 'Codex terminal (ttys001)',
    canTerminate: true,
  });

  await terminateCodexWriter('thread-1', 123, {
    codexHomes: [home],
    describe,
    kill: (pid, signal) => killed.push({ pid, signal }),
  });
  assert.deepEqual(killed, [{ pid: 123, signal: 'SIGTERM' }]);

  await assert.rejects(
    terminateCodexWriter('thread-1', 999, { describe, kill: () => {} }),
    (error) => error.code === 'CODEX_WRITER_CHANGED',
  );
});
