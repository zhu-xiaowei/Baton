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
  // The GET's own headers give the size and sealed mark, so no HEAD comes first.
  const response = await fetchFn(await store.url(key, { plain: true }), { signal: AbortSignal.timeout(30 * 60_000) });
  if (response.status === 404 || response.status === 403) throw new Error('Attachment is unavailable. Upload it again.');
  if (!response.ok || !response.body) throw new Error('Failed to download attachment');
  const stored = Number(response.headers.get('content-length'));
  const sealed = response.headers.get('x-amz-meta-sealed') === '1';
  const size = sealed ? plainSize(stored) : stored;
  try {
    if (!Number.isSafeInteger(stored) || stored < 0 || size > MAX_BYTES) throw new Error('Invalid attachment size');
    if (!sealed && await store.plainRefused?.()) throw new Error('Attachment is not sealed. Update Baton on the sending device and send it again.');
    const directory = path.join(options.home || os.homedir(), '.baton-bridge', 'attachments');
    const localPath = path.join(directory, key);
    await fs.promises.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    const existing = await fs.promises.lstat(localPath).catch(() => null);
    if (existing?.isFile() && existing.size === size) return localPath;
    const temporary = `${localPath}.${crypto.randomUUID()}.part`;
    try {
      let received = 0;
      const counted = new Transform({
        transform(chunk, encoding, callback) { received += chunk.length; callback(null, chunk); },
      });
      await pipeline(sealed ? Readable.from(store.openBody(key, stored, response.body)) : Readable.fromWeb(response.body),
        counted, fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      if (received !== size) throw new Error('Attachment download is incomplete');
      await fs.promises.rename(temporary, localPath);
      return localPath;
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  } finally {
    response.body.cancel().catch(() => {});
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
