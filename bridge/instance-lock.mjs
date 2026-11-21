import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';

const lockPort = (home) => 20000 + createHash('sha256').update(process.platform === 'win32' ? home.toLowerCase() : home).digest().readUInt32BE(0) % 20000;

// The running Bridge's pid, or 0: its pid file is trusted only while the lock port also answers.
export async function runningBridgePid(directory) {
  const pid = Number(fs.readFileSync(path.join(directory, 'bridge.pid'), 'utf8').trim() || 0);
  const held = await new Promise((resolve) => net.connect(lockPort(fs.realpathSync(directory)), '127.0.0.1')
    .once('connect', function () { this.destroy(); resolve(true); }).once('error', () => resolve(false)));
  return held ? pid : 0;
}

export async function acquireInstanceLock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const home = fs.realpathSync(directory);
  const pidFile = path.join(home, 'bridge.pid');
  const readPid = () => {
    try { return Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return 0; }
  };
  const ownerAlive = () => {
    const owner = readPid();
    if (!Number.isSafeInteger(owner) || owner <= 0 || owner === process.pid) return false;
    try { process.kill(owner, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  };
  if (ownerAlive()) return null;
  const port = lockPort(home);
  const server = net.createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE' && (ownerAlive() || readPid() === process.pid)) return null;
    throw error;
  }
  if (ownerAlive()) {
    server.close();
    return null;
  }
  try { fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 }); } catch (error) {
    server.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readPid() === process.pid) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
    server.close();
  };
}
