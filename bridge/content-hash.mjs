// Content ID shared with the app (web/js/components/content-hash.js): SHA-256 over the SHA-256 of each
// 4 MB block, first 32 hex digits. Hashes are remembered by path + size + mtime + ctime + inode, like Git's
// index (ctime catches copies that preserve mtime), so an unchanged file is never read again, also across restarts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BRIDGE_HOME } from './config.mjs';

const BLOCK = 4 * 1024 * 1024;
const MAX_ENTRIES = 1000;
// A file written within this window may change again without a new mtime (Git's "racy" case).
const RACY_MS = 2000;
let known = null;

export async function hashFile(file) {
  const outer = crypto.createHash('sha256');
  let block = crypto.createHash('sha256');
  let filled = 0;
  let blocks = 0;
  for await (let chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    while (chunk.length) {
      const take = Math.min(BLOCK - filled, chunk.length);
      block.update(chunk.subarray(0, take));
      filled += take;
      chunk = chunk.subarray(take);
      if (filled === BLOCK) {
        outer.update(block.digest());
        block = crypto.createHash('sha256');
        filled = 0;
        blocks++;
      }
    }
  }
  if (filled || !blocks) outer.update(block.digest());
  return outer.digest('hex').slice(0, 32);
}

export async function contentHash(file, stat, home = BRIDGE_HOME) {
  const store = path.join(home, 'file-hashes.json');
  known ??= new Map(Object.entries(await fs.promises.readFile(store, 'utf8').then(JSON.parse).catch(() => ({}))));
  const identity = s => [file, s.size, s.mtimeMs, s.ctimeMs, s.ino].join('\0');
  const id = identity(stat);
  if (known.has(id)) return known.get(id);
  const hash = await hashFile(file);
  const changed = identity(await fs.promises.stat(file)) !== id;
  if (changed || Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs) < RACY_MS) return hash;
  if (known.size >= MAX_ENTRIES) known.delete(known.keys().next().value);
  known.set(id, hash);
  const temporary = `${store}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, JSON.stringify(Object.fromEntries(known)))
    .then(() => fs.promises.rename(temporary, store)).catch(() => {});
  return hash;
}
