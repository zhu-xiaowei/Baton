import { synced } from './extract.mjs';
import { parseStorageSessionId, storageSessionId } from './session-identity.mjs';
import { getRuntimeAdapter, runtimeAdapters } from './runtime-registry.mjs';
import { heldForAgents, pendingInteractionDetail, poolAwaitsAgents, poolOwns } from './ws.mjs';
import { rebuildAgentCounts } from './agent-counts.mjs';
import { ObservedMap } from './observed-map.mjs';
import { observeSessions } from './notify.mjs';
import { parseClaudeSubagentSessionId } from './claude-subagent.mjs';
import { sessionIndex } from './session-index.mjs';

// Startup catalog keys let the watcher distinguish new sessions from resumed ones.
export const recentSessions = new Set();

// Cache of last-known status per sessionId for periodic stopped detection.
// Changes also invalidate the v2 list answers (see session-index.mjs).
export const lastKnownStatus = new ObservedMap();

function publicSession(session) {
  const { _filePath, _lineCount, _provisional, ...item } = session;
  return item;
}

// Every Session row the runtimes derive ends here: the status cache and the notifier.
export function reportSessions(config, sessions, extra = {}) {
  const body = {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: sessions.map(publicSession),
    ...(extra.agentCountUpdates?.length ? { agentCountUpdates: extra.agentCountUpdates } : {}),
  };
  for (const session of body.sessions) {
    lastKnownStatus.set(storageSessionId(session.runtime, session.nativeSessionId || session.id), session.status);
  }
  observeSessions(body);
}

export function syncSessions(config, opts = {}) {
  const now = opts.now ?? Date.now();
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
    // Watchers push only what is written from now on; history is read from the files on demand.
    try {
      getRuntimeAdapter(session.runtime).baselineToEnd(session, { storageSessionId: sessionKey, watermarks: synced });
    } catch {}
  }
  reportSessions(config, sessions);

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
  const runtimeDiagnostics = Object.fromEntries(
    catalogs.map(({ adapter, catalog }) => [adapter.runtime, catalog.diagnostics || {}]),
  );
  return { sessions, runtimeDiagnostics };
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
      report: reportSessions,
      ...options,
    },
  );
}

// Settle active root Sessions whose process went away.
export function checkStopped(config, index = sessionIndex) {
  const roots = new Map(index.catalog().roots.map((row) => [row.sessionId, row]));
  const updates = [];
  const statusContexts = new Map();

  for (const [sessionId, status] of [...lastKnownStatus]) {
    if (status !== 'running' && status !== 'needs_input') continue;
    const identity = parseStorageSessionId(sessionId);
    if (pendingInteractionDetail(identity.sessionId) !== null) continue;
    const adapter = getRuntimeAdapter(identity.runtime);
    if (!adapter.features.statusPolling) continue;
    const row = roots.get(identity.sessionId);
    // Children settle with their root; a root without a row is checked only once its file is gone.
    if (!row && (parseClaudeSubagentSessionId(identity.nativeSessionId)
      || adapter.findSessionFile(identity.nativeSessionId))) continue;
    if (!statusContexts.has(adapter.runtime)) {
      statusContexts.set(adapter.runtime, adapter.createStatusContext({ poolOwns, poolAwaitsAgents }));
    }
    const result = adapter.inspectActiveSession({
      sessionId: identity.sessionId,
      nativeSessionId: identity.nativeSessionId,
      runtime: identity.runtime,
      status,
      projectHash: row?.project || '',
      preview: row?.preview || '',
      lastActive: row ? new Date(row.ms).toISOString() : '',
    }, statusContexts.get(adapter.runtime));
    if (!result) continue;
    if (adapter.runtime === 'claude') heldForAgents.set(identity.sessionId, !!result.session.backgroundAgents);
    updates.push(result.session, ...(result.extraSessions || []));
  }

  if (updates.length > 0) reportSessions(config, updates);
}
