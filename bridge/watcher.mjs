import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS, CLAUDE_JOBS, VALID_TYPES, NEEDS_POLLING, AGENTS_POLL_INTERVAL_MS } from './config.mjs';
import { post, postRequired } from './http.mjs';
import {
  synced,
  extractForApp,
  isClaudeLocalCommandCaveat,
  normalizeClaudeQueuedInput,
  nativeOrderKey,
  uploadMessages,
} from './extract.mjs';
import { deliverRealtimeMessages } from './realtime-delivery.mjs';
import {
  clearClaudeInterruptTurn,
  clearLiveMessage,
  pendingClaudeInterruptTurn,
} from './live-message-registry.mjs';
import { getSessionMetadata, readableProjectName, statusFromEntry, getSessionStatus, getRunningInfo, getDaemonSessions, getDaemonRunningSessionIds, findSessionFile, getAgentsJson, normalizeProjectHash } from './session.mjs';
import { recentSessions, lastKnownStatus, knownProjects, reconcile } from './sync.mjs';
import { exposeToResumePicker } from './jsonl.mjs';
import {
  headlessRoute,
  pendingInteractionDetail,
  poolOwns,
} from './ws.mjs';
import { defineRuntimeWatcher } from './watcher-adapter.mjs';
import { trackAgentSession } from './agent-counts.mjs';
import {
  claudeSubagentParentSessionId,
  claudeSubagentSessionId,
  readClaudeSubagentMeta,
} from './claude-subagent.mjs';
import {
  activitySyncDue,
  markActivitySynced,
} from './session-activity.mjs';

const _metaUuids = new Set(); // track isMeta message UUIDs to skip their replies
const _lastActivitySyncAt = new Map();
// Preserve child changes that arrive while the first parent POST is in flight.
const _subagentParents = new Map();
const CLAUDE_INTERRUPT_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

export function shouldPersistClaudeJsonlMessage(runtimeOwned, route) {
  return !!runtimeOwned || !!route?.pushed || !!route?.runtimeOwned;
}

export function correlateClaudeInterruptMessage(
  sessionId,
  message,
  now = Date.now(),
) {
  if (message?.type !== 'user'
    || !Array.isArray(message.content)
    || message.content.length !== 1
    || message.content[0]?.type !== 'text'
    || !CLAUDE_INTERRUPT_TEXTS.has(message.content[0].text)) {
    return message;
  }
  const turnId = pendingClaudeInterruptTurn(sessionId, now);
  if (!turnId) return message;
  return {
    ...message,
    nativeId: `live:interrupt:${turnId}`,
    turnId,
  };
}

export function shouldSkipClaudeSession(preview, daemonMeta) {
  return !preview && !daemonMeta;
}

export function exposeKnownClaudeSession(filePath, sessionId) {
  if (!filePath || !recentSessions.has(sessionId)) return false;
  try {
    return exposeToResumePicker(filePath);
  } catch (error) {
    console.warn(`[watcher] could not expose ${sessionId} to /resume: ${error.message}`);
    return false;
  }
}

export function startWatcher(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const enqueue = createClaudeFileQueue(config);

  if (NEEDS_POLLING) {
    // WSL2: inotify doesn't work on /mnt/ (9P filesystem), use polling
    const mtimes = new Map(); // filePath → mtimeMs
    console.log('[watcher] WSL detected, using polling (2s interval)');
    return setInterval(() => pollProjects(enqueue, mtimes), 2000);
  } else {
    return fs.watch(CLAUDE_PROJECTS, { recursive: true }, (_event, filename) => {
      if (filename?.endsWith('.meta.json') && String(filename).split(path.sep).includes('subagents')) {
        filename = filename.replace(/\.meta\.json$/, '.jsonl');
      }
      if (!filename?.endsWith('.jsonl')) return;
      const parts = String(filename).split(path.sep);
      const subagentIndex = parts.indexOf('subagents');
      const sessionId = subagentIndex >= 2
        ? claudeSubagentSessionId(
          parts[subagentIndex - 1],
          path.basename(filename, '.jsonl'),
        )
        : path.basename(filename, '.jsonl');

      enqueue(filename, sessionId);
    });
  }
}

export function preferPendingInteraction(status, detail) {
  return detail === null
    ? { status, detail: null }
    : { status: 'needs_input', detail };
}

export function createClaudeFileQueue(config, readFile = readAndSend, retryMs = 1000) {
  const busy = new Map();
  const retries = new Map();
  function enqueue(filename, sessionId) {
    const existing = busy.get(sessionId);
    if (existing) {
      existing.pending = true;
      return existing.promise;
    }
    const state = { pending: false };
    busy.set(sessionId, state);
    state.promise = processClaudeLoop(
      config, busy, retries, filename, sessionId, readFile, enqueue, retryMs,
    );
    return state.promise;
  }
  return enqueue;
}

async function processClaudeLoop(config, busy, retries, filename, sessionId, readFile, enqueue, retryMs) {
  const state = busy.get(sessionId);
  try {
    do {
      state.pending = false;
      await readFile(config, filename, sessionId, enqueue);
    } while (state.pending);
    clearTimeout(retries.get(sessionId));
    retries.delete(sessionId);
  } catch (error) {
    console.error(`[watcher] Claude ${sessionId.slice(0, 8)}: ${error.message}`);
    if (!retries.has(sessionId)) {
      const timer = setTimeout(() => {
        retries.delete(sessionId);
        enqueue(filename, sessionId);
      }, retryMs);
      timer.unref();
      retries.set(sessionId, timer);
    }
  }
  busy.delete(sessionId);
}

function pollProjects(enqueue, mtimes) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  try {
    for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
      const projectDir = path.join(CLAUDE_PROJECTS, project);
      try { if (!fs.statSync(projectDir).isDirectory()) continue; } catch { continue; }
      for (const file of fs.readdirSync(projectDir)) {
        const entryPath = path.join(projectDir, file);
        let entryStat;
        try { entryStat = fs.statSync(entryPath); } catch { continue; }
        if (entryStat.isDirectory()) {
          const subagentsDir = path.join(entryPath, 'subagents');
          let subagentFiles = [];
          try {
            subagentFiles = fs.readdirSync(subagentsDir)
              .filter((name) => name.endsWith('.jsonl') || name.endsWith('.meta.json'));
          } catch {}
          for (const subagentFile of subagentFiles) {
            const filePath = path.join(subagentsDir, subagentFile);
            const transcript = subagentFile.replace(/\.meta\.json$/, '.jsonl');
            const filename = path.join(project, file, 'subagents', transcript);
            const sessionId = claudeSubagentSessionId(
              file,
              path.basename(transcript, '.jsonl'),
            );
            queuePolledClaudeFile(
              enqueue,
              mtimes,
              filePath,
              filename,
              sessionId,
            );
          }
          continue;
        }
        if (!file.endsWith('.jsonl') || file.startsWith('.')) continue;
        const filePath = entryPath;
        try {
          const filename = path.join(project, file);
          const sessionId = path.basename(file, '.jsonl');
          queuePolledClaudeFile(
            enqueue,
            mtimes,
            filePath,
            filename,
            sessionId,
          );
        } catch {}
      }
    }
  } catch {}
}

function queuePolledClaudeFile(
  enqueue,
  mtimes,
  filePath,
  filename,
  sessionId,
) {
  let mtime;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { return; }
  const prev = mtimes.get(filePath);
  if (prev === mtime) return;
  mtimes.set(filePath, mtime);
  if (prev === undefined) return;
  enqueue(filename, sessionId);
}

async function readAndSend(config, filename, sessionId, enqueue) {
  const filePath = path.join(CLAUDE_PROJECTS, filename);
  if (!fs.existsSync(filePath)) return;
  if (String(filename).split(path.sep).includes('subagents')) {
    return readAndSendSubagent(config, filename, filePath, sessionId, enqueue);
  }

  // File creation may precede its first entrypoint by minutes. Recheck known
  // sessions on every event, including same-line-count transcript rewrites.
  exposeKnownClaudeSession(filePath, sessionId);
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const lastLine = recentSessions.has(sessionId) ? (synced.get(sessionId) ?? 0) : 0;
  const parentUpdate = _subagentParents.get(sessionId) || 0;
  if (lines.length <= lastLine && recentSessions.has(sessionId) && !parentUpdate) return;

  const metadata = getSessionMetadata(filePath, { includeFirstPromptLine: true });
  if (!metadata.preview && _subagentParents.has(sessionId)) metadata.preview = 'New session';
  const daemonMeta = metadata.preview ? null : getDaemonSessions().get(sessionId);
  if (shouldSkipClaudeSession(metadata.preview, daemonMeta)) {
    synced.delete(sessionId);
    return;
  }
  let lastParsedLine = lastLine;
  let gotNewTitle = false;
  let gotActivity = false;
  let lastStatus = null; // track status from parsed entries directly

  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) { lastParsedLine = i + 1; continue; }
    let raw;
    try { raw = JSON.parse(lines[i]); } catch { break; }
    lastParsedLine = i + 1;

    // Track status from every parsed entry (statusFromEntry returns null for non-status types).
    const s = statusFromEntry(raw);
    if (s) lastStatus = s;

    raw = normalizeClaudeQueuedInput(raw);
    if (!VALID_TYPES.has(raw.type)) continue;
    // Skip isMeta user messages (VS Code replay duplicates), but keep their assistant replies
    if (raw.isMeta && raw.type === 'user') {
      if (!isClaudeLocalCommandCaveat(raw)) _metaUuids.add(raw.uuid);
      continue;
    }
    if (raw.type === 'user' && raw.parentUuid && _metaUuids.has(raw.parentUuid)) { _metaUuids.delete(raw.parentUuid); continue; }
    if (raw.type === 'ai-title' || raw.type === 'custom-title' || raw.type === 'last-prompt'
      || i === metadata.firstPromptLine) gotNewTitle = true;

    let msg = await extractForApp(raw);
    if (!msg.uuid) continue;
    msg.orderKey = nativeOrderKey(i);
    msg = correlateClaudeInterruptMessage(sessionId, msg);

    // A managed headless turn is the sole realtime source. Its JSONL copy only
    // persists; terminal/VS Code rows have no runtime ownership and still broadcast.
    const route = headlessRoute(msg.uuid);
    if (shouldPersistClaudeJsonlMessage(poolOwns(sessionId), route)) {
      await uploadMessages(sessionId, [msg]);
      gotActivity = true;
      clearLiveMessage('claude', msg.uuid);
      if (msg.turnId) clearClaudeInterruptTurn(sessionId, msg.turnId);
      continue;
    }
    await deliverRealtimeMessages(sessionId, [msg]);
    gotActivity = true;
    if (msg.turnId) clearClaudeInterruptTurn(sessionId, msg.turnId);
  }

  if (lastLine === 0) await uploadMessages(sessionId, [], { historyComplete: true });

  const forceActivity = !!parentUpdate
    || (gotActivity && activitySyncDue(_lastActivitySyncAt, sessionId));
  // Sync metadata on lifecycle/title changes, plus throttled message activity.
  if (!recentSessions.has(sessionId) || parentUpdate
    || (lastParsedLine > lastLine && (lastStatus || gotNewTitle || forceActivity))) {
    // Pool-owned → status comes from headless lifecycle events (updateSessionStatus carries
    // isAgent), not jsonl/daemon. Title metadata can still pass through while the pool
    // owns status, so list previews stay aligned with the open session title.
    const poolOwned = poolOwns(sessionId);
    if (poolOwned && recentSessions.has(sessionId) && !gotNewTitle && !forceActivity) {
      synced.set(sessionId, lastParsedLine);
      return;
    }
    // Agent identity is permanent — never downgrade (a false isAgent put-overwrites the DDB flag).
    const dm = getDaemonSessions().get(sessionId);
    // Only roster-active agents trust daemon state; inactive agents use this jsonl update.
    const daemonActive = !poolOwned && dm && getDaemonRunningSessionIds().has(sessionId);
    const resolvedStatus = poolOwned ? 'running'
      : daemonActive ? dm.status
      : (lastStatus || getSessionStatus(sessionId, filePath, getRunningInfo()));
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
      forceActivity,
      metadata,
    );
  }
  synced.set(sessionId, lastParsedLine);
  if (_subagentParents.get(sessionId) === parentUpdate) _subagentParents.delete(sessionId);
}

async function readAndSendSubagent(config, filename, filePath, sessionId, enqueue) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const lastLine = synced.get(sessionId) ?? 0;
  const meta = readClaudeSubagentMeta(filePath);
  if (!lines.length || (lines.length <= lastLine
    && (meta.finished !== true || lastKnownStatus.get(sessionId) === 'completed'))) return;
  let lastParsedLine = lastLine;
  let lastStatus = null;
  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) {
      lastParsedLine = i + 1;
      continue;
    }
    let raw;
    try { raw = JSON.parse(lines[i]); } catch { break; }
    lastParsedLine = i + 1;
    const status = statusFromEntry(raw);
    if (status) lastStatus = status;
    raw = normalizeClaudeQueuedInput(raw);
    if (!VALID_TYPES.has(raw.type)) continue;
    const message = await extractForApp(raw);
    if (!message.uuid) continue;
    message.orderKey = nativeOrderKey(i);
    await deliverRealtimeMessages(sessionId, [message]);
  }
  if (lastLine === 0) await uploadMessages(sessionId, [], { historyComplete: true });
  synced.set(sessionId, lastParsedLine);

  const parts = String(filename).split(path.sep);
  const subagentIndex = parts.indexOf('subagents');
  if (subagentIndex < 2) return;
  const projectHash = normalizeProjectHash(parts[0]);
  const rootSessionId = parts[subagentIndex - 1];
  const agentId = path.basename(filename, '.jsonl');
  const parentFilename = path.join(parts[0], `${rootSessionId}.jsonl`);
  const parentFile = path.join(CLAUDE_PROJECTS, parentFilename);
  const parentMetadata = fs.existsSync(parentFile) ? getSessionMetadata(parentFile) : {};
  const stat = fs.statSync(filePath);
  const status = meta.finished === true ? 'completed'
    : lastStatus || (Date.now() - stat.mtimeMs < 15_000 ? 'running' : 'completed');
  const sessionMeta = {
    id: sessionId,
    nativeSessionId: sessionId,
    runtime: 'claude',
    project: projectHash,
    projectName: readableProjectName(projectHash),
    lastActive: stat.mtime.toISOString(),
    size: stat.size,
    preview: meta.description || agentId,
    model: parentMetadata.model || '',
    status,
    isAgent: true,
    threadKind: 'subagent',
    parentSessionId: claudeSubagentParentSessionId(rootSessionId, meta),
    agentName: meta.description || meta.agentType || agentId,
    agentPath: agentId,
    agentDepth: Number.isInteger(meta.spawnDepth) ? meta.spawnDepth : 1,
    canSend: false,
  };
  const agentCountUpdates = trackAgentSession(sessionMeta);
  // Use the parent's own queue for metadata, retries, and status precedence.
  if (!recentSessions.has(rootSessionId) && fs.existsSync(parentFile)) {
    _subagentParents.set(rootSessionId, (_subagentParents.get(rootSessionId) || 0) + 1);
    enqueue(parentFilename, rootSessionId);
  }
  await postRequired('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [sessionMeta],
    ...(agentCountUpdates.length ? { agentCountUpdates } : {}),
  });
  lastKnownStatus.set(sessionId, status);
  recentSessions.add(sessionId);
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
  forceActivity = false,
  metadata = getSessionMetadata(filePath),
) {
  const oldStatus = lastKnownStatus.get(sessionId);
  const statusChanged = newStatus !== oldStatus;
  const isNew = !recentSessions.has(sessionId);

  // Skip empty-shell sessions even if process detection briefly marks them running.
  const preview = metadata.preview;
  if (shouldSkipClaudeSession(preview, dm)) return;
  if (!(statusChanged || isNew || gotNewTitle || forceActivity)) return;

  const stat = fs.statSync(filePath);
  const projectHash = normalizeProjectHash(path.basename(path.dirname(filename)));
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
  trackAgentSession(sessionMeta);
  await postRequired('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [sessionMeta],
    ...(statusDelta ? { statusDelta } : {}),
  }, { signal: AbortSignal.timeout(5000) });
  lastKnownStatus.set(sessionId, newStatus);
  markActivitySynced(_lastActivitySyncAt, sessionId);
  recentSessions.add(sessionId);
  exposeKnownClaudeSession(filePath, sessionId);
  // First session of a brand-new project → recount totals so projectCount stays accurate.
  if (!knownProjects.has(projectHash)) {
    knownProjects.add(projectHash);
    reconcile(config);
  }
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

export function resetAgentPollState() {
  _jobsState.clear();
}

export async function pollAgentStates(config, options = {}) {
  let agents;
  try {
    agents = options.agents || getAgentsJson(true);
  } catch {
    return;
  }
  const findFile = options.findSessionFile || findSessionFile;
  const ownsPool = options.poolOwns || poolOwns;
  const readMetadata = options.getSessionMetadata || getSessionMetadata;
  const pushMeta = options.pushAgentMeta || pushAgentMeta;
  for (const [sid, e] of agents) {
    const filePath = findFile(sid);
    if (!filePath) continue;
    // Pool-owned = driven live by headless; skip so the daemon's stale 'done' doesn't override its running.
    if (ownsPool(sid)) continue;
    // Title: --json name first, then the jsonl's first user message. At launch
    // both can be empty for a poll or two (name not inferred yet, jsonl not
    // written), so preview is part of the diff — a title arriving later re-pushes.
    const metadata = readMetadata(filePath);
    const preview = e.agentName || metadata.preview || 'Agent session';
    const old = _jobsState.get(sid);
    if (old && old.agentName === e.agentName && old.agentDetail === e.agentDetail && old.status === e.status && old.preview === preview) continue;
    try {
      await pushMeta(config, sid, e, filePath, preview, metadata.model);
      // Commit the dedupe snapshot only after the Server accepted the update.
      // A transient POST failure must be retried on the next 8-second poll.
      _jobsState.set(sid, { ...e, preview });
    } catch (error) {
      console.error(`[watcher] Agent ${sid.slice(0, 8)}: ${error.message}`);
    }
  }
}

async function pushAgentMeta(config, sessionId, e, filePath, preview, model) {
  const projectHash = normalizeProjectHash(path.basename(path.dirname(filePath)));
  const stat = fs.statSync(filePath);
  const sessionMeta = {
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
  };
  trackAgentSession(sessionMeta);
  await postRequired('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [sessionMeta],
  });
  lastKnownStatus.set(sessionId, e.status);
}

export const claudeWatcherAdapter = defineRuntimeWatcher({
  runtime: 'claude',
  start: startWatcher,
});
