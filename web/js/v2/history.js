// Session history from the Bridge (`history` RPC) through the IndexedDB cache. Both calls answer in
// the former /messages shape, so the Session view keeps its merge and render logic.
import { state } from '../state.js';
import { request as requestBridge, subscribed } from './direct-transport.js';
import { createHistoryCache } from './history-cache.js';

const PAGE = 200;
let cache = null;
let sendRequest = requestBridge;
const open = new Map(); // scope → CachedSession of Sessions opened in this App run

export function configureHistory({ store, send } = {}) {
  cache = store || null;
  if (send) sendRequest = send;
  open.clear();
}

const scopeOf = (device, sessionId) => `${state.SERVER}|${state.KEY}|${device}|${sessionId}`;

async function session(device, sessionId) {
  const scope = scopeOf(device, sessionId);
  if (!open.has(scope)) {
    cache ||= createHistoryCache();
    open.set(scope, await cache.open(scope));
  }
  return open.get(scope);
}

function shown(entry) {
  const range = entry.newest;
  const rows = range ? entry.rows(range).slice(-PAGE) : [];
  const more = !!range && (entry.rows(range).length > rows.length || !range.atStart || entry.ranges.length > 1);
  return { rows, more };
}

// Latest page: only what is newer than the cache's stable cursor is asked for. `onSlow(page | null)`
// runs once at 6 s with the cached page (null without one); the promise still settles later. When the
// Bridge fails, a cached page is returned with `failed` instead of an error.
// `subscribe` also registers the caller for the Session's pushes (under the thread `root`), before
// the Bridge reads the file.
export async function loadLatestHistory({ device, sessionId, subscribe, root, onSlow: notify }) {
  const entry = await session(device, sessionId);
  const cursor = entry.stable;
  const params = { sessionId, ...(cursor ? { after: cursor, epoch: entry.epoch } : {}),
    ...(subscribe ? { subscribe: true, ...(root ? { rootSessionId: root } : {}) } : {}) };
  const cachedPage = () => {
    const { rows, more } = shown(entry);
    return rows.length ? { messages: rows, hasMore: more, oldestTimestamp: rows[0].orderKey } : null;
  };
  let reply;
  try {
    reply = await sendRequest(device, 'history', params, { onSlow: () => notify?.(cachedPage()) });
  } catch (error) {
    // A new Session has no transcript yet (a deleted one none any more): its history is empty.
    if (error.message === 'unknown_session') return { messages: [], hasMore: false, oldestTimestamp: '', status: '', titles: [] };
    const page = cachedPage();
    if (!page) throw error;
    return { ...page, status: '', titles: [], failed: error.message };
  }
  if (reply.bridgeEpoch) subscribed(device, sessionId, reply.bridgeEpoch);
  if (!cursor || reply.historyReset) {
    entry.reset();
    entry.append(reply.messages, { atStart: !reply.hasMore });
  } else {
    entry.trimNewest(cursor);
    // A gap until scrolled: more than a page is newer, or the cursor lies past the cached rows.
    const last = entry.newest && entry.rows(entry.newest).at(-1)?.orderKey;
    entry.append(reply.messages, { gap: reply.hasMore || (!!last && last < cursor) });
  }
  if (reply.stableCursor !== undefined) entry.stable = reply.stableCursor;
  entry.epoch = reply.epoch || entry.epoch;
  await cache.save(entry);
  const { rows, more } = shown(entry);
  return { messages: rows, hasMore: more, oldestTimestamp: rows[0]?.orderKey || '', status: reply.status || '',
    titles: reply.titles || [], ...(reply.historyReset ? { historyReset: true } : {}),
    ...(reply.agentCount !== undefined ? { agentCount: reply.agentCount } : {}), ...(reply.sentPrompt ? { sentPrompt: reply.sentPrompt } : {}),
    ...(reply.preview ? { preview: reply.preview } : {}),
    ...(reply.canSend === false ? { canSend: false } : {}) };
}

// The page before `before`: from the cache while it has the rows, else from the Bridge (filling a gap
// between two cached ranges when there is one).
export async function loadOlderHistory({ device, sessionId, before }) {
  const entry = await session(device, sessionId);
  const at = entry.ranges.findIndex((range) => entry.rows(range).some((row) => row.orderKey === before));
  if (at === -1) return { messages: [], hasMore: false, oldestTimestamp: '', historyReset: true };
  const range = entry.ranges[at];
  const rows = entry.rows(range);
  const index = rows.findIndex((row) => row.orderKey === before);
  const older = at > 0 ? entry.ranges[at - 1] : null;
  if (index > 0) {
    const page = rows.slice(Math.max(0, index - PAGE), index);
    return { messages: page, hasMore: index > PAGE || !range.atStart || !!older, oldestTimestamp: page[0].orderKey };
  }
  if (!older && range.atStart) return { messages: [], hasMore: false, oldestTimestamp: '' };
  const after = older ? entry.rows(older).at(-1).orderKey : undefined;
  const reply = await sendRequest(device, 'history', { sessionId, before, ...(after ? { after } : {}), epoch: entry.epoch, limit: PAGE });
  // A latest load may have replaced these ranges meanwhile: start over from the latest page.
  if (!entry.ranges.includes(range) || (older && !entry.ranges.includes(older))) {
    return { messages: [], hasMore: false, oldestTimestamp: '', historyReset: true };
  }
  if (reply.historyReset) {
    entry.reset();
    await cache.save(entry);
    return { messages: [], hasMore: false, oldestTimestamp: '', historyReset: true };
  }
  entry.prepend(range, reply.messages, !older && !reply.hasMore);
  if (older && !reply.hasMore) entry.join(older, range); // the gap is closed
  await cache.save(entry);
  const page = reply.messages;
  if (!page.length && older && !reply.hasMore) return loadOlderHistory({ device, sessionId, before });
  return { messages: page, hasMore: reply.hasMore || !!older, oldestTimestamp: page[0]?.orderKey || '' };
}
