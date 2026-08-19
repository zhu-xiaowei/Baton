import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { inspectCodexSession } from './codex-session.mjs';
import { findExecutable } from './platform.mjs';
import { resolveCodexHomes } from './runtime-capabilities.mjs';

const ACTIVE_WRITER_PATTERN = /already has an active writer/i;
const CODEX_TUI_TERMINAL_RESET = [
  '\x1b[<1u',
  '\x1b[<u',
  '\x1b[>4;0m',
  '\x1b[?2004l',
  '\x1b[?1004l',
  '\x1b[0 q',
  '\x1b[?25h',
].join('');

export function isCodexActiveWriterError(error) {
  return ACTIVE_WRITER_PATTERN.test(error?.message || '');
}

function lockPathForThread(threadId, homes = resolveCodexHomes()) {
  for (const home of homes) {
    const candidate = path.join(home, 'thread-writer-locks', `${threadId}.lock`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function procPidHoldsLock(lockPath, pid) {
  if (process.platform !== 'linux' || !pid) return false;
  let fds;
  try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { return false; }
  for (const fd of fds) {
    try {
      if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === lockPath) return true;
    } catch {}
  }
  return false;
}

function procHolder(lockPath) {
  if (process.platform !== 'linux') return null;
  let entries;
  try { entries = fs.readdirSync('/proc'); } catch { return null; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (procPidHoldsLock(lockPath, pid)) return pid;
  }
  return null;
}

function pidHoldsLock(lockPath, pid) {
  if (!lockPath || !pid || process.platform === 'win32') return false;
  const lsof = findExecutable('lsof', ['/usr/sbin/lsof', '/usr/bin/lsof']);
  if (!lsof) return procPidHoldsLock(lockPath, pid);
  try {
    const output = execFileSync(lsof, ['-a', '-p', String(pid), '-t', '--', lockPath], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split(/\r?\n/).some((line) => Number(line) === pid);
  } catch {
    return false;
  }
}

function lockHolderPid(lockPath) {
  if (!lockPath || process.platform === 'win32') return null;
  const lsof = findExecutable('lsof', ['/usr/sbin/lsof', '/usr/bin/lsof']);
  if (lsof) {
    try {
      const output = execFileSync(lsof, ['-t', '--', lockPath], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pid = Number(output.split(/\r?\n/).find(Boolean));
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
  }
  return procHolder(lockPath);
}

function processInfo(pid) {
  if (!pid || process.platform === 'win32') return null;
  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'tty=', '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!output) return null;
    const match = output.match(/^(\S+)\s+([\s\S]+)$/);
    if (!match) return null;
    return { tty: match[1], command: match[2].trim() };
  } catch {
    return null;
  }
}

function safeStandaloneTui(info) {
  if (!info?.command || !info.tty || /^\?+$/.test(info.tty)) return false;
  if (!/(?:^|[\\/])codex(?:[.\s-]|$)/i.test(info.command)) return false;
  return !/\b(?:app-server|remote-control|mcp-server|exec-server)\b/i.test(info.command);
}

export function restoreCodexTerminal(tty, options = {}) {
  if ((options.platform || process.platform) === 'win32' || typeof tty !== 'string') return false;
  const devicePath = path.resolve('/dev', tty);
  if (!devicePath.startsWith(`/dev${path.sep}`)) return false;
  try {
    const stat = (options.stat || fs.statSync)(devicePath);
    if (!stat.isCharacterDevice()) return false;
    (options.writeFile || fs.writeFileSync)(devicePath, CODEX_TUI_TERMINAL_RESET);
    return true;
  } catch {
    return false;
  }
}

function standaloneTuiHolder(lockPath) {
  if (!lockPath || process.platform === 'win32') return null;
  let output;
  try {
    output = execFileSync('ps', ['-axo', 'pid=', '-o', 'tty=', '-o', 'command='], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+([\s\S]+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const info = { tty: match[2], command: match[3].trim() };
    if (!safeStandaloneTui(info) || !pidHoldsLock(lockPath, pid)) continue;
    return { pid, info };
  }
  return null;
}

function threadStatus(threadId, options = {}) {
  try {
    const session = (options.inspectSession || inspectCodexSession)(threadId, {
      codexHomes: options.codexHomes,
      runningInfo: {
        projects: new Set(),
        sessions: new Set([threadId]),
      },
    });
    return session?.status || null;
  } catch {
    return null;
  }
}

export function describeCodexWriter(threadId, options = {}) {
  const lockPath = lockPathForThread(threadId, options.codexHomes);
  const expectedPid = Number(options.expectedPid);
  let pid = null;
  let info = null;
  if (Number.isInteger(expectedPid) && expectedPid > 0) {
    if ((options.pidHoldsLock || pidHoldsLock)(lockPath, expectedPid)) {
      pid = expectedPid;
      info = (options.processInfo || processInfo)(pid) || {};
    }
  } else {
    const fastHolder = options.lockHolderPid || options.processInfo
      ? null
      : (options.standaloneTuiHolder || standaloneTuiHolder)(lockPath);
    pid = fastHolder?.pid || (options.lockHolderPid || lockHolderPid)(lockPath);
    info = fastHolder?.info || null;
  }
  if (!pid) {
    return {
      pid: null,
      tty: '',
      label: 'another Codex process',
      canTerminate: false,
      status: null,
    };
  }
  if (!info) info = (options.processInfo || processInfo)(pid) || {};
  const canTerminate = safeStandaloneTui(info);
  const status = canTerminate
    ? (options.threadStatus || threadStatus)(threadId, options)
    : null;
  return {
    pid,
    tty: info.tty || '',
    label: canTerminate
      ? `Codex terminal${info.tty ? ` (${info.tty})` : ''}`
      : 'another Codex client',
    canTerminate,
    status,
  };
}

export async function terminateCodexWriter(threadId, expectedPid, options = {}) {
  const describe = options.describe || describeCodexWriter;
  const writer = describe(threadId, { ...options, expectedPid });
  if (!writer.pid || writer.pid !== expectedPid) {
    const error = new Error('The Codex writer changed before takeover');
    error.code = 'CODEX_WRITER_CHANGED';
    error.writer = writer;
    throw error;
  }
  if (!writer.canTerminate) {
    const error = new Error('The active Codex writer cannot be terminated safely');
    error.code = 'CODEX_WRITER_UNSAFE';
    error.writer = writer;
    throw error;
  }
  if (options.requireIdle && writer.status !== 'completed') {
    const error = new Error(writer.status === 'running'
      ? 'The Codex session is running locally'
      : 'Could not verify that the Codex session is idle');
    error.code = writer.status === 'running' ? 'CODEX_ACTIVE_WRITER' : 'CODEX_WRITER_UNSAFE';
    error.writer = writer;
    throw error;
  }
  (options.kill || process.kill)(writer.pid, 'SIGTERM');
  (options.restoreTerminal || restoreCodexTerminal)(writer.tty);
  return writer;
}

export const codexWriterController = {
  describe: describeCodexWriter,
  terminate: terminateCodexWriter,
};
