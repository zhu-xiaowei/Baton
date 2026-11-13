// Who holds each DSH session.lock (a flock; the file names no pid). Linux reads /proc/locks, macOS
// asks lsof. Reading /proc/locks can stall 30–130 ms, so answers use the last snapshot and a stale one
// is refreshed off the event loop; callers that must be exact await refreshLocks().
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const TTL_MS = 2000;
let snapshot = { at: 0, locks: new Map() };
let pending = null;

// /proc/locks names a file by "major:minor:inode" (hex device numbers).
function linuxKey(st) {
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `${hex((st.dev >> 8) & 0xfff)}:${hex((st.dev & 0xff) | ((st.dev >> 12) & 0xfff00))}:${st.ino}`;
}

async function read(sessionsDir) {
  const locks = new Map();
  if (process.platform === 'linux') {
    for (const line of (await fs.promises.readFile('/proc/locks', 'utf8')).split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f[1] === 'FLOCK' && f[3] === 'WRITE' && f[2] !== '->') locks.set(f[5], { pid: Number(f[4]) });
    }
  } else if (process.platform === 'darwin') {
    const files = [];
    for (const p of await fs.promises.readdir(sessionsDir).catch(() => [])) {
      for (const id of await fs.promises.readdir(path.join(sessionsDir, p)).catch(() => [])) files.push(path.join(sessionsDir, p, id, 'session.lock'));
    }
    const out = files.length ? await new Promise((resolve) => execFile('lsof', ['-F', 'pn', ...files], (_e, stdout) => resolve(stdout || ''))) : '';
    let pid = 0;
    for (const line of out.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      else if (line[0] === 'n') locks.set(line.slice(1), { pid });
    }
  }
  return locks;
}

export function refreshLocks(sessionsDir) {
  pending ||= read(sessionsDir).then((locks) => { snapshot = { at: Date.now(), locks }; }, () => {})
    .finally(() => { pending = null; });
  return pending;
}

export function lockHolders(sessionsDir) {
  if (Date.now() - snapshot.at > TTL_MS) void refreshLocks(sessionsDir);
  return snapshot.locks;
}

// The live holder of a session's lock: { pid } or null.
export function lockHolder(lockFile, locks = snapshot.locks) {
  if (process.platform !== 'linux') return locks.get(lockFile) || null;
  try { return locks.get(linuxKey(fs.statSync(lockFile))) || null; } catch { return null; }
}
