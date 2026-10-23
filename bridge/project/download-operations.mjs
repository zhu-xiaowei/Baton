const HISTORY_TTL = 60_000;
const HISTORY_LIMIT = 256;
const PREPARE_TIMEOUT = 5 * 60_000;

export function createDownloadOperations({ now = Date.now, timeout = PREPARE_TIMEOUT } = {}) {
  const entries = new Map();
  const key = (owner, token) => {
    if (typeof owner !== 'string' || !owner || typeof token !== 'string'
      || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(token)) {
      throw new Error('Invalid download owner or token');
    }
    return JSON.stringify([owner, token]);
  };
  function prune() {
    for (const [id, entry] of entries) {
      if (entry.finished && now() - entry.at >= HISTORY_TTL) entries.delete(id);
    }
    const history = [...entries].filter(([, entry]) => entry.finished);
    for (const [id] of history.slice(0, Math.max(0, history.length - HISTORY_LIMIT))) entries.delete(id);
  }
  return {
    begin(owner, token) {
      const id = key(owner, token);
      prune();
      const previous = entries.get(id);
      if (previous?.cancelled) throw new DOMException('Download cancelled', 'AbortError');
      if (previous) throw new Error('Download token has already been used');
      const controller = new AbortController();
      let resolve;
      const entry = { controller, done: new Promise(done => { resolve = done; }), finished: false };
      entries.set(id, entry);
      const timer = setTimeout(() => controller.abort(new Error('File preparation timed out')), timeout);
      timer.unref?.();
      return {
        signal: controller.signal,
        finish() {
          if (entry.finished) return;
          clearTimeout(timer);
          entry.finished = true;
          entry.cancelled = controller.signal.aborted;
          entry.at = now();
          resolve();
          prune();
        },
      };
    },
    async cancel(owner, token) {
      const id = key(owner, token);
      prune();
      let entry = entries.get(id);
      if (!entry) {
        entry = { finished: true, cancelled: true, at: now() };
        entries.set(id, entry);
        prune();
      } else if (!entry.finished) {
        entry.controller.abort(new DOMException('Download cancelled', 'AbortError'));
        await entry.done;
      }
      return { status: entry.cancelled ? 'cancelled' : 'completed' };
    },
  };
}
