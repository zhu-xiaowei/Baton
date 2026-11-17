// The web app's files as the Python server served them: Starlette's StaticFiles(html=True) and
// FileResponse (ETag, Last-Modified, 304, Range) with the cache headers of #191.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { response, text } from '../core/http.mjs';
import { HTTPError, floatRepr, pyStrip, randomHex } from '../core/py.mjs';

const TYPES = { html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', svg: 'image/svg+xml',
  txt: 'text/plain', json: 'application/json', png: 'image/png', ico: 'image/vnd.microsoft.icon', wasm: 'application/wasm',
  webmanifest: 'application/manifest+json', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
// Vite's hashed chunks never change; HTML must revalidate, or a stale cached index.html
// requests chunks the next deploy deleted. Other files keep the browser's default.
const HASHED = /^assets\/[^/]+-[\p{L}\p{N}_-]{8}\.(js|css)\n?$/u;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normpath(value) {
  const parts = [];
  for (const part of value.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/') || '.';
}

async function lookup(directory, relative) {
  if (relative.startsWith('/') || relative.startsWith('\\')) return null;
  const full = path.resolve(directory, relative);
  if (full !== directory && !full.startsWith(directory + path.sep)) return null;
  try {
    return [full, await fs.stat(full, { bigint: true })];
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new HTTPError(401, 'Unauthorized');
    if (error.code === 'ENAMETOOLONG' || error.code === 'ERR_INVALID_ARG_VALUE' || error.code === 'ERR_INVALID_ARG_TYPE') {
      throw new HTTPError(404, 'Not Found');
    }
    throw error;
  }
}

// email.utils.parsedate for HTTP dates; the zone is ignored, as there.
function parsedate(value) {
  const match = /^\s*(?:[A-Za-z]+,?\s*)?(\d{1,2})[\s-]+([A-Za-z]{3})[a-z]*[\s-]+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(value);
  const month = match && MONTHS.findIndex((name) => name.toLowerCase() === match[2].toLowerCase());
  if (!match || month < 0) return null;
  let year = Number(match[3]);
  if (match[3].length <= 2) year += year > 68 ? 1900 : 2000;
  return [year, month + 1, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
}
const later = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return true; };

const pyInt = (value) => (/^[+-]?\d+(?:_\d+)*$/.test(value) ? Number(value.replace(/_/g, '')) : NaN);

// FileResponse's Range handling: [] for a plain reply, or the ranges; throws a reply for a bad header.
function parseRanges(header, size) {
  const split = header.indexOf('=');
  if (split < 0) throw text('Malformed range header.', 400);
  if (pyStrip(header.slice(0, split)).toLowerCase() !== 'bytes') throw text('Only support bytes range', 400);
  const spec = header.slice(split + 1);
  if (spec.split(',').length > 100) return [];
  const ranges = [];
  for (let part of spec.split(',')) {
    part = pyStrip(part);
    if (!part || part === '-' || !part.includes('-')) continue;
    const dash = part.indexOf('-');
    const [first, last] = [pyStrip(part.slice(0, dash)), pyStrip(part.slice(dash + 1))];
    const start = first ? pyInt(first) : Math.max(size - pyInt(last), 0);
    const end = first && last && pyInt(last) < size ? pyInt(last) + 1 : size;
    if (Number.isNaN(start) || Number.isNaN(end) || (first && last && Number.isNaN(pyInt(last)))) continue;
    ranges.push([start, end]);
  }
  if (!ranges.length) throw text('Range header: range must be requested', 400);
  if (ranges.some(([start]) => !(start >= 0 && start < size))) throw text('', 416, { 'content-range': `bytes */${size}` });
  if (ranges.some(([start, end]) => start >= end)) throw text('Range header: start must be less than end', 400);
  if (ranges.length === 1) return ranges;
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [ranges[0]];
  for (const [start, end] of ranges.slice(1)) {
    const lastRange = merged.at(-1);
    if (start <= lastRange[1]) lastRange[1] = Math.max(lastRange[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

async function fileResponse(full, stat, context, status = 200, check = true) {
  const size = Number(stat.size);
  const mtime = Number(stat.mtimeNs / 1_000_000_000n) + Number(stat.mtimeNs % 1_000_000_000n) * 1e-9;
  const etagBase = new TextEncoder().encode(`${floatRepr(mtime)}-${size}`);
  const md5 = createHash('md5').update(etagBase).digest('hex');
  const type = TYPES[path.extname(full).slice(1)] ?? 'application/octet-stream';
  const headers = { 'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type, 'accept-ranges': 'bytes',
    'content-length': String(size), 'last-modified': new Date(Math.floor(mtime) * 1000).toUTCString(), etag: `"${md5}"` };
  const request = context.headers;
  if (check) {
    const match = request.get('if-none-match');
    if (match) {
      if (pyStrip(match) === '*' || match.split(',').map((tag) => pyStrip(tag).replace(/^W\//, '')).includes(headers.etag)) {
        return { status: 304, headers: { etag: headers.etag }, body: new Uint8Array() };
      }
    } else if (request.get('if-modified-since') !== null) {
      const since = parsedate(request.get('if-modified-since'));
      const modified = parsedate(headers['last-modified']);
      if (since && modified && later(since, modified)) return { status: 304, headers: { etag: headers.etag }, body: new Uint8Array() };
    }
  }
  return { status, headers, file: full, size };
}

// Reads the file once the cache headers are set; a Range reply replaces them, as FileResponse does.
async function send(reply, context) {
  if (!reply.file) return reply;
  const { file, size, ...rest } = reply;
  const head = context.method === 'HEAD';
  const range = context.headers.get('range');
  const ifRange = context.headers.get('if-range');
  const useRange = rest.status === 200 && range !== null
    && (ifRange === null || (!ifRange.startsWith('W/') && (ifRange === rest.headers['last-modified'] || ifRange === rest.headers.etag)));
  let ranges = [];
  if (useRange) {
    try {
      ranges = parseRanges(range, size);
    } catch (thrown) {
      if (thrown.body instanceof Uint8Array) return thrown;
      throw thrown;
    }
  }
  const bytes = head ? new Uint8Array() : new Uint8Array(await fs.readFile(file));
  if (ranges.length === 1) {
    const [[start, end]] = ranges;
    return { status: 206, headers: { ...rest.headers, 'content-range': `bytes ${start}-${end - 1}/${size}`, 'content-length': String(end - start) },
      body: bytes.subarray(start, end) };
  }
  if (ranges.length > 1) {
    const boundary = randomHex(13);
    const type = rest.headers['content-type'];
    const parts = [];
    for (const [start, end] of ranges) {
      parts.push(new TextEncoder().encode(`--${boundary}\r\nContent-Type: ${type}\r\nContent-Range: bytes ${start}-${end - 1}/${size}\r\n\r\n`),
        bytes.subarray(start, end), new TextEncoder().encode('\r\n'));
    }
    parts.push(new TextEncoder().encode(`--${boundary}--`));
    const length = ranges.reduce((sum, [start, end]) => sum + String(start).length + String(end - 1).length
      + 49 + boundary.length + type.length + String(size).length + end - start, 0) + 4 + boundary.length;
    return { status: 206, headers: { ...rest.headers, 'content-type': `multipart/byteranges; boundary=${boundary}`, 'content-length': String(length) },
      body: head ? new Uint8Array() : new Uint8Array(await new Blob(parts).arrayBuffer()) };
  }
  return { ...rest, body: bytes };
}

// os.path.normpath(os.path.join(*path.split("/")))
function routePath(value) {
  let joined = '';
  for (const part of value.split('/')) joined = !joined || joined.endsWith('/') ? joined + part : `${joined}/${part}`;
  return normpath(joined);
}

async function staticFile(context, directory, relative) {
  if (!['GET', 'HEAD'].includes(context.method)) throw new HTTPError(405, 'Method Not Allowed', { allow: 'GET, HEAD' });
  let found = await lookup(directory, relative);
  if (found && found[1].isFile()) return fileResponse(...found, context);
  if (found && found[1].isDirectory()) {
    const index = await lookup(directory, path.posix.join(relative, 'index.html'));
    if (index && index[1].isFile()) {
      if (!context.path.endsWith('/')) {
        const proto = context.scheme;
        const query = context.url.search;
        return response(307, '', null, { location: `${proto}://${context.headers.get('host') ?? ''}${context.path}/${query}` });
      }
      return fileResponse(...index, context);
    }
  }
  found = await lookup(directory, '404.html');
  if (found && found[1].isFile()) return fileResponse(...found, context, 404, false);
  throw new HTTPError(404, 'Not Found');
}

export function web(directory) {
  return async (context) => {
    const relative = routePath(context.path);
    const reply = await staticFile(context, directory, relative);
    if (HASHED.test(relative)) {
      if ([200, 304].includes(reply.status)) reply.headers['cache-control'] = 'public, max-age=31536000, immutable';
    } else if (relative === '.' || relative.endsWith('.html')) {
      reply.headers['cache-control'] = 'no-cache';
    }
    return send(reply, context);
  };
}
