import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { plainSize, transfer } from './transfer-store.mjs';

const MAX_BYTES = 512 * 1024 * 1024;

export function attachmentPreviewText(text) {
  return text.replace(/\[([^\]\r\n]*)\]\((?:baton-file:([0-9a-f]{32}(?:\.[a-z0-9]{1,16})?)|<[^<>\r\n]*[\\/]\.baton-bridge[\\/]attachments[\\/]([0-9a-f]{32}(?:\.[a-z0-9]{1,16})?)>)\)/g,
    (reference, label) => {
      try { return decodeURIComponent(label); } catch { return reference; }
    });
}

export async function downloadAttachment(key, options = {}) {
  if (!/^[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/.test(key)) throw new Error('Invalid attachment key');
  const store = options.store || transfer;
  const fetchFn = options.fetchFn || fetch;
  const file = await store.head(key);
  if (!file) throw new Error('Attachment is unavailable. Upload it again.');
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES) {
    throw new Error('Invalid attachment size');
  }
  const directory = path.join(options.home || os.homedir(), '.baton-bridge', 'attachments');
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const localPath = path.join(directory, key);
  const existing = await fs.promises.lstat(localPath).catch(() => null);
  const { sealed } = file;
  if (!sealed && await store.plainRefused?.(key, file.size)) throw new Error('Attachment is not sealed. Upload it again.');
  if (existing?.isFile() && existing.size === (sealed ? plainSize(file.size) : file.size)) return localPath;
  const temporary = `${localPath}.${crypto.randomUUID()}.part`;
  try {
    if (sealed) {
      await fs.promises.writeFile(temporary, await store.bytes(key, true), { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporary, localPath);
      return localPath;
    }
    const response = await fetchFn(await store.url(key, { download: key }), { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) throw new Error('Failed to download attachment');
    let received = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        callback(received > file.size ? new Error('Attachment size mismatch') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limiter,
      fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (received !== file.size) throw new Error('Attachment download is incomplete');
    await fs.promises.rename(temporary, localPath);
    return localPath;
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

export async function resolveBridgeAttachments(text, options) {
  const pattern = /\[([^\]\r\n]*)\]\(baton-file:([0-9a-f]{32}(?:\.[a-z0-9]{1,16})?)\)/g;
  let resolved = text;
  const paths = new Map();
  for (const match of text.matchAll(pattern)) {
    if (!paths.has(match[2])) paths.set(match[2], await downloadAttachment(match[2], options));
    resolved = resolved.replace(match[0], () => `[${match[1]}](<${paths.get(match[2])}>)`);
  }
  return resolved;
}
