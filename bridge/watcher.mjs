import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS, CLAUDE_JOBS, VALID_TYPES, NEEDS_POLLING, AGENTS_POLL_INTERVAL_MS } from './config.mjs';
import { post } from './http.mjs';
import { synced, extractForApp, uploadMessages } from './extract.mjs';
import { deliverRealtimeMessages } from './realtime-delivery.mjs';
import { clearLiveMessage } from './live-message-registry.mjs';
import { getSessionMetadata, readableProjectName, statusFromEntry, resolveStatus, getSessionStatus, getRunningInfo, getDaemonSessions, getDaemonRunningSessionIds, findSessionFile, getAgentsJson, normalizeProjectHash } from './session.mjs';
import { recentSessions, lastKnownStatus, knownProjects, reconcile } from './sync.mjs';
import {
  headlessRoute,
  pendingInteractionDetail,
  poolOwns,
} from './ws.mjs';
import { defineRuntimeWatcher } from './watcher-adapter.mjs';

const _metaUuids = new Set(); // track isMeta message UUIDs to skip their replies

export function shouldPersistClaudeJsonlMessage(runtimeOwned, route) {
  return !!runtimeOwned || !!route?.pushed || !!route?.runtimeOwned;
}

export function startWatcher(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const busy = new Map(); // sessionId → { pending }
  const retries = new Map();

  if (NEEDS_POLLING) {
    // WSL2: inotify doesn't work on /mnt/ (9P filesystem), use polling
    const mtimes = new Map(); // filePath → mtimeMs
    console.log('[watcher] WSL detected, using polling (2s interval)');
    setInterval(() => pollProjects(config, busy, mtimes, retries), 2000);
  } else {
    fs.watch(CLAUDE_PROJECTS, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith('.jsonl')) return;
      if (filename.includes('subagents')) return;
      const sessionId = path.basename(filename, '.jsonl');

      const state = busy.get(sessionId);
      if (state) { state.pending = true; return; }
      busy.set(sessionId, { pending: false });
      processClaudeLoop(config, busy, retries, filename, sessionId);
    });
  }
}

export function preferPendingInteraction(status, detail) {
  return detail === null
    ? { status, detail: null }
    : { status: 'needs_input', detail };
}

async function processClaudeLoop(config, busy, retries, filename, sessionId) {
  const state = busy.get(sessionId);
  try {
    do {
      state.pending = false;
      await readAndSend(config, filename, sessionId);
    } while (state.pending);
    clearTimeout(retries.get(sessionId));
    retries.delete(sessionId);
  } catch (error) {
    console.error(`[watcher] Claude ${sessionId.slice(0, 8)}: ${error.message}`);
    if (!retries.has(sessionId)) {
      const timer = setTimeout(() => {
        retries.delete(sessionId);
        if (busy.has(sessionId)) return;
        busy.set(sessionId, { pending: false });
        processClaudeLoop(config, busy, retries, filename, sessionId);
      }, 1000);
      timer.unref();
      retries.set(sessionId, timer);
    }
  }
  busy.delete(sessionId);
}

function pollProjects(config, busy, mtimes, retries) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  try {
    for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
      const projectDir = path.join(CLAUDE_PROJECTS, project);
      try { if (!fs.statSync(projectDir).isDirectory()) continue; } catch { continue; }
      for (const file of fs.readdirSync(projectDir)) {
        if (!file.endsWith('.jsonl') || file.startsWith('.')) continue;
        const filePath = path.join(projectDir, file);
        try {
          const mtime = fs.statSync(filePath).mtimeMs;
          const prev = mtimes.get(filePath);
          if (prev === mtime) continue;
          mtimes.set(filePath, mtime);
          if (prev === undefined) continue; // first scan, don't trigger

          const filename = path.join(project, file);
          const sessionId = path.basename(file, '.jsonl');
          const state = busy.get(sessionId);
          if (state) { state.pending = true; continue; }
          busy.set(sessionId, { pending: false });
          processClaudeLoop(config, busy, retries, filename, sessionId);
        } catch {}
      }
    }
  } catch {}
}

async function readAndSend(config, filename, sessionId) {
  const filePath = path.join(CLAUDE_PROJECTS, filename);
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const lastLine = synced.get(sessionId) ?? 0;
  if (lines.length <= lastLine) return;

  let lastParsedLine = lastLine;
  let gotNewTitle = false;
  let lastStatus = null; // track status from parsed entries directly

  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) { lastParsedLine = i + 1; continue; }
    let raw;
    try { raw = JSON.parse(lines[i]); } catch { break; }
    lastParsedLine = i + 1;

    // Track status from every parsed entry (statusFromEntry returns null for non-status types).
    const s = statusFromEntry(raw);
    if (s) lastStatus = s;

    if (!VALID_TYPES.has(raw.type)) continue;
    // Skip isMeta user messages (VS Code replay duplicates), but keep their assistant replies
    if (raw.isMeta && raw.type === 'user') { _metaUuids.add(raw.uuid); continue; }
    if (raw.type === 'user' && raw.parentUuid && _metaUuids.has(raw.parentUuid)) { _metaUuids.delete(raw.parentUuid); continue; }
    if (raw.type === 'ai-title' || raw.type === 'custom-title' || raw.type === 'last-prompt') gotNewTitle = true;

    const msg = await extractForApp(raw);
    if (!msg.uuid) continue;

    // A managed headless turn is the sole realtime source. Its JSONL copy only
    // persists; terminal/VS Code rows have no runtime ownership and still broadcast.
    const route = headlessRoute(msg.uuid);
    if (shouldPersistClaudeJsonlMessage(poolOwns(sessionId), route)) {
      await uploadMessages(sessionId, [msg]);
      clearLiveMessage('claude', msg.uuid);
      continue;
    }
    await deliverRealtimeMessages(sessionId, [msg]);
  }

  synced.set(sessionId, lastParsedLine);

  // Sync metadata only when status changed, new session, or ai-title arrived
  if (lastParsedLine > lastLine && (lastStatus || gotNewTitle)) {
    // Pool-owned → status comes from headless lifecycle events (updateSessionStatus carries
    // isAgent), not jsonl/daemon. Title metadata can still pass through while the pool
    // owns status, so list previews stay aligned with the open session title.
    const poolOwned = poolOwns(sessionId);
    if (poolOwned && !gotNewTitle) return;
    // Agent identity is permanent — never downgrade (a false isAgent put-overwrites the DDB flag).
    const dm = getDaemonSessions().get(sessionId);
    // Only roster-active agents trust daemon state; inactive agents use this jsonl update.
    const daemonActive = !poolOwned && dm && getDaemonRunningSessionIds().has(sessionId);
    const resolvedStatus = poolOwned ? 'running'
      : daemonActive ? dm.status
      : lastStatus ? resolveStatus(sessionId, lastStatus)
      : getSessionStatus(sessionId, filePath, getRunningInfo());
    const effective = preferPendingInteraction(
      resolvedStatus,
      pendingInteractionDetail(sessionId),
    );
    const agentMeta = dm && !daemonActive ? { ...dm, agentDetail: '' } : dm;
    await postSessionMeta(
      config,
      filePath,
      filename,
      sessionId,
      effective.status,
      agentMeta,
      gotNewTitle,
      effective.detail,
    );
    // Trailing edge: content settled but debounce held it 'running'. No more
    // writes will fire fs.watch, so re-evaluate once after debounce expires.
    if (!poolOwned && !daemonActive && lastStatus && effective.detail === null && lastStatus !== 'running' && effective.status === 'running') {
      scheduleRecheck(config, filePath, filename, sessionId);
    }
  }
}

// Post session metadata + counter delta when status changed, is new, or title arrived.
async function postSessionMeta(
  config,
  filePath,
  filename,
  sessionId,
  newStatus,
  dm,
  gotNewTitle,
  interactionDetail = null,
) {
  const oldStatus = lastKnownStatus.get(sessionId);
  const statusChanged = newStatus !== oldStatus;
  const isNew = !recentSessions.has(sessionId);

  // Skip empty-shell sessions (e.g. /clear: metadata only, no preview, not running).
  const metadata = getSessionMetadata(filePath);
  const preview = metadata.preview;
  if (!preview && newStatus !== 'running' && !dm) return;
  if (!(statusChanged || isNew || gotNewTitle)) return;

  const stat = fs.statSync(filePath);
  const projectHash = normalizeProjectHash(path.basename(path.dirname(filename)));
  lastKnownStatus.set(sessionId, newStatus);
  // Counter delta — server uses this to ADD/SUBTRACT counters; 'new' means += 1.
  const statusDelta = (statusChanged || isNew) ? {
    deviceName: config.deviceName,
    projectHash,
    from: isNew && oldStatus === undefined ? 'new' : (oldStatus || 'completed'),
    to: newStatus,
    projectName: readableProjectName(projectHash),
    lastActive: stat.mtime.toISOString(),
  } : null;
  const sessionMeta = {
    id: sessionId,
    project: projectHash,
    projectName: readableProjectName(projectHash),
    lastActive: stat.mtime.toISOString(),
    size: stat.size,
    preview: preview || 'New session',
    model: metadata.model,
    status: newStatus,
  };
  if (dm) {
    sessionMeta.isAgent = true;
    sessionMeta.agentName = dm.agentName;
    sessionMeta.agentDetail = dm.agentDetail;
  }
  if (newStatus === 'needs_input' && interactionDetail !== null) {
    sessionMeta.agentDetail = interactionDetail;
  }
  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [sessionMeta],
    ...(statusDelta ? { statusDelta } : {}),
  });
  recentSessions.add(sessionId);
  // First session of a brand-new project → recount totals so projectCount stays accurate.
  if (!knownProjects.has(projectHash)) {
    knownProjects.add(projectHash);
    reconcile(config);
  }
}

const _recheckTimers = new Map(); // sessionId → timeout, reset on new activity
const RECHECK_DELAY_MS = 11_000;   // just past resolveStatus's 10s running debounce

function scheduleRecheck(config, filePath, filename, sessionId) {
  clearTimeout(_recheckTimers.get(sessionId));
  _recheckTimers.set(sessionId, setTimeout(async () => {
    _recheckTimers.delete(sessionId);
    if (!fs.existsSync(filePath)) return;
    const effective = preferPendingInteraction(
      getSessionStatus(sessionId, filePath, getRunningInfo()),
      pendingInteractionDetail(sessionId),
    );
    await postSessionMeta(
      config,
      filePath,
      filename,
      sessionId,
      effective.status,
      null,
      false,
      effective.detail,
    );
  }, RECHECK_DELAY_MS));
}

const _jobsState = new Map(); // sessionId → { agentName, agentDetail, status }

// state.json is stale (the daemon computes state live but doesn't flush it
// promptly), so fs.watch on it misses transitions. Poll `claude agents --json`
// instead — the daemon-live source — and push any agent whose state changed.
export function startJobsWatcher(config) {
  if (!fs.existsSync(CLAUDE_JOBS)) return;
  // No seed: the first poll pushes every agent once, so DDB gets correct agent
  // flags/state even for sessions the initial full sync didn't cover (it only
  // syncs running/idle + recent 24h, missing older blocked/working agents).
  pollAgentStates(config);
  setInterval(() => pollAgentStates(config), AGENTS_POLL_INTERVAL_MS);
}

async function pollAgentStates(config) {
  let agents;
  try { agents = getAgentsJson(true); } catch { return; }
  for (const [sid, e] of agents) {
    const filePath = findSessionFile(sid);
    if (!filePath) continue;
    // Pool-owned = driven live by headless; skip so the daemon's stale 'done' doesn't override its running.
    if (poolOwns(sid)) continue;
    // Title: --json name first, then the jsonl's first user message. At launch
    // both can be empty for a poll or two (name not inferred yet, jsonl not
    // written), so preview is part of the diff — a title arriving later re-pushes.
    const metadata = getSessionMetadata(filePath);
    const preview = e.agentName || metadata.preview || 'Agent session';
    const old = _jobsState.get(sid);
    if (old && old.agentName === e.agentName && old.agentDetail === e.agentDetail && old.status === e.status && old.preview === preview) continue;
    _jobsState.set(sid, { ...e, preview });
    await pushAgentMeta(config, sid, e, filePath, preview, metadata.model);
  }
}

async function pushAgentMeta(config, sessionId, e, filePath, preview, model) {
  const projectHash = normalizeProjectHash(path.basename(path.dirname(filePath)));
  const stat = fs.statSync(filePath);
  lastKnownStatus.set(sessionId, e.status);
  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [{
      id: sessionId,
      project: projectHash,
      projectName: readableProjectName(projectHash),
      lastActive: stat.mtime.toISOString(),
      size: stat.size,
      preview,
      model,
      status: e.status,
      isAgent: true,
      agentName: e.agentName,
      agentDetail: e.agentDetail,
    }],
  });
}

export const claudeWatcherAdapter = defineRuntimeWatcher({
  runtime: 'claude',
  start: startWatcher,
});
