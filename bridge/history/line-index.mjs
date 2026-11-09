// Byte range of every line of an append-only transcript, extended with the new bytes on each update.
import fs from 'node:fs';
import crypto from 'node:crypto';

const CHUNK = 8 << 20;

export class LineIndex {
  // onLine(buf, start, end, line) sees each new line; onReset() and onDrop(line) keep derived state in step.
  constructor(file, { onLine, onReset, onDrop } = {}) {
    this.file = file;
    this.onLine = onLine;
    this.onReset = onReset;
    this.onDrop = onDrop;
    this.clear();
  }

  clear() {
    this.starts = [];
    this.ends = [];
    this.scanned = 0;
    this.size = 0;
    this.id = null;
    this.epoch = '';
    this.provisional = false;
  }

  get count() { return this.starts.length; }

  // A new inode or a shorter file starts over; an unterminated last line is indexed provisionally
  // and rescanned on the next update. Returns true when the index changed.
  update() {
    const st = fs.statSync(this.file);
    const id = `${st.dev}:${st.ino}:${Math.round(st.birthtimeMs)}`;
    let changed = false;
    if (this.id !== id || st.size < this.size) {
      this.clear();
      this.onReset?.();
      this.id = id;
      this.epoch = crypto.createHash('sha1').update(id).digest('hex').slice(0, 12);
      changed = true;
    }
    if (st.size === this.size) return changed;
    if (this.provisional) {
      this.starts.pop();
      this.ends.pop();
      this.onDrop?.(this.starts.length);
      this.provisional = false;
    }
    const fd = fs.openSync(this.file, 'r');
    try {
      let base = this.scanned;
      let buf = Buffer.alloc(CHUNK);
      while (base < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, st.size - base), base);
        let s = 0;
        for (let e = buf.indexOf(10, 0); e !== -1 && e < n; e = buf.indexOf(10, s)) {
          this.add(buf, s, e, base);
          s = e + 1;
        }
        if (base + n >= st.size) {
          if (s < n) {
            this.add(buf, s, n, base);
            this.provisional = true;
          }
          this.scanned = base + s;
          break;
        }
        if (s === 0) { buf = Buffer.alloc(buf.length * 2); continue; } // one line longer than the buffer
        base += s;
        this.scanned = base;
      }
    } finally {
      fs.closeSync(fd);
    }
    this.size = st.size;
    return true;
  }

  add(buf, s, e, base) {
    this.starts.push(base + s);
    this.ends.push(base + e);
    this.onLine?.(buf, s, e, this.starts.length - 1);
  }

  // Bytes of lines [lo, hi).
  read(lo, hi) {
    const fd = fs.openSync(this.file, 'r');
    try {
      const buf = Buffer.alloc(this.ends[hi - 1] - this.starts[lo]);
      fs.readSync(fd, buf, 0, buf.length, this.starts[lo]);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function orderKeyLine(orderKey) {
  return Number(String(orderKey).split('#')[1]);
}
