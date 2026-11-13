// One Baton-started process per session, ended when the session is Done (design §6.6): an optional
// close step, then EOF; only a process still alive 30 s later is killed with its whole tree.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { BRIDGE_HOME } from './config.mjs';
import { processStartTime } from './session.mjs';

const KILL_AFTER_MS = 30_000;
const LEDGER = path.join(BRIDGE_HOME, 'turn-processes.json');
const IS_WINDOWS = process.platform === 'win32';
const live = new Map(); // session key → { child, exited, finishing }
let ledger = null; // pid → start time

// Linux: field 22 of /proc/<pid>/stat; macOS: ps lstart. Null when the process is gone.
export function procStart(pid) {
  try {
    if (process.platform === 'linux') return processStartTime(pid);
    if (process.platform === 'darwin') return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim() || null;
  } catch {}
  return null;
}

function record(pid, start) {
  ledger ??= readLedger();
  if (start) ledger[pid] = start;
  else if (pid in ledger) delete ledger[pid];
  else return;
  try { fs.writeFileSync(LEDGER, JSON.stringify(ledger)); } catch {}
}

function readLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; }
}

function killTree(pid) {
  try {
    if (IS_WINDOWS) execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } // not a group leader
}

// Record a process spawned elsewhere so the next Bridge ends it if it outlives this one.
export function trackLeftover(child) {
  if (!child.pid) return;
  record(child.pid, procStart(child.pid));
  child.once('exit', () => record(child.pid, null));
}

// An npm `.cmd` shim runs `"%dp0%\<target>" %*`; run the target directly so the tree can be ended.
function unwrapShim(bin, args) {
  if (!IS_WINDOWS || !/\.cmd$/i.test(bin)) return [bin, args];
  const target = [...fs.readFileSync(bin, 'utf8').matchAll(/"%~?dp0%?\\([^"]+)"/g)].at(-1)?.[1];
  if (!target) return [bin, args];
  const file = path.join(path.dirname(bin), target);
  return /\.(?:c|m)?js$/i.test(file) ? [process.execPath, [file, ...args]] : [file, args];
}

// The session's live process, else a new one; a process that is finishing is awaited first.
export async function sessionProcess(key, bin, args, options = {}) {
  let entry = live.get(key);
  if (entry?.finishing) await entry.exited;
  entry = live.get(key);
  if (entry) return entry.child;
  const [command, argv] = unwrapShim(bin, args);
  const child = spawn(command, argv, { stdio: 'pipe', windowsHide: true, ...options, detached: !IS_WINDOWS });
  entry = { child, finishing: false };
  entry.exited = new Promise((resolve) => {
    const done = () => {
      if (live.get(key) === entry) live.delete(key);
      if (child.pid) record(child.pid, null);
      resolve();
    };
    child.once('exit', done);
    child.once('error', done);
  });
  live.set(key, entry);
  if (child.pid) record(child.pid, procStart(child.pid));
  return child;
}

// close() is the runtime's own goodbye (ACP session/close); errors there do not stop the exit.
export async function finishProcess(key, close) {
  const entry = live.get(key);
  if (!entry || entry.finishing) return entry?.exited;
  entry.finishing = true;
  const timer = setTimeout(() => killTree(entry.child.pid), KILL_AFTER_MS);
  try { await close?.(); } catch {}
  entry.child.stdin?.end();
  await entry.exited;
  clearTimeout(timer);
}

// After a Bridge restart: kill recorded processes whose pid and start time still match.
export function killLeftovers() {
  ledger = readLedger();
  for (const [pid, start] of Object.entries(ledger)) {
    if (procStart(pid) === start) killTree(Number(pid));
  }
  ledger = {};
  try { fs.rmSync(LEDGER, { force: true }); } catch {}
}
