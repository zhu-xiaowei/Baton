import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { finished } from 'stream/promises';
import { WS_FRAME_LIMIT } from '../config.mjs';
import { contentHash, forgetContentHash } from '../content-hash.mjs';
import { PUT_MAX, transfer, transferKeys } from '../transfer-store.mjs';
import { projectHashToPath } from '../session.mjs';
import { resolveProjectPath } from '../project-path.mjs';
import { sendTextFrames } from './ws-frames.mjs';

// Larger text previews stall phones; Download fetches the full file.
const FILE_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const INLINE_FRAME_LIMIT = Math.min(28_000, WS_FRAME_LIMIT - 3_000);
const TEXT_WS_MAX_BYTES = 300 * 1024;
const DIRECTORY_PAGE_LIMIT = 200;
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi',
]);
const uploadedFileKeys = transferKeys(1000);
const downloadFileKeys = transferKeys(100); // file identity → key

// Requests from Apps that cannot open sealed videos or large files carry no `files: 2`.
const OLD_APP = 'Update Baton to open this file';

async function prepareFileDownload(message, { projectRoot, store = transfer, fetchFn = fetch, send, home }) {
  const absPath = resolveReadablePath(projectRoot, message.path);
  const stat = await fs.promises.stat(absPath);
  if (!stat.isFile()) throw new Error('not a regular file');
  if (stat.size > PUT_MAX) throw new Error('File exceeds the 5 GB limit');
  if (message.files !== 2 && (stat.size > 50 * 1024 * 1024 || /^\.(mp4|m4v|mov|webm|mkv|avi|mp3|wav|m4a|ogg)$/i.test(path.extname(absPath)))) {
    throw new Error(OLD_APP);
  }
  const identity = `${absPath}\0${stat.mtimeMs}\0${stat.size}`;
  let stored = downloadFileKeys.get(identity);
  if (!stored) {
    sendProgress(message, send, { downloading: true });
    const hash = await contentHash(absPath, stat, home);
    const info = await store.prepareUpload({
      name: path.basename(absPath), size: stat.size, contentType: 'application/octet-stream', contentHash: hash,
    });
    if (!info.key || (!info.exists && (!info.url || !info.headers))) throw new Error('Invalid upload response');
    if (!info.exists) await putFile(absPath, stat, hash, info, fetchFn, home);
    const current = await fs.promises.stat(absPath);
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
      throw new Error('File changed while preparing the download. Try again.');
    }
    stored = { key: info.key, sealed: !!info.sealed, stored: info.stored ?? stat.size };
    downloadFileKeys.set(identity, stored);
  }
  send(responseBase(message, { ok: true, ...stored, path: absPath, name: path.basename(absPath), size: stat.size }));
}

// Streams the file (sealed as it is read) into one PUT. The key comes from the hash: bytes that
// changed since it was taken end the upload before its last record, so nothing is stored under it.
async function putFile(absPath, stat, hash, info, fetchFn, home) {
  let changed = false;
  let rejected = false;
  async function* checked(file) {
    const digest = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of file) { digest.update(chunk); if ((size += chunk.length) > stat.size) break; yield chunk; }
    if (size !== stat.size || digest.digest('hex') !== hash) { changed = true; throw new Error('File changed'); }
  }
  for (const url of [...new Set([info.url, info.fallbackUrl].filter(Boolean))]) {
    const file = fs.createReadStream(absPath);
    try {
      const response = await fetchFn(url, {
        method: 'PUT', headers: { ...info.headers, 'Content-Length': String(info.stored ?? stat.size) },
        body: info.sealStream ? info.sealStream(checked(file)) : file, duplex: 'half', signal: AbortSignal.timeout(3 * 3600_000),
      });
      // S3 refuses bytes that differ from the hashed content: the file changed, so another URL cannot help.
      if (response.status === 400) rejected = (await response.text()).includes('BadDigest');
      else await response.body?.cancel();
      if (response.ok) return;
    } catch {} finally { file.destroy(); await finished(file).catch(() => {}); } // an unread stream still opens
    if (rejected || changed) {
      await forgetContentHash(absPath, stat, home);
      throw new Error('File changed while preparing the download. Try again.');
    }
  }
  throw new Error('File upload failed. Try downloading again.');
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveReadablePath(root, requestedPath) {
  if (!requestedPath) throw new Error('path is required');
  if (path.isAbsolute(requestedPath)) return path.resolve(requestedPath);
  const resolvedRoot = fs.realpathSync(root);
  const target = path.resolve(resolvedRoot, requestedPath);
  if (!inside(resolvedRoot, target)) throw new Error('path is outside the project');
  const realTarget = fs.realpathSync(target);
  if (!inside(resolvedRoot, realTarget)) throw new Error('path is outside the project');
  return realTarget;
}

function entryType(directory, entry) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return 'file';
  try {
    return fs.statSync(path.join(directory, entry.name)).isDirectory()
      ? 'directory'
      : 'file';
  } catch {
    return 'file';
  }
}

function compareEntries(left, right) {
  if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function pageEntries(entries, cursor, envelope) {
  const start = Math.max(0, Number.parseInt(cursor || '0', 10) || 0);
  let end = Math.min(entries.length, start + DIRECTORY_PAGE_LIMIT);
  let page = entries.slice(start, end);
  while (page.length > 1
    && Buffer.byteLength(JSON.stringify({ ...envelope, entries: page })) > INLINE_FRAME_LIMIT) {
    end--;
    page = entries.slice(start, end);
  }
  return {
    entries: page,
    nextCursor: end < entries.length ? String(end) : '',
  };
}

export async function listProjectDirectory(directory, cursor = '', envelope = {}, directoriesOnly = false) {
  directory = await fs.promises.realpath(directory);
  if (!(await fs.promises.stat(directory)).isDirectory()) throw new Error('not a directory');
  const entries = (await fs.promises.readdir(directory, { withFileTypes: true }))
    .map((entry) => ({
      name: entry.name,
      type: entryType(directory, entry),
    }))
    .filter((entry) => !directoriesOnly || entry.type === 'directory')
    .sort(compareEntries);
  return pageEntries(entries, cursor, envelope);
}

async function browseDirectories(message, options) {
  const targetPath = resolveProjectPath(message.path, options.homeDir);
  let directory = targetPath;
  let exists = true;
  try {
    if (!(await fs.promises.stat(targetPath)).isDirectory()) throw new Error('Not a directory');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    directory = path.dirname(targetPath);
    exists = false;
  }
  const envelope = responseBase(message, {
    ok: true,
    path: directory,
    targetPath,
    parentPath: path.dirname(targetPath),
    exists,
  });
  const result = await listProjectDirectory(directory, message.cursor, envelope, true);
  options.send({
    ...envelope,
    entries: result.entries,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  });
}

function responseBase(message, extra = {}) {
  return {
    action: 'project_files',
    operation: message.operation,
    requestId: message.requestId,
    ...(message.replyConnectionId
      ? { replyConnectionId: message.replyConnectionId }
      : {}),
    ...extra,
  };
}

function sendProgress(message, send, extra) {
  send(responseBase(message, {
    ok: true,
    progress: true,
    ...extra,
  }));
}

async function readProjectFile(message, context) {
  const {
    send,
    store = transfer,
    projectRoot,
  } = context;
  const absPath = resolveReadablePath(projectRoot, message.path);
  const stat = await fs.promises.stat(absPath);
  if (stat.isDirectory()) throw new Error('is a directory');

  const extension = path.extname(absPath).toLowerCase();
  const base = responseBase(message, { ok: true });

  if (VIDEO_EXTENSIONS.has(extension)) {
    await prepareFileDownload(message, {
      ...context,
      send: response => send(response.progress ? { ...response, video: true } : { ...response, ...base, video: true }),
    });
    return;
  }

  const image = IMAGE_EXTENSIONS.has(extension);
  if (image && stat.size > IMAGE_MAX_BYTES) throw new Error('image too large');
  if (image) {
    await prepareFileDownload(message, {
      ...context,
      send: response => send(response.progress ? response : {
        ...response, ...base, image: true, attachment: true, truncated: false,
      }),
    });
    return;
  }
  const truncated = stat.size > FILE_MAX_BYTES;
  const cap = Math.min(stat.size, FILE_MAX_BYTES);
  const handle = await fs.promises.open(absPath, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  if (buffer.subarray(0, 8192).includes(0)) {
    throw new Error('binary file');
  }
  if (truncated) {
    const newline = buffer.lastIndexOf(0x0a);
    if (newline > 0) buffer = buffer.subarray(0, newline);
  }

  const contentVersion = crypto.createHash('sha256').update(buffer).digest('hex');
  const key = crypto.createHash('sha256')
    .update(`${absPath}\0${contentVersion}`)
    .digest('hex').slice(0, 16) + (/^\.[a-z0-9]{1,16}$/.test(extension) ? extension : '');
  const metadata = {
    ...base,
    key,
    path: absPath,
    size: stat.size,
    truncated,
    image: false,
    contentVersion,
  };
  if (stat.size <= TEXT_WS_MAX_BYTES) {
    sendTextFrames(metadata, buffer.toString('utf8'), send);
    return;
  }

  if (!uploadedFileKeys.get(key)) {
    await store.put(key, buffer, { contentType: 'text/plain; charset=utf-8' });
    uploadedFileKeys.set(key);
  }
  send(metadata);
}

function errorResponse(message, error) {
  const detail = error?.message || String(error);
  return responseBase(message, {
    ok: false,
    error: detail,
  });
}

export async function handleProjectFilesMessage(message, options = {}) {
  const send = options.send;
  if (typeof send !== 'function') throw new TypeError('send is required');
  const operation = message.operation;
  try {
    if (operation === 'browse') {
      await browseDirectories(message, options);
      return;
    }
    const resolveProjectRoot = options.resolveProjectRoot || projectHashToPath;
    const projectRoot = message.projectHash
      ? resolveProjectRoot(message.projectHash)
      : '';
    if (!projectRoot) throw new Error('project not found');
    if (operation === 'download') {
      await prepareFileDownload(message, { ...options, send, projectRoot });
      return;
    }
    // Relative paths start at the project folder; absolute paths may leave it.
    if (operation === 'list') {
      const root = await fs.promises.realpath(projectRoot);
      const envelope = responseBase(message, { ok: true, root, path: path.resolve(root, message.path || '.') });
      const result = await listProjectDirectory(envelope.path, message.cursor, envelope);
      send({
        ...envelope,
        entries: result.entries,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      });
      return;
    }
    if (operation === 'read') {
      await readProjectFile(message, {
        ...options,
        send,
        projectRoot,
      });
      return;
    }
    throw new Error('unsupported operation');
  } catch (error) {
    send(errorResponse(message, error));
  }
}

