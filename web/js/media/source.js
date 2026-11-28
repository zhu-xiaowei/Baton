// HTTP responses for a stored file, decrypted in the page, for <video>/<audio> and downloads
// (docs/media-streaming.md). Every request is served from one state per file: each record is fetched
// once whichever request wants it, at most AHEAD records past the position of the request that asked
// for it. Chromium ≥ 126 pauses a fetch the page stops reading, so it opens one GET per position
// (1–5 GETs per GB played). Elsewhere fetch keeps downloading into memory, so a GET covers one 16 MiB
// block, after an open or a seek 1, 4, 4 and 8 MiB at once. Whole decrypted blocks stay on the device.
import { RECORD, transfer } from '../../../bridge/transfer-store.mjs';

const agent = globalThis.navigator?.userAgent || '';
const IOS = /iPhone|iPad|iPod/.test(agent) || (globalThis.navigator?.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const BACKPRESSURE = !IOS && Number(/Chrome\/(\d+)/.exec(agent)?.[1]) >= 126;
const BLOCK = 256; // records: 16 MiB, also the unit of the device cache
const START = BACKPRESSURE ? [] : [16, 64, 64, 128]; // records: 1, 4, 4, 8 MiB at once
const AHEAD = 2 * BLOCK;
const CACHE_BYTES = (IOS ? 96 : 128) * 1024 * 1024;
const RESIDENT = 16; // records kept at each end (probes, moov)
const disk = () => import('../components/attachment-cache.js');

const files = new Map(); // token → entry

// `file`: { key, name, size (plain), stored, sealed, previewType }. `refresh()` resolves the file
// again (the Bridge uploads it once more) when its stored copy is gone.
export function register(file, { download = false, refresh } = {}) {
  const token = crypto.randomUUID().replace(/-/g, '');
  files.set(token, { token, file, download, refresh, active: 0, cache: new Map(), bytes: 0, waits: new Map(), pending: new Set(),
    runs: new Set(), loaded: new Set(), saved: new Set(), reading: new Map(), poke: deferred() });
  if (files.size > 8) close(files.keys().next().value);
  return token;
}

function close(token) {
  const entry = files.get(token);
  if (!entry) return;
  entry.closed = true;
  for (const run of entry.runs) run.abort.abort();
  poke(entry);
  files.delete(token);
}

export function releasePlayback() { for (const [token, entry] of files) if (!entry.download) close(token); }

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

function deferred() {
  const wait = {};
  wait.promise = new Promise((resolve, reject) => Object.assign(wait, { resolve, reject }));
  wait.promise.catch(() => {});
  return wait;
}

const waitIn = (entry, from, to) => [...entry.waits.keys()].some((i) => i >= from && i < to);

// Wakes GETs paused ahead of their readers.
function poke(entry) {
  entry.poke.resolve();
  entry.poke = deferred();
}

const total = (entry) => Math.max(1, Math.ceil(entry.file.size / RECORD));

function cached(entry, index) {
  const bytes = entry.cache.get(index);
  if (bytes) { entry.cache.delete(index); entry.cache.set(index, bytes); }
  return bytes;
}

function keep(entry, index, bytes) {
  entry.pending.delete(index);
  entry.waits.get(index)?.resolve(bytes);
  entry.waits.delete(index);
  if (entry.cache.has(index)) return;
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

// Fills a block from the device cache: once if it was never seen, again whenever this file saved it.
function load(entry, block, index = block * BLOCK) {
  if (entry.cache.has(index) || (entry.loaded.has(block) && !entry.saved.has(block))) return;
  if (!entry.reading.has(block)) {
    entry.loaded.add(block);
    entry.reading.set(block, (async () => {
      const data = await disk().then(({ cachedAttachment }) => cachedAttachment(`media:${entry.file.key}:${block}`)).catch(() => null);
      if (!data) { entry.saved.delete(block); return; }
      const bytes = new Uint8Array(data.data);
      entry.saved.add(block);
      for (let i = 0; i * RECORD < bytes.length; i++) keep(entry, block * BLOCK + i, bytes.subarray(i * RECORD, (i + 1) * RECORD));
    })().finally(() => entry.reading.delete(block)));
  }
  return entry.reading.get(block);
}

// One GET per run of records in [first, stop) that neither a cache nor another GET holds. A GET reads
// on while its reader is within AHEAD of it or someone waits for a record it still has to read.
function fetchRuns(entry, owner, first, stop) {
  const free = (i) => !entry.cache.has(i) && !entry.pending.has(i);
  for (let a = first, b; a < stop; a = b) {
    while (a < stop && !free(a)) a++;
    for (b = a; b < stop && free(b);) b++;
    if (a === b) continue;
    for (let i = a; i < b; i++) entry.pending.add(i);
    const run = { abort: new AbortController(), at: a, b, owner };
    entry.runs.add(run);
    owner.runs.add(run);
    const { file } = entry;
    (async () => {
      const records = transfer.records(file.key, file.stored, a, { sealed: file.sealed, end: b, signal: run.abort.signal });
      try {
        while (run.at < run.b) {
          // Only a fetch with backpressure waits for its reader; elsewhere the whole response is already here.
          while (BACKPRESSURE && run.at > owner.at + AHEAD && !waitIn(entry, run.at, run.b) && !run.abort.signal.aborted) await entry.poke.promise;
          if (run.abort.signal.aborted) throw Object.assign(new Error('Read stopped'), { retry: true });
          const next = await records.next();
          if (next.done) break;
          keep(entry, run.at++, next.value);
        }
      } catch (error) {
        for (let i = run.at; i < run.b; i++) { entry.waits.get(i)?.reject(run.abort.signal.aborted ? Object.assign(error, { retry: true }) : error); entry.waits.delete(i); }
      } finally {
        records.return().catch(() => {});
        for (let i = run.at; i < run.b; i++) entry.pending.delete(i);
        entry.runs.delete(run);
        owner.runs.delete(run);
      }
    })();
  }
}

// The record from memory, the device, or the GETs planned around it.
async function record(entry, owner, index, limit) {
  owner.at = index;
  poke(entry);
  const block = Math.floor(index / BLOCK);
  await load(entry, block, index);
  const hit = cached(entry, index);
  if (hit) return hit;
  const wait = entry.waits.get(index) || entry.waits.set(index, deferred()).get(index);
  poke(entry);
  // A GET still more than a block before this record ends there; a new one starts here.
  const behind = [...entry.runs].find((run) => index >= run.at && index < run.b && index - run.at > BLOCK);
  if (behind) { for (let i = index; i < behind.b; i++) entry.pending.delete(i); behind.b = index; }
  if (!entry.pending.has(index)) {
    // A seek: GETs of requests that ended, away from here and wanted by nobody, stop now.
    for (const run of entry.runs) {
      if (run.owner.done && !waitIn(entry, run.at, run.b) && (run.b <= index || run.at >= index + AHEAD + BLOCK)) run.abort.abort();
    }
    const end = BACKPRESSURE ? limit : Math.min(limit, (block + 1) * BLOCK);
    let at = index;
    for (const size of START) { fetchRuns(entry, owner, at, Math.min(end, at + size)); at = Math.min(end, at + size); }
    fetchRuns(entry, owner, at, end);
  }
  // Blocks ahead once the request has played its first MiB: a scrub costs only its START pieces.
  for (let b = block + 1; !BACKPRESSURE && index - owner.from >= START[0] && b <= block + AHEAD / BLOCK && b * BLOCK < limit; b++) {
    await load(entry, b);
    fetchRuns(entry, owner, b * BLOCK, Math.min(limit, (b + 1) * BLOCK));
  }
  return wait.promise;
}

// A stored copy that is gone is uploaded again; requests that miss together share one upload.
async function again(entry, error) {
  if (!error.missing || !entry.refresh) throw error;
  entry.file = await (entry.refreshing ??= entry.refresh().then((next) => {
    entry.cache.clear(); entry.bytes = 0; entry.loaded.clear(); entry.saved.clear();
    return next;
  }).finally(() => { entry.refreshing = null; }));
}

// A request that ends (the player closed it, or sought elsewhere) stops the GETs it started that
// nobody waits for.
async function* read(entry, start, end, signal) {
  const limit = Math.ceil(end / RECORD);
  const owner = { at: Math.floor(start / RECORD), from: Math.floor(start / RECORD), runs: new Set() };
  let refreshed = false; // since the last record served
  entry.active++;
  clearTimeout(entry.release);
  try {
    for (let index = owner.at; index < limit && !signal?.aborted && !entry.closed;) {
      let bytes;
      try {
        bytes = await record(entry, owner, index, limit);
      } catch (error) {
        if (error.retry && !entry.closed) continue;
        if (refreshed) throw error;
        refreshed = true;
        await again(entry, error);
        continue;
      }
      refreshed = false;
      yield bytes.subarray(Math.max(0, start - index * RECORD), Math.min(bytes.length, end - index * RECORD));
      index++;
    }
  } finally {
    owner.done = true;
    // A download's state goes a minute after its last request ends (a save may resume by range).
    if (!--entry.active && entry.download) entry.release = setTimeout(() => close(entry.token), 60_000);
    // A seek closes the request just before the next one asks: give that one a second to claim them.
    setTimeout(() => {
      for (const run of owner.runs) if (!waitIn(entry, run.at, run.b)) run.abort.abort();
      poke(entry);
    }, 1000);
  }
}
