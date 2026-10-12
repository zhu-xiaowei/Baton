// SHA-256 of a project file, which S3 verifies on upload (same as web/js/components/content-hash.js). Hashes are
// remembered by path + size + mtime + ctime + inode, like Git's index (ctime catches copies that preserve mtime),
// so an unchanged file is never read again, also across restarts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BRIDGE_HOME } from './config.mjs';

const MAX_ENTRIES = 1000;
// A file written within this window may change again without a new mtime (Git's "racy" case).
const RACY_MS = 2000;
let known = null;

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) hash.update(chunk);
  return hash.digest('hex');
}

const identity = (file, s) => [file, s.size, s.mtimeMs, s.ctimeMs, s.ino].join('\0');

async function save(store) {
  const temporary = `${store}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(Object.fromEntries(known)))
    .then(() => fs.promises.rename(temporary, store)).catch(() => {});
}

export async function contentHash(file, stat, home = BRIDGE_HOME) {
  const store = path.join(home, 'file-hashes.json');
  known ??= new Map(Object.entries(await fs.promises.readFile(store, 'utf8').then(JSON.parse).catch(() => ({}))));
  const id = identity(file, stat);
  if (known.has(id)) return known.get(id);
  const hash = await hashFile(file);
  const changed = identity(file, await fs.promises.stat(file)) !== id;
  if (changed || Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) < RACY_MS) return hash;
  if (known.size >= MAX_ENTRIES) known.delete(known.keys().next().value);
  known.set(id, hash);
  await save(store);
  return hash;
}

// After S3 rejected the bytes, never offer the same remembered hash again.
export async function forgetContentHash(file, stat, home = BRIDGE_HOME) {
  if (known?.delete(identity(file, stat))) await save(path.join(home, 'file-hashes.json'));
}
