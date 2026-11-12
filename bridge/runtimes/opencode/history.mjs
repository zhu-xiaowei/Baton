// History of an OpenCode session from session_message (read-only). Loaded by the history and
// tool-details workers too, each with its own connection.
import { extractForApp } from '../../extract.mjs';
import { readPage } from '../../history-page.mjs';
import { open, RowIndex } from '../../sqlite-ro.mjs';
import { DB_FILE, messageRows } from './extract.mjs';

export const db = await open(DB_FILE);
const COLS = 'id, type, seq, time_created, data';

export class OpenCodeReader {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.meta = new Map(); // id → { seq, type, running } of every row seen
    this.index = new RowIndex(sessionId, (mark) => {
      const rows = db.all(`SELECT id, type, seq, time_updated AS mark, CASE WHEN type = 'shell' THEN json_extract(data, '$.status') END AS st
        FROM session_message WHERE session_id = ? AND time_updated >= ? ORDER BY seq`, [sessionId, mark]);
      for (const r of rows) this.meta.set(r.id, { seq: r.seq, type: r.type, running: r.st === 'running' });
      return rows;
    }, () => db.all('SELECT count(*) AS n FROM session_message WHERE session_id = ?', [sessionId])[0].n);
  }

  update() { return this.index.update(); }
  get epoch() { return this.index.epoch; }

  // Rows of the turn after the last idle row, and running `!cmd` rows, are still updated in place.
  stableLine() {
    const ids = this.index.ids;
    let line = Infinity;
    for (let i = ids.length - 1; i >= 0; i--) {
      const { type } = this.meta.get(ids[i]);
      if (type === 'idle') break;
      if (type === 'user' || type === 'assistant') line = i;
    }
    ids.forEach((id, i) => { if (this.meta.get(id).running && i < line) line = i; });
    return line;
  }

  raw(ids) {
    if (!ids.length) return [];
    const at = new Map(ids.map((id, i) => [id, i]));
    return db.all(`SELECT ${COLS} FROM session_message WHERE session_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
      [this.sessionId, this.meta.get(ids[0]).seq, this.meta.get(ids.at(-1)).seq]).filter((r) => at.has(r.id)).map((r) => [r, at.get(r.id)]);
  }

  async rows(lo, hi) {
    const out = [];
    for (const [row, i] of this.raw(this.index.read(lo, hi))) {
      for (const msg of messageRows(row, lo + i)) {
        if (msg.content.some?.((b) => b.type === 'image')) msg.content = (await extractForApp({ message: { content: msg.content } })).content;
        out.push(msg);
      }
    }
    return out;
  }

  page(range) { return readPage(this, range, 256, 4096); }
}

export default {
  runtime: 'opencode',
  module: import.meta.url,
  history: (target) => new OpenCodeReader(target.nativeSessionId),
  messages: (_file, id) => db.all(`SELECT ${COLS} FROM session_message WHERE session_id = ? ORDER BY seq`, [id]).flatMap((row) => messageRows(row)),
};
