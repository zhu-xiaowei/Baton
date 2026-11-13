// DSH session logs are concatenated zstd frames of JSON lines. Node decodes only the first frame of a
// buffer, so frames are located from their headers (no decompression) and decoded one by one.
import fs from 'node:fs';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { isMainThread } from 'node:worker_threads';

const FCS = [0, 2, 4, 8];
const DICT = [0, 1, 2, 4];

// Length of the complete frame at `at`, or 0 when the buffer ends first (a frame still being written).
function frameLength(buf, at) {
  if (at + 5 > buf.length) return 0;
  const magic = buf.readUInt32LE(at);
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    const n = at + 8 <= buf.length ? 8 + buf.readUInt32LE(at + 4) : Infinity;
    return at + n <= buf.length ? n : 0;
  }
  if (magic !== 0xfd2fb528) throw new Error(`bad zstd frame at ${at}`);
  const fhd = buf[at + 4];
  const single = (fhd >> 5) & 1;
  let p = at + 5 + (single ? 0 : 1) + DICT[fhd & 3] + ((fhd >> 6) === 0 ? single : FCS[fhd >> 6]);
  for (let last = 0; !last;) {
    if (p + 3 > buf.length) return 0;
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
    last = h & 1;
    p += 3 + (((h >> 1) & 3) === 1 ? 1 : h >>> 3);
  }
  p += (fhd >> 2) & 1 ? 4 : 0;
  return p <= buf.length ? p - at : 0;
}

export function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(end - start);
  try { return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, start)); } finally { fs.closeSync(fd); }
}

// Complete frames appended after `offset`: { frames: [[start, end]], buf } with absolute offsets.
export function newFrames(file, offset, size = fs.statSync(file).size) {
  const frames = [];
  if (size <= offset) return { frames, buf: null };
  const buf = readRange(file, offset, size);
  for (let at = 0, n; at < buf.length && (n = frameLength(buf, at)); at += n) frames.push([offset + at, offset + at + n]);
  return { frames, buf };
}

// A zstd context (DSH frames declare a 2 MB window) is freed only when its handle is collected, so the
// warm-up workers collect every 16 frames; otherwise thousands of decodes keep ~50 MB of RSS.
let decoded = 0;
const gc = isMainThread ? null : (() => { try { v8.setFlagsFromString('--expose-gc'); return vm.runInNewContext('gc'); } catch { return null; } })();

export function frameEvents(bytes) {
  const out = [];
  for (const line of zlib.zstdDecompressSync(bytes).toString('utf8').split('\n')) if (line) out.push(JSON.parse(line));
  if (gc && ++decoded % 16 === 0) gc();
  return out;
}

// LineIndex's interface where a "line" is a frame: update() walks the appended frame headers only,
// events(lo, hi) decodes just frames [lo, hi). DSH only appends; a new inode or a shorter file restarts.
export class FrameIndex {
  constructor(file) {
    this.file = file;
    this.cache = new Map(); // frame number → events, the few most recently decoded
    this.clear();
  }

  clear() {
    Object.assign(this, { starts: [], ends: [], size: 0, id: '', epoch: '' });
    this.cache.clear();
  }

  get count() { return this.starts.length; }

  update() {
    const st = fs.statSync(this.file);
    const id = `${st.dev}:${st.ino}`;
    if (id !== this.id || st.size < this.size) {
      this.clear();
      this.id = id;
      this.epoch = crypto.createHash('sha1').update(`${id}:${st.birthtimeMs}`).digest('hex').slice(0, 12);
    }
    const { frames } = newFrames(this.file, this.ends.at(-1) || 0, st.size);
    for (const [s, e] of frames) { this.starts.push(s); this.ends.push(e); }
    this.size = st.size;
  }

  // [{ frame, i, event }] of frames [lo, hi); uncached frames are read in one go.
  events(lo, hi) {
    const out = [];
    if (hi <= lo) return out;
    const buf = readRange(this.file, this.starts[lo], this.ends[hi - 1]);
    for (let f = lo; f < hi; f++) {
      let events = this.cache.get(f);
      if (!events) {
        events = frameEvents(buf.subarray(this.starts[f] - this.starts[lo], this.ends[f] - this.starts[lo]));
        this.cache.set(f, events);
        if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
      }
      events.forEach((event, i) => out.push({ frame: f, i, event }));
    }
    return out;
  }
}
