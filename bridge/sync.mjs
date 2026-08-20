import { post, postRequired, get } from './http.mjs';
import { synced, uploadMessages } from './extract.mjs';
import { parseStorageSessionId, storageSessionId } from './session-identity.mjs';
import {
  detectRegisteredRuntimeCapabilities,
  getRuntimeAdapter,
  runtimeAdapters,
} from './runtime-registry.mjs';
import { pendingInteractionDetail, poolOwns } from './ws.mjs';

const INITIAL_SYNC_WINDOW_MS = 86400_000;

// Startup catalog keys let the watcher distinguish new sessions from resumed ones.
export const recentSessions = new Set();

// Cache of last-known status per sessionId for periodic stopped detection
export const lastKnownStatus = new Map();

// Seeded project hashes keep the watcher from reconciling existing projects.
export const knownProjects = new Set();

export function buildCatalogAggregates(sessions, runtimeCapabilities = {}) {
  const projects = new Map();
  let deviceLastActive = '';
  let runningCount = 0;
  let idleCount = 0;
  for (const s of sessions) {
    if (s.lastActive > deviceLastActive) deviceLastActive = s.lastActive;
    if (s.status === 'running') runningCount++;
    else if (s.status === 'needs_input') idleCount++;
    let p = projects.get(s.project);
    if (!p) {
      p = {
        projectHash: s.project,
        projectName: s.projectName || s.project,
        sessionCount: 0, runningCount: 0, idleCount: 0,
        lastActive: '',
      };
      projects.set(s.project, p);
    }
    p.sessionCount++;
    // idleCount stores needs_input for the existing DDB field.
    if (s.status === 'running') p.runningCount++;
    else if (s.status === 'needs_input') p.idleCount++;
    if (s.lastActive > p.lastActive) p.lastActive = s.lastActive;
  }
  const projectAggregates = Array.from(projects.values());
  const deviceAggregate = {
    sessionCount: sessions.length,
    projectCount: projectAggregates.length,
    runningCount,
    idleCount,
    lastActive: deviceLastActive,
    runtimeCapabilities,
  };
  return { deviceAggregate, projectAggregates };
}

export function isRecentSession(lastActive, now = Date.now()) {
  return Date.parse(lastActive) >= now - INITIAL_SYNC_WINDOW_MS;
}

function publicSession(session) {
  const { _filePath, _lineCount, ...item } = session;
  return item;
}

export async function uploadCatalog(config, sessions, aggregates, catalogComplete, postFn = post) {
  // ~350-800 bytes per session, 5000 is safely under Lambda's 6MB request limit.
  const BATCH = 5000;
  for (let i = 0; i < sessions.length; i += BATCH) {
    const body = {
      deviceName: config.deviceName,
      deviceDisplayName: config.deviceDisplayName || config.deviceName,
      os: process.platform,
      sessions: sessions.slice(i, i + BATCH).map(publicSession),
      catalogComplete,
    };
    if (i === 0) {
      body.device = aggregates.deviceAggregate;
      body.projects = aggregates.projectAggregates;
    }
    await postFn('/api/bridge/sync-sessions', body);
  }
  if (sessions.length === 0) {
    const body = {
      deviceName: config.deviceName,
      deviceDisplayName: config.deviceDisplayName || config.deviceName,
      os: process.platform,
      sessions: [],
      catalogComplete,
    };
    body.device = aggregates.deviceAggregate;
    body.projects = aggregates.projectAggregates;
    await postFn('/api/bridge/sync-sessions', body);
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
  const catalogComplete = catalogs.every(({ catalog }) => catalog.complete);
  const runtimeCapabilities = opts.runtimeCapabilities
    || detectRegisteredRuntimeCapabilities(runtimeOptions);
  const aggregates = buildCatalogAggregates(sessions, runtimeCapabilities);

  for (const session of sessions) {
    const sessionKey = storageSessionId(session.runtime, session.nativeSessionId);
    recentSessions.add(sessionKey);
    lastKnownStatus.set(sessionKey, session.status);
    knownProjects.add(session.project);
  }

  if (!catalogComplete) {
    console.error('[sync] discovery incomplete; server will preserve existing DEV/PROJ aggregates');
  }
  await uploadCatalog(config, sessions, aggregates, catalogComplete, postFn);

  const { runningCount, idleCount: needsInputCount } = aggregates.deviceAggregate;
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
    return {
      catalogComplete,
      sessions,
      runtimeDiagnostics,
      messageCount: 0,
    };
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
  return {
    catalogComplete,
    sessions,
    runtimeDiagnostics,
    messageCount,
  };
}

// Recount DEV/PROJ aggregates from DDB session rows.
export async function reconcile(config) {
  try { await post('/api/bridge/reconcile', { deviceName: config.deviceName, os: process.platform }); }
  catch {}
}

// Push runtime-owned status metadata and counter deltas.
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
  const statusDeltas = [];
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
      }));
    }
    const result = adapter.inspectActiveSession({
      ...s,
      nativeSessionId: identity.nativeSessionId,
    }, statusContexts.get(adapter.runtime));
    if (!result) continue;
    updates.push(result.session);
    statusDeltas.push(result.statusDelta);
  }

  if (updates.length > 0) {
    await post('/api/bridge/sync-sessions', {
      deviceName: config.deviceName, os: process.platform, sessions: updates, statusDeltas,
    });
  }
}
