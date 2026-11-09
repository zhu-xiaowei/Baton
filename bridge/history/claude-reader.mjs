// History pages of a Claude transcript, read through a line index. A line is one message (the App pairs
// tool_use and tool_result), so a page reads only its own lines plus one line of lead-in.
import { claudeMessageLine, extractForApp, nativeOrderKey } from '../extract.mjs';
import { LineIndex, orderKeyLine } from './line-index.mjs';

const TITLE_TYPES = new Set(['ai-title', 'custom-title', 'last-prompt']);
const MESSAGE_TYPES = new Set(['user', 'assistant', 'summary', 'attachment', 'system']);
const OBJECT_TYPE = Buffer.from('{"type":"');
const WINDOW = 64;

// A line starting {"type":"X" has top-level type X (the first key), so other kinds are skipped undecoded.
function skippable(buf, s, e) {
  if (e - s < OBJECT_TYPE.length || buf.compare(OBJECT_TYPE, 0, OBJECT_TYPE.length, s, s + OBJECT_TYPE.length) !== 0) return false;
  const q = buf.indexOf(34, s + OBJECT_TYPE.length);
  if (q === -1 || q > e) return false;
  return !MESSAGE_TYPES.has(buf.latin1Slice(s + OBJECT_TYPE.length, q));
}

export class ClaudeHistoryReader {
  constructor(file) {
    this.index = new LineIndex(file);
  }

  update() { return this.index.update(); }

  get epoch() { return this.index.epoch; }

  // Every row is final once written.
  stableLine() { return Infinity; }

  // Rows whose source line is in [lo, hi); title rows are left to the session index.
  async rows(lo, hi) {
    const index = this.index;
    if (hi <= lo) return [];
    const from = Math.max(0, lo - 1);
    const buf = index.read(from, hi);
    const base = index.starts[from];
    const metaUuids = new Set();
    const out = [];
    for (let line = from; line < hi; line++) {
      const s = index.starts[line] - base;
      const e = index.ends[line] - base;
      if (skippable(buf, s, e)) continue;
      let msg;
      try { msg = JSON.parse(buf.utf8Slice(s, e)); } catch { continue; }
      if (TITLE_TYPES.has(msg?.type)) continue;
      msg = claudeMessageLine(msg, metaUuids);
      if (!msg || line < lo) continue;
      const row = await extractForApp(msg);
      if (!row.uuid) continue;
      row.orderKey = nativeOrderKey(line);
      out.push(row);
    }
    return out;
  }

  async pageEnding(hiLine, limit) {
    let rows = [];
    for (let hi = hiLine; hi > 0 && rows.length < limit;) {
      const lo = Math.max(0, hi - WINDOW);
      rows = (await this.rows(lo, hi)).concat(rows);
      hi = lo;
    }
    return rows.slice(-limit);
  }

  latest(limit) { return this.pageEnding(this.index.count, limit); }

  before(cursor, limit) { return this.pageEnding(Math.min(orderKeyLine(cursor), this.index.count), limit); }

  after(cursor) { return this.rows(orderKeyLine(cursor) + 1, this.index.count); }
}
