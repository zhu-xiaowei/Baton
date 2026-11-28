// HTTP responses for a stored file, decrypted in the page, for <video>/<audio> and downloads
// (docs/media-streaming.md). Chromium ≥ 126 pauses a fetch the page stops reading, so it reads one
// GET per player request; elsewhere fetch keeps downloading into memory, so playback reads segments.
import { RECORD, transfer } from '../../../bridge/transfer-store.mjs';

const agent = globalThis.navigator?.userAgent || '';
const IOS = /iPhone|iPad|iPod/.test(agent) || (globalThis.navigator?.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const BACKPRESSURE = !IOS && Number(/Chrome\/(\d+)/.exec(agent)?.[1]) >= 126;
const SEGMENTS = [16, 64, 256]; // records: 1, 4, then 16 MiB per GET
const CACHE_BYTES = (IOS ? 48 : 32) * 1024 * 1024;
const RESIDENT = 16; // records kept at each end (probes, moov)
const STALL_MS = 2000;

const files = new Map(); // token → { file, download, refresh, cache }

// `file`: { key, name, size (plain), stored, sealed, previewType }. `refresh()` resolves the file
// again (the Bridge uploads it once more) when its stored copy is gone.
export function register(file, { download = false, refresh } = {}) {
  const token = crypto.randomUUID().replace(/-/g, '');
  files.set(token, { file, download, refresh, cache: new Map(), bytes: 0 });
  if (files.size > 8) files.delete(files.keys().next().value);
  return token;
}

export function releasePlayback() { for (const [token, entry] of files) if (!entry.download) files.delete(token); }

// No Range → 200 with the whole file; a single range → 206 with all of it, never shortened.
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match || (!match[1] && !match[2])) return { status: 200, start: 0, end: size };
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size, Number(match[2]) + 1) : size;
  return start < end ? { status: 206, start, end } : { status: 416, start: 0, end: 0 };
}

const reasons = { 200: 'OK', 206: 'Partial Content', 404: 'Not Found', 416: 'Range Not Satisfiable' };

// { status, reason, headers, body(signal) → async iterable of bytes | null }
export function respond(token, range, method = 'GET') {
  const entry = files.get(token);
  if (!entry) return { status: 404, reason: reasons[404], headers: { 'Content-Length': '0' }, body: null };
  const { file } = entry;
  const { status, start, end } = parseRange(range, file.size);
  const headers = { 'Content-Type': file.previewType || 'application/octet-stream', 'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store', 'Content-Length': String(end - start) };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end - 1}/${file.size}`;
  if (status === 416) headers['Content-Range'] = `bytes */${file.size}`;
  const body = method === 'HEAD' || status === 416 || start === end ? null : (signal) => read(entry, start, end, signal);
  return { status, reason: reasons[status], headers, body };
}

function cached(entry, index) {
  const bytes = entry.cache.get(index);
  if (bytes) { entry.cache.delete(index); entry.cache.set(index, bytes); }
  return bytes;
}

function keep(entry, index, bytes) {
  if (entry.download || entry.cache.has(index)) return;
  entry.cache.set(index, bytes);
  entry.bytes += bytes.length;
  const last = Math.ceil(entry.file.size / RECORD) - 1;
  for (const [old, value] of entry.cache) {
    if (entry.bytes <= CACHE_BYTES) break;
    if (old < RESIDENT || old > last - RESIDENT) continue;
    entry.cache.delete(old);
    entry.bytes -= value.length;
  }
}

async function* read(entry, start, end, signal) {
  const segments = BACKPRESSURE || entry.download ? [] : SEGMENTS;
  let source = null; // { records, at }
  let refreshed = false;
  let timer = 0;
  const close = () => { source?.records.return(); source = null; };
  try {
    for (let index = Math.floor(start / RECORD); index * RECORD < end; index++) {
      clearTimeout(timer);
      let bytes = source?.at === index ? null : cached(entry, index);
      while (!bytes) {
        const { file } = entry;
        if (source?.at !== index) {
          close();
          source = { records: transfer.records(file.key, file.stored, index, { sealed: file.sealed, segments, signal }), at: index };
        }
        try {
          const next = await source.records.next();
          if (next.done) throw new Error('File ended early');
          bytes = next.value;
          source.at++;
        } catch (error) {
          close();
          if (!error.missing || refreshed || !entry.refresh) throw error;
          refreshed = true;
          // Requests that miss together share one upload.
          entry.file = await (entry.refreshing ??= entry.refresh().then((next) => { entry.cache.clear(); entry.bytes = 0; return next; }));
        }
      }
      keep(entry, index, bytes);
      const from = Math.max(0, start - index * RECORD);
      const to = Math.min(bytes.length, end - index * RECORD);
      yield bytes.subarray(from, to);
      // A download that stops reading drops its GET (WebKit would keep filling memory) and resumes later.
      if (!BACKPRESSURE && entry.download) timer = setTimeout(close, STALL_MS);
    }
  } finally {
    clearTimeout(timer);
    close();
  }
}
