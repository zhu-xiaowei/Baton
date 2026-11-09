// Byte range of every line of an append-only transcript, extended with the new bytes on each update.
import fs from 'node:fs';
import crypto from 'node:crypto';

const CHUNK = 8 << 20;
const MARK = 64; // bytes before the indexed end, compared on each update to catch in-place rewrites
const HEAD = 4096;

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
    this.mark = null;
  }

  get count() { return this.starts.length; }

  // A new inode, a shorter file or changed indexed bytes start over; the epoch is the inode plus the
  // first line. An unterminated last line is indexed provisionally and rescanned on the next update.
  // Returns true when the index changed.
  update() {
    const st = fs.statSync(this.file);
    const id = `${st.dev}:${st.ino}:${Math.round(st.birthtimeMs)}`;
    const fd = fs.openSync(this.file, 'r');
    try {
      let changed = false;
      if (this.id !== id || st.size < this.size || !this.marked(fd)) {
        this.reset(fd, id);
        changed = true;
      }
      if (st.size === this.size) return changed;
      if (this.provisional) {
        this.starts.pop();
        this.ends.pop();
        this.onDrop?.(this.starts.length);
        this.provisional = false;
      }
      let base = this.scanned;
      let size = CHUNK;
      let buf = null;
      while (base < st.size) {
        const want = Math.min(size, st.size - base);
        if (!buf || buf.length < want) buf = Buffer.allocUnsafe(want);
        const n = fs.readSync(fd, buf, 0, want, base);
        if (n < want) { this.reset(fd, ''); return true; } // shrank after stat: rebuilt next time
        const view = buf.subarray(0, n);
        let s = 0;
        for (let e = view.indexOf(10); e !== -1; e = view.indexOf(10, s)) {
          this.add(view, s, e, base);
          s = e + 1;
        }
        if (base + n >= st.size) {
          if (s < n) {
            this.add(view, s, n, base);
            this.provisional = true;
          }
          this.scanned = base + s;
          break;
        }
        if (s === 0) { size *= 2; continue; } // one line longer than the buffer
        base += s;
        this.scanned = base;
      }
      this.size = st.size;
      this.mark = this.readMark(fd);
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }

  reset(fd, id) {
    this.clear();
    this.onReset?.();
    this.id = id;
    // The first line (up to HEAD bytes) never changes once written, so the epoch survives restarts.
    const head = Buffer.allocUnsafe(HEAD);
    const n = fs.readSync(fd, head, 0, HEAD, 0);
    const end = head.subarray(0, n).indexOf(10);
    const first = end !== -1 ? head.subarray(0, end) : n === HEAD ? head : head.subarray(0, 0);
    this.epoch = crypto.createHash('sha1').update(id).update(first).digest('hex').slice(0, 12);
  }

  readMark(fd) {
    const from = Math.max(0, this.scanned - MARK);
    const buf = Buffer.allocUnsafe(this.scanned - from);
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, from));
  }

  marked(fd) {
    return !this.mark || this.readMark(fd).equals(this.mark);
  }

  add(buf, s, e, base) {
    this.starts.push(base + s);
    this.ends.push(base + e);
    this.onLine?.(buf, s, e, this.starts.length - 1);
  }

  // Bytes of lines [lo, hi), through `fd` when the caller has the file open.
  read(lo, hi, fd) {
    const own = fd === undefined ? fs.openSync(this.file, 'r') : fd;
    try {
      const buf = Buffer.alloc(this.ends[hi - 1] - this.starts[lo]);
      fs.readSync(own, buf, 0, buf.length, this.starts[lo]);
      return buf;
    } finally {
      if (own !== fd) fs.closeSync(own);
    }
  }
}

export function orderKeyLine(orderKey) {
  return Number(String(orderKey).split('#')[1]);
}
