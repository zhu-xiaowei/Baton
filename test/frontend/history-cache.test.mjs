// The App's history cache against a fake Bridge: holes, cursors past the cache, concurrent loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { configureHistory, loadLatestHistory, loadOlderHistory } from '../../web/js/v2/history.js';
import { createHistoryCache, memoryBackend } from '../../web/js/v2/history-cache.js';

const key = (n) => `O2#${String(n).padStart(12, '0')}#0000`;
const row = (n) => ({ uuid: `u${n}`, type: 'user', content: `r${n}`, orderKey: key(n) });
const line = (k) => Number(k.split('#')[1]);
// A Bridge over rows 1..count; `stable` is the stableCursor it reports (default: the last row).
function bridge() {
  const b = { count: 0, stable: null, epoch: 'e', hold: null };
  b.send = async (device, method, params) => {
    const hold = b.hold; // the reply is read from the file as it is now, delivered after `hold`
    const reply = b.read(params);
    if (hold) await hold;
    return reply;
  };
  b.read = (params) => {
    const past = (cursor) => cursor && line(cursor) > b.count;
    if ((params.epoch && params.epoch !== b.epoch) || past(params.after) || past(params.before)) {
      return { ...b.read({ limit: params.limit }), historyReset: true };
    }
    const hi = params.before ? line(params.before) - 1 : b.count;
    const lo = params.after ? line(params.after) + 1 : 1;
    const limit = params.limit || 200;
    const from = Math.max(lo, hi - limit + 1);
    const messages = []; for (let n = from; n <= hi; n++) messages.push(row(n));
    return { messages, hasMore: from > lo, epoch: b.epoch, ...(params.before ? {} : { stableCursor: b.stable || key(b.count) }) };
  };
  return b;
}
const all = async (device, sessionId) => {
  let page = await loadLatestHistory({ device, sessionId });
  let rows = page.messages;
  while (page.hasMore) { page = await loadOlderHistory({ device, sessionId, before: page.oldestTimestamp }); rows = page.messages.concat(rows); }
  return rows.map((r) => line(r.orderKey));
};
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

test('a chunk deleted under the cache record (eviction, another window) starts the Session over', async () => {
  const b = bridge(); const backend = memoryBackend();
  b.count = 50; configureHistory({ store: createHistoryCache(backend), send: b.send });
  await loadLatestHistory({ device: 'd', sessionId: 's' });
  await backend.drop((await backend.metas())[0].scope); // evicted while still open in this run
  b.count = 55; await loadLatestHistory({ device: 'd', sessionId: 's' });
  configureHistory({ store: createHistoryCache(backend), send: b.send }); // App restart
  assert.deepEqual(await all('d', 's'), range(1, 55));
});

test('a stable cursor older than the newest cached rows keeps the rows before it reachable', async () => {
  const b = bridge(); const store = createHistoryCache(memoryBackend());
  b.count = 100; configureHistory({ store, send: b.send });
  await loadLatestHistory({ device: 'd', sessionId: 's' }); // rows 1..100 cached, stable 100
  b.count = 350; b.stable = key(150); // a running turn started after row 150
  await loadLatestHistory({ device: 'd', sessionId: 's' }); // newest 200 (151..350) after a gap
  b.count = 350;
  configureHistory({ store, send: b.send });
  assert.deepEqual(await all('d', 's'), range(1, 350));
});

test('a gap fill that comes back after a reset does not touch the new ranges', async () => {
  const b = bridge(); const store = createHistoryCache(memoryBackend());
  configureHistory({ store, send: b.send });
  b.count = 100; await loadLatestHistory({ device: 'd', sessionId: 's' });
  b.count = 500; const page = await loadLatestHistory({ device: 'd', sessionId: 's' }); // 301..500 after a gap
  let release; b.hold = new Promise((r) => { release = r; });
  const fill = loadOlderHistory({ device: 'd', sessionId: 's', before: page.oldestTimestamp });
  await new Promise((r) => setTimeout(r, 0)); // the gap fill is on its way
  b.hold = null; b.epoch = 'replaced'; b.count = 30; // the file is replaced meanwhile
  await loadLatestHistory({ device: 'd', sessionId: 's' });
  release();
  assert.equal((await fill).historyReset, true);
  configureHistory({ store, send: b.send }); // App restart
  assert.deepEqual(await all('d', 's'), range(1, 30));
});
