// IndexedDB copy of the history pages a Session showed: one chunk per Bridge reply plus a meta
// record listing each cached range's chunks. Any IndexedDB failure is a plain miss.
const DB_NAME = 'baton-history-v1';
const BUDGET_BYTES = 200 * 1024 * 1024;

function request(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

export function indexedDbBackend(factory = globalThis.indexedDB) {
  let opened = null;
  const db = () => (opened ||= new Promise((resolve, reject) => {
    if (!factory) return reject(new Error('IndexedDB is unavailable'));
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('sessions', { keyPath: 'scope' });
      req.result.createObjectStore('chunks', { keyPath: ['scope', 'first'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const chunkRange = (scope) => IDBKeyRange.bound([scope, ''], [scope, '￿']);
  return {
    async load(scope) {
      const tx = (await db()).transaction(['sessions', 'chunks']);
      const [meta, chunks] = await Promise.all([request(tx.objectStore('sessions').get(scope)),
        request(tx.objectStore('chunks').getAll(chunkRange(scope)))]);
      return meta ? { meta, chunks } : null;
    },
    async save(meta, put, removed) {
      const tx = (await db()).transaction(['sessions', 'chunks'], 'readwrite');
      tx.objectStore('sessions').put(meta);
      for (const first of removed) tx.objectStore('chunks').delete([meta.scope, first]);
      for (const chunk of put) tx.objectStore('chunks').put({ scope: meta.scope, ...chunk });
      await done(tx);
    },
    async metas() { return request((await db()).transaction('sessions').objectStore('sessions').getAll()); },
    async drop(scope) {
      const tx = (await db()).transaction(['sessions', 'chunks'], 'readwrite');
      tx.objectStore('sessions').delete(scope);
      tx.objectStore('chunks').delete(chunkRange(scope));
      await done(tx);
    },
  };
}

export function memoryBackend() {
  const sessions = new Map();
  const chunks = new Map(); // scope → Map(first → chunk)
  const copy = (value) => JSON.parse(JSON.stringify(value));
  return {
    async load(scope) {
      const meta = sessions.get(scope);
      return meta ? { meta: copy(meta), chunks: [...(chunks.get(scope) || new Map()).values()].map(copy) } : null;
    },
    async save(meta, put, removed) {
      sessions.set(meta.scope, copy(meta));
      const map = chunks.get(meta.scope) || new Map();
      for (const first of removed) map.delete(first);
      for (const chunk of put) map.set(chunk.first, copy({ scope: meta.scope, ...chunk }));
      chunks.set(meta.scope, map);
    },
    async metas() { return [...sessions.values()].map(copy); },
    async drop(scope) { sessions.delete(scope); chunks.delete(scope); },
  };
}

// A Session's cache in memory: ranges of chunks, oldest first; a gap separates two ranges.
export class CachedSession {
  constructor(scope, stored) {
    this.scope = scope;
    this.epoch = stored?.meta.epoch || '';
    this.stable = stored?.meta.stable || null;
    const byFirst = new Map((stored?.chunks || []).map((chunk) => [chunk.first, chunk]));
    // A chunk deleted under this record (eviction, another window) would leave a hole: start over.
    const whole = (stored?.meta.ranges || []).every((range) => range.chunks.every((first) => byFirst.has(first)));
    this.ranges = whole ? (stored?.meta.ranges || []).map((range) => ({
      atStart: range.atStart,
      chunks: range.chunks.map((first) => byFirst.get(first)).map(({ first, rows }) => ({ first, rows })),
    })).filter((range) => range.chunks.length) : [];
    this.put = new Map();
    this.removed = new Set(whole ? [] : (stored?.chunks || []).map((chunk) => chunk.first));
    if (!whole) this.stable = null;
  }

  get newest() { return this.ranges.at(-1) || null; }

  rows(range) { return range.chunks.flatMap((chunk) => chunk.rows); }

  touch(chunk) { this.put.set(chunk.first, chunk); this.removed.delete(chunk.first); }

  drop(chunk) { this.put.delete(chunk.first); this.removed.add(chunk.first); }

  // Rows after `cursor` in the newest range are replaced (they were unconfirmed or still changing).
  trimNewest(cursor) {
    const range = this.newest;
    if (!range) return;
    while (range.chunks.length) {
      const chunk = range.chunks.at(-1);
      if (chunk.first > cursor) { range.chunks.pop(); this.drop(chunk); continue; }
      const kept = chunk.rows.filter((row) => row.orderKey <= cursor);
      if (kept.length !== chunk.rows.length) { chunk.rows = kept; this.touch(chunk); }
      break;
    }
    if (!range.chunks.length) this.ranges.pop();
  }

  append(rows, { gap = false, atStart = false } = {}) {
    if (!rows.length) return;
    const chunk = { first: rows[0].orderKey, rows };
    if (gap || !this.newest) this.ranges.push({ atStart, chunks: [] });
    this.newest.chunks.push(chunk);
    this.touch(chunk);
  }

  prepend(range, rows, atStart) {
    if (rows.length) {
      const chunk = { first: rows[0].orderKey, rows };
      range.chunks.unshift(chunk);
      this.touch(chunk);
    }
    if (atStart) range.atStart = true;
  }

  // Two ranges become one when the rows between them were fetched.
  join(older, newer) {
    older.chunks.push(...newer.chunks);
    this.ranges.splice(this.ranges.indexOf(newer), 1);
  }

  reset() {
    for (const range of this.ranges) for (const chunk of range.chunks) this.drop(chunk);
    this.ranges = [];
    this.stable = null;
  }

  meta() {
    const bytes = this.ranges.reduce((sum, range) => sum + JSON.stringify(range.chunks).length, 0);
    return { scope: this.scope, epoch: this.epoch, stable: this.stable, openedAt: Date.now(), bytes,
      ranges: this.ranges.map((range) => ({ atStart: range.atStart, chunks: range.chunks.map((chunk) => chunk.first) })) };
  }
}

export function createHistoryCache(backend = indexedDbBackend()) {
  return {
    async open(scope) {
      try { return new CachedSession(scope, await backend.load(scope)); } catch { return new CachedSession(scope, null); }
    },
    async save(session) {
      const meta = session.meta();
      const put = [...session.put.values()];
      const removed = [...session.removed];
      session.put.clear();
      session.removed.clear();
      try {
        await backend.save(meta, put, removed);
        const metas = (await backend.metas()).sort((a, b) => a.openedAt - b.openedAt);
        let total = metas.reduce((sum, item) => sum + (item.bytes || 0), 0);
        for (const item of metas) { // least recently opened Sessions go first
          if (total <= BUDGET_BYTES) break;
          if (item.scope === meta.scope) continue;
          await backend.drop(item.scope);
          total -= item.bytes || 0;
        }
      } catch {}
    },
  };
}
