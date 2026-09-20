import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_BYTES = 512 * 1024 * 1024;

export async function downloadAttachment(key, config, options = {}) {
  if (!/^[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/.test(key)) throw new Error('Invalid attachment key');
  const fetchFn = options.fetchFn || fetch;
  const metadata = await fetchFn(`${config.server}/api/bridge/file-url/${key}`, {
    headers: { 'x-api-key': config.apiKey }, signal: AbortSignal.timeout(30_000),
  });
  if (!metadata.ok) throw new Error('Attachment is unavailable. Upload it again.');
  const file = await metadata.json();
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES) {
    throw new Error('Invalid attachment size');
  }
  const directory = path.join(options.home || os.homedir(), '.baton-bridge', 'attachments');
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const localPath = path.join(directory, key);
  const existing = await fs.promises.lstat(localPath).catch(() => null);
  if (existing?.isFile() && existing.size === file.size) return localPath;
  const temporary = `${localPath}.${crypto.randomUUID()}.part`;
  try {
    const response = await fetchFn(file.url, { signal: AbortSignal.timeout(30 * 60_000) });
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

export async function resolveBridgeAttachments(text, config, options) {
  const pattern = /\[([^\]\r\n]*)\]\(baton-file:([0-9a-f]{32}(?:\.[a-z0-9]{1,16})?)\)/g;
  let resolved = text;
  const paths = new Map();
  for (const match of text.matchAll(pattern)) {
    if (!paths.has(match[2])) paths.set(match[2], await downloadAttachment(match[2], config, options));
    resolved = resolved.replace(match[0], () => `[${match[1]}](<${paths.get(match[2])}>)`);
  }
  return resolved;
}
