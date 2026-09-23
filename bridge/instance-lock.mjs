import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';

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
  const identity = process.platform === 'win32' ? home.toLowerCase() : home;
  const port = 20000 + createHash('sha256').update(identity).digest().readUInt32BE(0) % 20000;
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
