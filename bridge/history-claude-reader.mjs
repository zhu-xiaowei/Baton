// History pages of a Claude transcript, read through a line index. A line is one message (the App pairs
// tool_use and tool_result), so a page reads only its own lines plus one line of lead-in.
import { claudeMessageLine, extractForApp, nativeOrderKey } from './extract.mjs';
import { LineIndex } from './history-line-index.mjs';
import { readPage } from './history-page.mjs';

const TITLE_TYPES = new Set(['ai-title', 'custom-title', 'last-prompt']);
const MESSAGE_TYPES = new Set(['user', 'assistant', 'summary', 'attachment', 'system']);
const OBJECT_TYPE = Buffer.from('{"type":"');
const WINDOW = 64;

// A line starting {"type":"X" has top-level type X (the first key); null when the head says nothing.
// Lines of non-message kinds (titles included) are skipped undecoded.
function headType(buf, s, e) {
  if (e - s < OBJECT_TYPE.length || buf.compare(OBJECT_TYPE, 0, OBJECT_TYPE.length, s, s + OBJECT_TYPE.length) !== 0) return null;
  const q = buf.indexOf(34, s + OBJECT_TYPE.length);
  return q === -1 || q > e ? null : buf.latin1Slice(s + OBJECT_TYPE.length, q);
}

export class ClaudeHistoryReader {
  constructor(file) {
    this.titleLines = new Map(); // title type → its latest line
    this.index = new LineIndex(file, {
      onLine: (buf, s, e, line) => {
        const type = headType(buf, s, e);
        if (TITLE_TYPES.has(type)) this.titleLines.set(type, line);
      },
      onReset: () => this.titleLines.clear(),
      onDrop: (line) => { for (const [type, at] of this.titleLines) if (at === line) this.titleLines.delete(type); },
    });
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
      const type = headType(buf, s, e);
      if (type !== null && !MESSAGE_TYPES.has(type)) continue;
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

  // The latest row of each title type.
  async titles() {
    const out = [];
    for (const line of [...this.titleLines.values()].sort((a, b) => a - b)) {
      let msg;
      try { msg = JSON.parse(this.index.read(line, line + 1).toString('utf8')); } catch { continue; }
      const row = await extractForApp(msg);
      row.orderKey = nativeOrderKey(line);
      out.push(row);
    }
    return out;
  }

  page(range) { return readPage(this, range, WINDOW, WINDOW); }
}
