import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { finished } from 'stream/promises';
import { WS_FRAME_LIMIT } from '../config.mjs';
import { post } from '../http.mjs';
import { projectHashToPath } from '../session.mjs';
import { sendTextFrames } from './ws-frames.mjs';

const FILE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const INLINE_FRAME_LIMIT = Math.min(28_000, WS_FRAME_LIMIT - 3_000);
const TEXT_WS_MAX_BYTES = 300 * 1024;
const DIRECTORY_PAGE_LIMIT = 200;
const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif',
]);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi',
]);
const uploadedFileKeys = new Set();
const downloadFileKeys = new Map();

async function prepareFileDownload(message, { projectRoot, postFn = post, fetchFn = fetch, send }) {
  const absPath = resolveReadablePath(projectRoot, message.path);
  const stat = await fs.promises.stat(absPath);
  if (!stat.isFile()) throw new Error('not a regular file');
  if (stat.size > 512 * 1024 * 1024) throw new Error('Download exceeds the 512 MB limit');
  const identity = `${absPath}\0${stat.mtimeMs}\0${stat.size}`;
  let key = downloadFileKeys.get(identity);
  if (!key) {
    sendProgress(message, send, { downloading: true });
    const prepared = await postFn('/api/bridge/file-prepare', {
      name: path.basename(absPath), size: stat.size, contentType: 'application/octet-stream',
    });
    if (!prepared?.ok) throw new Error('Could not prepare file download');
    const info = await prepared.json();
    if (!info.key || !info.url || !info.headers) throw new Error('Invalid upload response');
    const urls = [...new Set([info.url, info.fallbackUrl].filter(Boolean))];
    let uploaded = false;
    for (const url of urls) {
      const body = fs.createReadStream(absPath);
      const closed = finished(body).catch(() => {});
      try {
        const response = await fetchFn(url, {
          method: 'PUT', headers: { ...info.headers, 'Content-Length': String(stat.size) },
          body, duplex: 'half', signal: AbortSignal.timeout(30 * 60_000),
        });
        await response.body?.cancel();
        if (response.ok) { uploaded = true; break; }
      } catch {} finally { body.destroy(); await closed; }
    }
    if (!uploaded) throw new Error('File upload failed. Try downloading again.');
    const current = await fs.promises.stat(absPath);
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) {
      throw new Error('File changed while preparing the download. Try again.');
    }
    key = info.key;
    if (downloadFileKeys.size >= 100) downloadFileKeys.delete(downloadFileKeys.keys().next().value);
    downloadFileKeys.set(identity, key);
  }
  send(responseBase(message, { ok: true, key, path: absPath, name: path.basename(absPath), size: stat.size }));
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedRelativePath(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '');
}

function resolveDirectory(root, relativePath) {
  if (path.isAbsolute(relativePath || '')) {
    throw new Error('absolute paths are not allowed');
  }
  const resolvedRoot = fs.realpathSync(root);
  const target = path.resolve(resolvedRoot, relativePath || '.');
  if (!inside(resolvedRoot, target)) throw new Error('path is outside the project');
  const realTarget = fs.realpathSync(target);
  if (!inside(resolvedRoot, realTarget)) throw new Error('path is outside the project');
  if (!fs.statSync(realTarget).isDirectory()) throw new Error('not a directory');
  return realTarget;
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

export async function listProjectDirectory(root, relativePath = '', cursor = '', envelope = {}) {
  const directory = resolveDirectory(root, relativePath);
  const entries = (await fs.promises.readdir(directory, { withFileTypes: true }))
    .map((entry) => ({
      name: entry.name,
      type: entryType(directory, entry),
    }))
    .sort(compareEntries);
  return pageEntries(entries, cursor, envelope);
}

async function uploadVideo(absPath, key, size, postFn) {
  const prep = await postFn('/api/bridge/video-prepare', { key });
  if (!prep || !prep.ok) return false;
  let info;
  try { info = await prep.json(); } catch { return false; }
  if (info.error) return false;
  if (info.exists) return true;
  if (!info.url) return false;
  try {
    const response = await fetch(info.url, {
      method: 'PUT',
      headers: {
        'Content-Type': info.contentType,
        'Content-Length': String(size),
      },
      body: fs.createReadStream(absPath),
      duplex: 'half',
    });
    return response.ok;
  } catch {
    return false;
  }
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

function legacyBase(message, extra = {}) {
  return {
    action: 'file_ready',
    requestId: message.requestId,
    sessionId: message.sessionId,
    ...extra,
  };
}

function sendProgress(message, send, extra) {
  if (message.legacy) {
    send({
      action: 'file_progress',
      requestId: message.requestId,
      sessionId: message.sessionId,
      ...extra,
    });
    return;
  }
  send(responseBase(message, {
    ok: true,
    progress: true,
    ...extra,
  }));
}

async function readProjectFile(message, context) {
  const {
    send,
    postFn = post,
    projectRoot,
  } = context;
  const absPath = resolveReadablePath(projectRoot, message.path);
  const stat = await fs.promises.stat(absPath);
  if (stat.isDirectory()) throw new Error('is a directory');

  const extension = path.extname(absPath).toLowerCase();
  const key = crypto.createHash('sha256')
    .update(`${absPath}#${stat.mtimeMs}#${stat.size}`)
    .digest('hex')
    .slice(0, 16) + extension;
  const base = message.legacy
    ? legacyBase(message)
    : responseBase(message, { ok: true });

  if (VIDEO_EXTENSIONS.has(extension)) {
    if (stat.size > VIDEO_MAX_BYTES) throw new Error('video too large');
    sendProgress(message, send, { video: true });
    const uploaded = await uploadVideo(absPath, key, stat.size, postFn);
    if (!uploaded) throw new Error('upload failed');
    send({
      ...base,
      key,
      path: absPath,
      size: stat.size,
      video: true,
    });
    return;
  }

  const image = IMAGE_EXTENSIONS.has(extension);
  if (image && stat.size > IMAGE_MAX_BYTES) throw new Error('image too large');
  const truncated = !image && stat.size > FILE_MAX_BYTES;
  const cap = image ? stat.size : Math.min(stat.size, FILE_MAX_BYTES);
  const handle = await fs.promises.open(absPath, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    buffer = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  if (!image && buffer.subarray(0, 8192).includes(0)) {
    throw new Error('binary file');
  }
  if (truncated) {
    const newline = buffer.lastIndexOf(0x0a);
    if (newline > 0) buffer = buffer.subarray(0, newline);
  }

  const metadata = {
    ...base,
    key,
    path: absPath,
    size: stat.size,
    truncated,
    image,
  };
  if (!image && !message.legacy && stat.size <= TEXT_WS_MAX_BYTES) {
    sendTextFrames(metadata, buffer.toString('utf8'), send);
    return;
  }
  if (!image && message.legacy) {
    const inline = { ...metadata, content: buffer.toString('utf8') };
    if (Buffer.byteLength(JSON.stringify(inline)) <= INLINE_FRAME_LIMIT) {
      send(inline);
      return;
    }
  }

  if (!uploadedFileKeys.has(key)) {
    const endpoint = image
      ? '/api/bridge/upload-image'
      : '/api/bridge/upload-file';
    const response = await postFn(endpoint, {
      key,
      data: buffer.toString('base64'),
    });
    if (!response || !response.ok) throw new Error('upload failed');
    uploadedFileKeys.add(key);
    if (uploadedFileKeys.size > 1000) {
      uploadedFileKeys.delete(uploadedFileKeys.values().next().value);
    }
  }
  send(metadata);
}

function errorResponse(message, error) {
  const detail = error?.message || String(error);
  if (message.legacy) {
    return legacyBase(message, {
      error: detail,
      path: message.path || '',
    });
  }
  return responseBase(message, {
    ok: false,
    error: detail,
  });
}

export async function handleProjectFilesMessage(message, options = {}) {
  const send = options.send;
  if (typeof send !== 'function') throw new TypeError('send is required');
  const operation = message.operation;
  const resolveProjectRoot = options.resolveProjectRoot || projectHashToPath;
  const projectRoot = message.projectHash
    ? resolveProjectRoot(message.projectHash)
    : '';
  try {
    if (!projectRoot) throw new Error('project not found');
    if (operation === 'download') {
      await prepareFileDownload(message, { ...options, send, projectRoot });
      return;
    }
    if (operation === 'list') {
      const envelope = responseBase(message, { ok: true });
      const result = await listProjectDirectory(
        projectRoot,
        normalizedRelativePath(message.path),
        message.cursor,
        envelope,
      );
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

export function handleLegacyFileRequest(message, options = {}) {
  return handleProjectFilesMessage({
    ...message,
    operation: 'read',
    legacy: true,
  }, options);
}
