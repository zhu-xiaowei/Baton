// Read-only SQLite through the built-in node:sqlite, plus RowIndex: a session's ordered rows behind
// the LineIndex interface the history readers use.
import fs from 'node:fs';
import crypto from 'node:crypto';

const BUSY_RETRIES = 3;
const BUSY_WAIT_MS = 50;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));
let DatabaseSync = null;

// node:sqlite prints an ExperimentalWarning on import; only that warning is dropped.
async function load() {
  if (DatabaseSync) return;
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && /SQLite/.test(String(warning?.message ?? warning))) return;
    return emit.call(this, warning, ...rest);
  };
  try { ({ DatabaseSync } = await import('node:sqlite')); } finally { process.emitWarning = emit; }
}

export async function open(file) {
  await load();
  return new ReadOnlyDb(file);
}

class ReadOnlyDb {
  constructor(file) {
    this.file = file;
    this.db = null;
    this.ino = 0;
    this.opened = 0;
    this.statements = new Map();
  }

  // A replaced database file (new inode) gets a new connection.
  connect() {
    const { ino } = fs.statSync(this.file);
    if (this.db && ino === this.ino) return;
    this.close();
    this.db = new DatabaseSync(this.file, { readOnly: true });
    this.ino = ino;
    this.opened++;
  }

  all(sql, args = []) {
    for (let attempt = 0; ; attempt++) {
      try {
        this.connect();
        let statement = this.statements.get(sql);
        if (!statement) this.statements.set(sql, statement = this.db.prepare(sql));
        return statement.all(...args);
      } catch (error) {
        if ((error?.errcode & 0xff) !== 5 || attempt === BUSY_RETRIES) throw error; // SQLITE_BUSY
        Atomics.wait(SLEEP, 0, 0, BUSY_WAIT_MS);
      }
    }
  }

  // Changes when another connection committed; a reopened file always reads as changed.
  dataVersion() {
    const { data_version: version } = this.all('PRAGMA data_version')[0];
    return `${this.opened}:${version}`;
  }

  close() {
    this.statements.clear();
    try { this.db?.close(); } catch {}
    this.db = null;
  }
}

// changedSince(mark) returns { id, mark } for rows whose mark >= `mark`, in display order with new
// rows last; total() is the session's row count. A count that disagrees (rows were deleted) rebuilds
// the index under a new epoch, so cursors from the old row order are rejected.
export class RowIndex {
  constructor(key, changedSince, total) {
    Object.assign(this, { key, changedSince, total });
    this.generation = 0;
    this.clear();
  }

  clear() {
    this.ids = [];
    this.marks = new Map(); // id → mark
    this.mark = -Infinity;
    this.epoch = '';
    this.changed = []; // ids added or updated by the last update()
  }

  get count() { return this.ids.length; }

  // Returns true when the index changed.
  update() {
    const fresh = !this.epoch;
    this.changed = [];
    for (const row of this.changedSince(this.mark)) {
      if (this.marks.get(row.id) === row.mark) continue; // re-read by >=
      if (!this.marks.has(row.id)) this.ids.push(row.id);
      this.marks.set(row.id, row.mark);
      this.changed.push(row.id);
      if (row.mark > this.mark) this.mark = row.mark;
    }
    if (!fresh && this.total() !== this.ids.length) {
      this.generation++;
      this.clear();
      return this.update();
    }
    if (fresh) this.epoch = crypto.createHash('sha1').update(`${this.key}|${this.ids[0] || ''}|${this.generation}`).digest('hex').slice(0, 12);
    return fresh || this.changed.length > 0;
  }

  // Ids of rows [lo, hi).
  read(lo, hi) { return this.ids.slice(lo, hi); }
}
