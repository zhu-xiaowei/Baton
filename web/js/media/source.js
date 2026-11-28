// HTTP responses for a stored file, decrypted in the page, for <video>/<audio> and downloads
// (docs/media-streaming.md). Chromium ≥ 126 pauses a fetch the page stops reading, so it reads one
// GET per player request; elsewhere fetch keeps downloading into memory, so playback reads 16 MiB
// blocks, two ahead, starting with smaller pieces in parallel after an open or a seek. Records are
// fetched once per file whichever request wants them; whole decrypted blocks are kept on the device.
import { RECORD, transfer } from '../../../bridge/transfer-store.mjs';

const agent = globalThis.navigator?.userAgent || '';
const IOS = /iPhone|iPad|iPod/.test(agent) || (globalThis.navigator?.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const BACKPRESSURE = !IOS && Number(/Chrome\/(\d+)/.exec(agent)?.[1]) >= 126;
const BLOCK = 256; // records: 16 MiB
const START = [16, 64, 64, 128]; // records: 1, 4, 4, 8 MiB at once after an open or a seek
const AHEAD = 2; // blocks
const CACHE_BYTES = (IOS ? 96 : 128) * 1024 * 1024;
const RESIDENT = 16; // records kept at each end (probes, moov)
const STALL_MS = 2000;
const disk = () => import('../components/attachment-cache.js');

const files = new Map(); // token → entry

// `file`: { key, name, size (plain), stored, sealed, previewType }. `refresh()` resolves the file
// again (the Bridge uploads it once more) when its stored copy is gone.
export function register(file, { download = false, refresh } = {}) {
  const token = crypto.randomUUID().replace(/-/g, '');
  files.set(token, { file, download, refresh, cache: new Map(), bytes: 0, waits: new Map(), pending: new Set(), loaded: new Set(), saved: new Set() });
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
  const body = method === 'HEAD' || status === 416 || start === end ? null
    : (signal) => (BACKPRESSURE || entry.download ? stream : blocks)(entry, start, end, signal);
  return { status, reason: reasons[status], headers, body };
}

const total = (entry) => Math.max(1, Math.ceil(entry.file.size / RECORD));

function cached(entry, index) {
  const bytes = entry.cache.get(index);
  if (bytes) { entry.cache.delete(index); entry.cache.set(index, bytes); }
  return bytes;
}

function keep(entry, index, bytes) {
  entry.waits.get(index)?.resolve(bytes);
  entry.waits.delete(index);
  if (entry.download || entry.cache.has(index)) return;
  entry.cache.set(index, bytes);
  entry.bytes += bytes.length;
  const last = total(entry) - 1;
  for (const [old, value] of entry.cache) {
    if (entry.bytes <= CACHE_BYTES) break;
    if (old < RESIDENT || old > last - RESIDENT) continue;
    entry.cache.delete(old);
    entry.bytes -= value.length;
  }
  save(entry, Math.floor(index / BLOCK));
}

// A block whose records are all here goes to the device cache once.
function save(entry, block) {
  if (entry.saved.has(block)) return;
  const first = block * BLOCK;
  const parts = [];
  for (let i = first; i < Math.min(total(entry), first + BLOCK); i++) {
    const bytes = entry.cache.get(i);
    if (!bytes) return;
    parts.push(bytes);
  }
  entry.saved.add(block);
  disk().then(({ cacheAttachment }) => cacheAttachment(`media:${entry.file.key}:${block}`, entry.file.name, new Blob(parts))).catch(() => {});
}

// Fills a block from the device cache, looked up once per block.
async function load(entry, block) {
  if (entry.loaded.has(block) || block * BLOCK >= total(entry)) return;
  entry.loaded.add(block);
  const data = await disk().then(({ cachedAttachment }) => cachedAttachment(`media:${entry.file.key}:${block}`)).catch(() => null);
  if (!data) return;
  const bytes = new Uint8Array(data.data);
  entry.saved.add(block);
  for (let i = 0; i * RECORD < bytes.length; i++) keep(entry, block * BLOCK + i, bytes.subarray(i * RECORD, (i + 1) * RECORD));
}

// One GET per run of records in [first, stop) that neither a cache nor another GET holds.
function fetchRuns(entry, first, stop) {
  const free = (i) => !entry.cache.has(i) && !entry.pending.has(i);
  for (let a = first, b; a < stop; a = b) {
    while (a < stop && !free(a)) a++;
    for (b = a; b < stop && free(b);) b++;
    if (a === b) continue;
    for (let i = a; i < b; i++) entry.pending.add(i);
    const { file } = entry;
    (async () => {
      let at = a;
      try {
        for await (const bytes of transfer.records(file.key, file.stored, a, { sealed: file.sealed, end: b })) keep(entry, at++, bytes);
        if (at < b) throw new Error('File ended early');
      } catch (error) {
        for (let i = at; i < b; i++) { entry.waits.get(i)?.reject(error); entry.waits.delete(i); }
      } finally {
        for (let i = a; i < b; i++) entry.pending.delete(i);
      }
    })();
  }
}

// The record from memory, the device, or the GETs planned around it.
async function record(entry, index, limit) {
  const block = Math.floor(index / BLOCK);
  for (let b = block; b <= block + AHEAD && b * BLOCK < limit; b++) await load(entry, b);
  const hit = cached(entry, index);
  if (hit) return hit;
  let wait = entry.waits.get(index);
  if (!wait) {
    wait = {};
    wait.promise = new Promise((resolve, reject) => Object.assign(wait, { resolve, reject }));
    entry.waits.set(index, wait);
  }
  if (!entry.pending.has(index)) {
    const end = Math.min(limit, (block + 1) * BLOCK);
    let at = index;
    for (const size of START) { fetchRuns(entry, at, Math.min(end, at + size)); at = Math.min(end, at + size); }
    fetchRuns(entry, at, end);
  }
  for (let b = block + 1; b <= block + AHEAD && b * BLOCK < limit; b++) fetchRuns(entry, b * BLOCK, Math.min(limit, (b + 1) * BLOCK));
  return wait.promise;
}

// A stored copy that is gone is uploaded again once; requests that miss together share it.
async function again(entry, error) {
  if (!error.missing || !entry.refresh) throw error;
  entry.file = await (entry.refreshing ??= entry.refresh().then((next) => {
    entry.cache.clear(); entry.bytes = 0; entry.loaded.clear(); entry.saved.clear();
    return next;
  }));
}

async function* blocks(entry, start, end, signal) {
  const limit = Math.ceil(end / RECORD);
  let refreshed = false;
  for (let index = Math.floor(start / RECORD); index < limit && !signal?.aborted;) {
    let bytes;
    try {
      bytes = await record(entry, index, limit);
    } catch (error) {
      if (refreshed) throw error;
      refreshed = true;
      await again(entry, error);
      continue;
    }
    yield bytes.subarray(Math.max(0, start - index * RECORD), Math.min(bytes.length, end - index * RECORD));
    index++;
  }
}

async function* stream(entry, start, end, signal) {
  const limit = Math.ceil(end / RECORD);
  let source = null; // { records, at }
  let refreshed = false;
  let timer = 0;
  const close = () => { source?.records.return(); source = null; };
  try {
    for (let index = Math.floor(start / RECORD); index < limit; index++) {
      clearTimeout(timer);
      if (!entry.download && source?.at !== index) await load(entry, Math.floor(index / BLOCK));
      let bytes = source?.at === index ? null : cached(entry, index);
      while (!bytes) {
        const { file } = entry;
        if (source?.at !== index) {
          close();
          source = { records: transfer.records(file.key, file.stored, index, { sealed: file.sealed, signal, end: limit }), at: index };
        }
        try {
          const next = await source.records.next();
          if (next.done) throw new Error('File ended early');
          bytes = next.value;
          source.at++;
        } catch (error) {
          close();
          if (refreshed) throw error;
          refreshed = true;
          await again(entry, error);
        }
      }
      keep(entry, index, bytes);
      // A download that stops reading drops its GET (WebKit would keep filling memory) and resumes later.
      if (!BACKPRESSURE && entry.download) timer = setTimeout(close, STALL_MS);
      yield bytes.subarray(Math.max(0, start - index * RECORD), Math.min(bytes.length, end - index * RECORD));
    }
  } finally {
    clearTimeout(timer);
    close();
  }
}
