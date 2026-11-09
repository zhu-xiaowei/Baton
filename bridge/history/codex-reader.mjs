// History pages of a Codex rollout, read through a line index. The extractor builds one card from
// several lines (call, output, completion), so a window also reads the lines it depends on; the index
// finds them by byte search only.
import fs from 'node:fs';
import { extractCodexMessages } from '../codex-extract.mjs';
import { LineIndex, orderKeyLine } from './line-index.mjs';

const HEAD = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"([^"]+)"(?:,"payload":\{"type":"([^"]+)")?/;
const SKIP = new Set(['response_item/reasoning', 'event_msg/token_count', 'token_usage_record', 'world_state',
  'event_msg/thread_settings_applied']);
const EMPTY_COMPACTION = Buffer.from('"type":"compacted","payload":{"message":"",');
const CALL_KEYS = [Buffer.from('"call_id":"call_'), Buffer.from('"id":"call_')];
const PROCESS_START = Buffer.from('Process running with session ID ');
const PROCESS_USE = Buffer.from('\\"session_id\\":');
const ROLE_USER = Buffer.from('"role":"user"');
const USER_ITEM = Buffer.from('"type":"UserMessage"');
const FIRST_WINDOW = 128;
const MAX_WINDOW = 1024;

function digits(buf, at) {
  let value = '';
  while (buf[at] >= 48 && buf[at] <= 57) value += String.fromCharCode(buf[at++]);
  return value;
}

export class CodexHistoryReader {
  constructor(file, nativeSessionId) {
    this.file = file;
    this.nativeSessionId = nativeSessionId;
    this.clear();
    this.index = new LineIndex(file, {
      onLine: (buf, s, e, line) => this.scan(buf, s, e, line),
      onReset: () => this.clear(),
      onDrop: (line) => this.forget(line),
    });
  }

  clear() {
    this.skip = [];
    this.callsOf = [];
    this.processUses = [];
    this.linesOfCall = new Map();
    this.processStart = new Map();
    this.turns = [];          // task_started lines
    this.prompts = [[]];      // prompt lines per turn; [0] = before the first turn
    this.lastTurnEnd = -1;
  }

  update() { return this.index.update(); }

  get epoch() { return this.index.epoch; }

  // Rows of a turn still in progress can change (results superseded, a prompt retracted).
  stableLine() {
    const start = this.turns.at(-1);
    return start !== undefined && start > this.lastTurnEnd ? start : Infinity;
  }

  scan(buf, s, e, line) {
    const head = HEAD.exec(buf.latin1Slice(s, Math.min(e, s + 160)));
    const kind = head ? `${head[1]}/${head[2] || ''}` : '';
    const compacted = head?.[1] === 'compacted';
    const L = buf.subarray(s, e);
    const skip = !!head && (SKIP.has(head[1]) || SKIP.has(kind)
      || (compacted && L.subarray(0, 200).includes(EMPTY_COMPACTION)));
    this.skip[line] = skip;
    this.callsOf[line] = [];
    this.processUses[line] = [];
    if (kind === 'event_msg/task_started') { this.turns.push(line); this.prompts.push([]); }
    if (kind === 'event_msg/task_complete' || kind === 'event_msg/turn_aborted') this.lastTurnEnd = line;
    // A compaction's replacement history quotes old call ids; they are not dependencies.
    if (skip || compacted) return;
    // Both copies of a prompt must be read together, or the extractor's mirror dedupe emits it twice.
    if (kind === 'event_msg/user_message'
      || (kind === 'response_item/message' && L.subarray(0, 400).includes(ROLE_USER))
      || (kind === 'event_msg/item_completed' && L.subarray(0, 400).includes(USER_ITEM))) this.prompts.at(-1).push(line);
    for (const key of CALL_KEYS) {
      for (let p = L.indexOf(key); p !== -1; p = L.indexOf(key, p + 1)) {
        const a = p + key.length - 5;
        const q = L.indexOf(34, a);
        if (q === -1) continue; // unterminated tail
        const id = L.latin1Slice(a, q);
        if (this.callsOf[line].includes(id)) continue;
        this.callsOf[line].push(id);
        if (!this.linesOfCall.has(id)) this.linesOfCall.set(id, []);
        this.linesOfCall.get(id).push(line);
      }
    }
    const started = L.indexOf(PROCESS_START);
    if (started !== -1) {
      const id = digits(L, started + PROCESS_START.length);
      if (id && !this.processStart.has(id)) this.processStart.set(id, line);
    }
    for (let p = L.indexOf(PROCESS_USE); p !== -1; p = L.indexOf(PROCESS_USE, p + 1)) {
      let q = p + PROCESS_USE.length;
      while (L[q] === 32) q++;
      const id = digits(L, q);
      if (id) this.processUses[line].push(id);
    }
  }

  forget(line) {
    for (const id of this.callsOf[line] || []) {
      const lines = this.linesOfCall.get(id);
      if (lines?.at(-1) === line) lines.pop();
    }
    for (const [id, start] of this.processStart) if (start === line) this.processStart.delete(id);
    if (this.turns.at(-1) === line) { this.turns.pop(); this.prompts.pop(); }
    const prompts = this.prompts.at(-1);
    if (prompts.at(-1) === line) prompts.pop();
    if (this.lastTurnEnd === line) this.lastTurnEnd = -1;
    this.skip.length = this.callsOf.length = this.processUses.length = line;
  }

  // Rows whose source line is in [lo, hi).
  rows(lo, hi) {
    const count = this.index.count;
    if (hi <= lo) return [];
    const keep = new Set();
    for (let line = lo; line < hi; line++) keep.add(line);
    let turn = -1;
    for (let a = 0, b = this.turns.length - 1; a <= b;) {
      const m = (a + b) >> 1;
      if (this.turns[m] <= lo) { turn = m; a = m + 1; } else b = m - 1;
    }
    for (let t = turn; t < this.turns.length && (t < 0 || this.turns[t] < hi); t++) {
      for (const line of this.prompts[t + 1]) keep.add(line);
    }
    const pending = [...keep];
    const add = (line) => { if (!keep.has(line)) { keep.add(line); pending.push(line); } };
    while (pending.length) {
      const line = pending.pop();
      for (const id of this.callsOf[line]) for (const other of this.linesOfCall.get(id)) add(other);
      for (const id of this.processUses[line]) {
        const start = this.processStart.get(id);
        if (start !== undefined) add(start);
      }
    }
    const order = [...keep].filter((line) => !this.skip[line]).sort((a, b) => a - b);
    const lines = new Array(count);
    const fd = fs.openSync(this.file, 'r');
    try {
      for (let r = 0; r < order.length;) { // contiguous runs in one read
        let q = r;
        while (q + 1 < order.length && order[q + 1] === order[q] + 1) q++;
        const base = this.index.starts[order[r]];
        const buf = Buffer.alloc(this.index.ends[order[q]] - base);
        fs.readSync(fd, buf, 0, buf.length, base);
        for (let i = r; i <= q; i++) {
          const line = order[i];
          lines[line] = buf.utf8Slice(this.index.starts[line] - base, this.index.ends[line] - base);
        }
        r = q + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
    return extractCodexMessages(this.file, this.nativeSessionId, { lines, order }).messages
      .filter((row) => { const line = orderKeyLine(row.orderKey); return line >= lo && line < hi; });
  }

  // Walks back in growing windows; each window is computed once (dependency lines make them independent).
  pageEnding(hiLine, keepRow, limit) {
    let rows = [];
    for (let hi = hiLine, step = FIRST_WINDOW; hi > 0 && rows.length < limit; step = Math.min(step * 2, MAX_WINDOW)) {
      const lo = Math.max(0, hi - step);
      rows = this.rows(lo, hi).filter(keepRow).concat(rows);
      hi = lo;
    }
    return rows.slice(-limit);
  }

  latest(limit) { return this.pageEnding(this.index.count, () => true, limit); }

  before(cursor, limit) { return this.pageEnding(orderKeyLine(cursor) + 1, (row) => row.orderKey < cursor, limit); }

  after(cursor) { return this.rows(orderKeyLine(cursor), this.index.count).filter((row) => row.orderKey > cursor); }
}
