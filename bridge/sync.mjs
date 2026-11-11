import { post, postRequired, get } from './http.mjs';
import { synced, uploadMessages } from './extract.mjs';
import { parseStorageSessionId, storageSessionId } from './session-identity.mjs';
import { getRuntimeAdapter, runtimeAdapters } from './runtime-registry.mjs';
import { heldForAgents, pendingInteractionDetail, poolAwaitsAgents, poolOwns } from './ws.mjs';
import { rebuildAgentCounts } from './agent-counts.mjs';
import { ObservedMap } from './observed-map.mjs';

const INITIAL_SYNC_WINDOW_MS = 86400_000;

// Startup catalog keys let the watcher distinguish new sessions from resumed ones.
export const recentSessions = new Set();

// Cache of last-known status per sessionId for periodic stopped detection.
// Changes also invalidate the v2 list answers (see session-index.mjs).
export const lastKnownStatus = new ObservedMap();

export function isRecentSession(lastActive, now = Date.now()) {
  return Date.parse(lastActive) >= now - INITIAL_SYNC_WINDOW_MS;
}

function publicSession(session) {
  const { _filePath, _lineCount, _provisional, ...item } = session;
  return item;
}

// Session rows still feed notifications and the Session view until they move to the Bridge.
export async function uploadCatalog(config, sessions, postFn = post) {
  // ~350-800 bytes per session, 5000 is safely under Lambda's 6MB request limit.
  const BATCH = 5000;
  for (let i = 0; i === 0 || i < sessions.length; i += BATCH) {
    await postFn('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      deviceDisplayName: config.deviceDisplayName || config.deviceName,
      os: process.platform,
      sessions: sessions.slice(i, i + BATCH).map(publicSession),
    });
  }
}

export async function syncSessions(config, opts = {}) {
  const now = opts.now ?? Date.now();
  const postFn = opts.postFn || post;
  const messageUploader = opts.messageUploader || uploadMessages;
  const runtimeCatalogs = opts.runtimeCatalogs || {};
  const runtimeOptions = opts.runtimeOptions || {};
  const catalogs = runtimeAdapters.map((adapter) => ({
    adapter,
    catalog: runtimeCatalogs[adapter.runtime] || adapter.discover({
      now,
      ...(runtimeOptions[adapter.runtime] || {}),
    }),
  }));
  const sessions = catalogs.flatMap(({ catalog }) => catalog.sessions);
  rebuildAgentCounts(sessions);

  for (const session of sessions) {
    const sessionKey = storageSessionId(session.runtime, session.nativeSessionId);
    recentSessions.add(sessionKey);
    lastKnownStatus.set(sessionKey, session.status);
  }
  await uploadCatalog(config, sessions, postFn);

  const roots = sessions.filter((session) => !session.parentSessionId);
  const runningCount = roots.filter((s) => (s.activeStatus || s.status) === 'running').length;
  const needsInputCount = roots.filter((s) => (s.activeStatus || s.status) === 'needs_input').length;
  const runtimeCounts = catalogs
    .map(({ adapter, catalog }) => `${adapter.displayName} ${catalog.sessions.length}`)
    .join(', ');
  console.log(`[sync] ${sessions.length} sessions (${runtimeCounts}), ${runningCount} running, ${needsInputCount} needs input`);
  for (const { adapter, catalog } of catalogs) {
    const diagnostics = catalog.diagnostics || {};
    if (diagnostics.errors?.length || diagnostics.malformedLines) {
      console.log(`[sync] ${adapter.displayName} scan: ${diagnostics.files || 0} files, ${diagnostics.malformedLines || 0} malformed lines, ${diagnostics.errors?.length || 0} I/O errors`);
    }
  }

  if (opts.skipMessages) {
    for (const session of sessions) {
      const key = storageSessionId(session.runtime, session.nativeSessionId);
      try {
        getRuntimeAdapter(session.runtime).baselineToEnd(session, {
          storageSessionId: key,
          watermarks: synced,
        });
      } catch {}
    }
    const runtimeDiagnostics = Object.fromEntries(
      catalogs.map(({ adapter, catalog }) => [adapter.runtime, catalog.diagnostics || {}]),
    );
    return { sessions, runtimeDiagnostics, messageCount: 0 };
  }

  const syncJobs = [];
  const queued = new Set();
  let messageCount = 0;

  for (const session of sessions) {
    const sessionKey = storageSessionId(session.runtime, session.nativeSessionId);
    const adapter = getRuntimeAdapter(session.runtime);
    if (queued.has(sessionKey)) continue;
    if (adapter.shouldSkipInitial(session, {
      storageSessionId: sessionKey,
      watermarks: synced,
    })) continue;
    const status = lastKnownStatus.get(sessionKey) || 'completed';
    const isLive = status !== 'completed';
    const isRecent = isRecentSession(session.lastActive, now);
    if (!isLive && !isRecent) continue;
    queued.add(sessionKey);
    syncJobs.push(async () => {
      const { messages } = await adapter.syncInitialMessages(session, {
        storageSessionId: sessionKey,
        watermarks: synced,
        uploader: messageUploader,
      });
      if (messages.length > 0) {
        console.log(`[init] ${adapter.runtime}:${session.nativeSessionId.slice(0, 8)}: ${messages.length} messages (${isLive ? status : 'recent'})`);
      }
      return messages.length;
    });
  }

  if (syncJobs.length > 0) {
    console.log(`[init] syncing ${syncJobs.length} sessions (running/idle + recent 24h)`);
    // Two concurrent extractions bound startup memory for large rollouts.
    const CONCURRENCY = 2;
    let next = 0;
    const inflight = new Set();

    function launch() {
      while (inflight.size < CONCURRENCY && next < syncJobs.length) {
        const idx = next++;
        const p = syncJobs[idx]()
          .then((n) => { messageCount += n; })
          .catch((error) => console.error(`[init] message sync failed: ${error.message}`))
          .finally(() => inflight.delete(p));
        inflight.add(p);
      }
    }

    launch();
    while (inflight.size > 0) {
      await Promise.race(inflight);
      launch();
    }
    if (messageCount > 0) console.log(`[init] ${messageCount} messages synced to DDB`);
  }
  const runtimeDiagnostics = Object.fromEntries(
    catalogs.map(({ adapter, catalog }) => [adapter.runtime, catalog.diagnostics || {}]),
  );
  return { sessions, runtimeDiagnostics, messageCount };
}

// Push runtime-owned status metadata.
export async function updateSessionStatus(
  config,
  sessionId,
  filePath,
  project,
  newStatus,
  detail,
  runtime,
  options = {},
) {
  const identity = parseStorageSessionId(sessionId, runtime);
  return getRuntimeAdapter(identity.runtime).updateSessionStatus(
    config,
    identity.nativeSessionId,
    filePath,
    project,
    newStatus,
    detail,
    {
      lastKnownStatus,
      postFn: postRequired,
      ...options,
    },
  );
}

// Settle stale active rows through runtime status adapters.
export async function checkStopped(config) {
  const active = await get('/api/bridge/active-sessions');
  if (!active || !Array.isArray(active.sessions)) return;

  const updates = [];
  const statusContexts = new Map();

  for (const s of active.sessions) {
    if (s.deviceName !== config.deviceName || !s.sessionId) continue;
    const identity = parseStorageSessionId(s.sessionId, s.runtime);
    if (pendingInteractionDetail(identity.sessionId) !== null) continue;
    const adapter = getRuntimeAdapter(identity.runtime);
    if (!adapter.features.statusPolling) continue;
    if (!statusContexts.has(adapter.runtime)) {
      statusContexts.set(adapter.runtime, adapter.createStatusContext({
        lastKnownStatus,
        poolOwns,
        poolAwaitsAgents,
      }));
    }
    const result = adapter.inspectActiveSession({
      ...s,
      nativeSessionId: identity.nativeSessionId,
    }, statusContexts.get(adapter.runtime));
    if (!result) continue;
    if (adapter.runtime === 'claude') heldForAgents.set(identity.sessionId, !!result.session.backgroundAgents);
    updates.push(result.session, ...(result.extraSessions || []));
  }

  if (updates.length > 0) {
    await post('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: updates.map(publicSession),
    });
  }
}
