import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import { post } from './http.mjs';
import { synced, readNewMessages, uploadMessages } from './extract.mjs';
import {
  getPreview, getModel, readableProjectName,
  getSessionStatus, getRunningInfo, getDaemonSessions, getDaemonRunningSessionIds,
} from './session.mjs';
import { projectHashToPath, cleanStaleSessions } from './tmux.mjs';

// Sessions seen in last 24h — only these get metadata synced by watcher
export const recentSessions = new Set();
let isInitialSync = true;

// Stale tmux cleanup throttle: piggybacks on checkStopped's 5-min tick but only
// actually runs every hour (24h staleness threshold doesn't need higher cadence).
const STALE_CLEAN_INTERVAL_MS = 60 * 60 * 1000;
let _lastStaleCleanMs = 0;

// Cache of last-known status per sessionId for periodic stopped detection
export const lastKnownStatus = new Map();

export async function syncSessions(config, opts = {}) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    console.log('No claude projects directory found yet.');
    return;
  }
  const runningInfo = getRunningInfo();
  const recentCutoff = Date.now() - 86400_000;
  const sessions = [];
  const projectSessions = new Map();

  for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
    const projectDir = path.join(CLAUDE_PROJECTS, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('.'));

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file);
      const stat = fs.statSync(filePath);
      if (stat.size === 0) continue;
      const preview = getPreview(filePath);
      if (!preview) continue;
      const sessionId = file.replace('.jsonl', '');

      if (stat.mtimeMs > recentCutoff) recentSessions.add(sessionId);
      if (!isInitialSync && !recentSessions.has(sessionId)) continue;

      const status = getSessionStatus(sessionId, filePath, runningInfo);

      sessions.push({
        id: sessionId,
        project,
        projectName: readableProjectName(project),
        lastActive: stat.mtime.toISOString(),
        size: stat.size,
        preview,
        model: getModel(filePath),
        status,
        _filePath: filePath,
      });

      if (!projectSessions.has(project)) projectSessions.set(project, []);
      projectSessions.get(project).push({ sessionId, mtime: stat.mtimeMs, filePath });
    }
  }

  const daemonMeta = getDaemonSessions();
  const daemonRunningIds = getDaemonRunningSessionIds();
  for (const s of sessions) {
    const dm = daemonMeta.get(s.id);
    // A finished agent that's been resumed as a regular CC session (live --resume
    // process) is no longer an agent — let it use the normal running/idle status.
    // But the daemon itself resumes done agents to keep them on standby (still in
    // roster) — those stay agents.
    if (dm && !(dm.agentState === 'done' && runningInfo.sessions.has(s.id) && !daemonRunningIds.has(s.id))) {
      s.isAgent = true;
      s.agentName = dm.agentName;
      s.agentDetail = dm.agentDetail;
      s.agentState = dm.agentState;
      if (dm.agentState === 'done') s.status = 'stopped';
      else if (dm.agentState === 'blocked') s.status = 'idle';
      else s.status = 'running'; // working
    }
  }

  // Update status cache
  for (const s of sessions) {
    lastKnownStatus.set(s.id, s.status);
    delete s._filePath;
  }

  // Compute device + project aggregates for the new single-table layout (DEV# / PROJ# items).
  // Server uses these to populate counters without scanning all sessions.
  const projects = new Map(); // projectHash -> aggregate
  let deviceLastActive = '';
  for (const s of sessions) {
    if (s.lastActive > deviceLastActive) deviceLastActive = s.lastActive;
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
    if (s.status === 'running') p.runningCount++;
    else if (s.status === 'idle') p.idleCount++;
    if (s.lastActive > p.lastActive) p.lastActive = s.lastActive;
  }
  const projectAggregates = Array.from(projects.values());
  const deviceAggregate = {
    sessionCount: sessions.length,
    projectCount: projectAggregates.length,
    runningCount: sessions.filter(s => s.status === 'running').length,
    idleCount: sessions.filter(s => s.status === 'idle').length,
    lastActive: deviceLastActive,
  };

  // ~350-800 bytes per session, 5000 ≈ 1.7-4MB, safe under Lambda 6MB limit.
  // Send device+projects aggregates only on the FIRST batch (server overwrites them).
  const BATCH = 5000;
  for (let i = 0; i < sessions.length; i += BATCH) {
    const body = {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: sessions.slice(i, i + BATCH),
    };
    if (i === 0) {
      body.device = deviceAggregate;
      body.projects = projectAggregates;
    }
    await post('/api/bridge/sync-sessions', body);
  }
  // Edge case: zero sessions — still need a single request to clear DEV#/PROJ# items.
  if (sessions.length === 0) {
    await post('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: [],
      device: deviceAggregate,
      projects: projectAggregates,
    });
  }

  const runningCount = sessions.filter(s => s.status === 'running').length;
  const idleCount = sessions.filter(s => s.status === 'idle').length;
  if (isInitialSync) {
    console.log(`[sync] ${sessions.length} sessions, ${runningCount} running, ${idleCount} idle`);
  } else if (runningCount > 0 || idleCount > 0) {
    console.log(`[sync] ${sessions.length} sessions, ${runningCount} running, ${idleCount} idle`);
  }

  // skipMessages: caller wants metadata-only sync (e.g. --skip-init mode).
  // Mark all jsonl files as already-synced-to-end so the watcher won't replay them as new.
  if (opts.skipMessages) {
    for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
      const dir = path.join(CLAUDE_PROJECTS, project);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch { continue; }
      for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && !f.startsWith('.'))) {
        const fp = path.join(dir, file);
        try {
          const lines = fs.readFileSync(fp, 'utf-8').split('\n').length;
          synced.set(file.replace('.jsonl', ''), lines);
        } catch {}
      }
    }
    isInitialSync = false;
    return;
  }

  // Initial message sync — running/idle + recent 24h sessions
  const syncJobs = [];
  const syncedSessionIds = new Set();
  const recentCutoffMs = Date.now() - 86400_000;

  for (const [, items] of projectSessions) {
    for (const s of items) {
      if (synced.has(s.sessionId) || syncedSessionIds.has(s.sessionId)) continue;
      const status = lastKnownStatus.get(s.sessionId) || 'stopped';
      const isLive = status !== 'stopped';
      const isRecent = s.mtime > recentCutoffMs;
      if (!isLive && !isRecent) continue;
      syncedSessionIds.add(s.sessionId);
      const projectDir = projectHashToPath(path.basename(path.dirname(s.filePath)));
      syncJobs.push(async () => {
        const msgs = await readNewMessages(s.filePath, s.sessionId, projectDir);
        if (msgs.length > 0) {
          await uploadMessages(s.sessionId, msgs);
          console.log(`[init] ${s.sessionId.slice(0, 8)}: ${msgs.length} messages (${isLive ? status : 'recent'})`);
          return msgs.length;
        }
        return 0;
      });
    }
  }

  if (syncJobs.length > 0) {
    console.log(`[init] syncing ${syncJobs.length} sessions (running/idle + recent 24h)`);
    const CONCURRENCY = 4;
    let total = 0;
    let next = 0;
    const inflight = new Set();

    function launch() {
      while (inflight.size < CONCURRENCY && next < syncJobs.length) {
        const idx = next++;
        const p = syncJobs[idx]().then(n => { total += n; inflight.delete(p); });
        inflight.add(p);
      }
    }

    launch();
    while (inflight.size > 0) {
      await Promise.race(inflight);
      launch();
    }
    if (total > 0) console.log(`[init] ${total} messages synced to DDB`);
  }
  isInitialSync = false;
}

/**
 * Periodic check (every 5 min). Two jobs:
 *  1. Kill stale apeek_ tmux sessions (idle > 24h) — runs at most once/hour via throttle.
 *     Order matters: kill stale tmux FIRST so the running-process scan below sees the
 *     freshly-disappeared CC processes and flips their DDB status to stopped in the same tick.
 *  2. Detect CC processes that have disappeared and flip running/idle → stopped.
 */
// Update a session to a new status and push metadata + counter delta to the
// server. Used by the stall poller's idle fast-path (a reverted prompt looks
// 'running' in jsonl but the pane is quiescent). No-op if status is unchanged.
export async function updateSessionStatus(config, sessionId, filePath, project, newStatus) {
  const prevStatus = lastKnownStatus.get(sessionId);
  if (prevStatus === newStatus) return;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  lastKnownStatus.set(sessionId, newStatus);
  const lastActive = stat.mtime.toISOString();
  const projectName = readableProjectName(project);
  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [{
      id: sessionId,
      project,
      projectName,
      lastActive,
      size: stat.size,
      preview: getPreview(filePath) || '',
      model: getModel(filePath),
      status: newStatus,
    }],
    statusDeltas: [{
      deviceName: config.deviceName,
      projectHash: project,
      projectName,
      from: prevStatus || 'stopped',
      to: newStatus,
      lastActive,
    }],
  });
}

export async function checkStopped(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;

  // 1. Stale tmux cleanup — throttled to once per hour.
  const now = Date.now();
  if (now - _lastStaleCleanMs >= STALE_CLEAN_INTERVAL_MS) {
    _lastStaleCleanMs = now;
    try { cleanStaleSessions(); } catch {}
  }

  const runningInfo = getRunningInfo();
  const daemonMeta = getDaemonSessions();
  const updates = [];
  const statusDeltas = [];

  for (const [sessionId, prevStatus] of lastKnownStatus) {
    if (prevStatus === 'stopped') continue;
    // Daemon agents have no live --resume process, so getSessionStatus would
    // wrongly read them as stopped (dropping agent metadata). Their status is
    // owned by the `claude agents --json` poller — skip them here.
    if (daemonMeta.has(sessionId)) continue;

    // Find the session's project hash
    for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
      const filePath = path.join(CLAUDE_PROJECTS, project, `${sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) continue;

      const newStatus = getSessionStatus(sessionId, filePath, runningInfo);
      if (newStatus !== prevStatus) {
        lastKnownStatus.set(sessionId, newStatus);
        const stat = fs.statSync(filePath);
        const lastActive = stat.mtime.toISOString();
        updates.push({
          id: sessionId,
          project,
          projectName: readableProjectName(project),
          lastActive,
          size: stat.size,
          preview: getPreview(filePath) || '',
          model: getModel(filePath),
          status: newStatus,
        });
        statusDeltas.push({
          deviceName: config.deviceName,
          projectHash: project,
          projectName: readableProjectName(project),
          from: prevStatus,
          to: newStatus,
          lastActive,
        });
      }
      break;
    }
  }

  if (updates.length > 0) {
    await post('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: updates,
      statusDeltas,
    });
  }
}
