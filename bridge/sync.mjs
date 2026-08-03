import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import { post, get } from './http.mjs';
import { synced, readNewMessages, uploadMessages } from './extract.mjs';
import {
  getPreview, getModel, readableProjectName,
  getSessionStatus, getRunningInfo, getDaemonSessions,
  normalizeProjectHash, findSessionFile,
} from './session.mjs';
import { poolOwns } from './ws.mjs';

// Sessions seen in last 24h — only these get metadata synced by watcher
export const recentSessions = new Set();
let isInitialSync = true;

// Cache of last-known status per sessionId for periodic stopped detection
export const lastKnownStatus = new Map();

// Projects seen so far (normalized hash). Seeded by syncSessions on startup so the
// watcher only triggers a reconcile when a genuinely new project appears post-boot.
export const knownProjects = new Set();

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
      // Collapse worktree project dirs to the parent so a session that cd'd into
      // a worktree stays one row (see normalizeProjectHash). _filePath keeps the
      // real path for reading the jsonl.
      const proj = normalizeProjectHash(project);

      sessions.push({
        id: sessionId,
        project: proj,
        projectName: readableProjectName(proj),
        lastActive: stat.mtime.toISOString(),
        size: stat.size,
        preview,
        model: getModel(filePath),
        status,
        _filePath: filePath,
      });

      if (!projectSessions.has(proj)) projectSessions.set(proj, []);
      projectSessions.get(proj).push({ sessionId, mtime: stat.mtimeMs, filePath });
    }
  }

  const daemonMeta = getDaemonSessions();
  for (const s of sessions) {
    const dm = daemonMeta.get(s.id);
    // Agent identity is permanent — never downgrade (a false isAgent put-overwrites the DDB flag).
    if (dm) {
      s.isAgent = true;
      s.agentName = dm.agentName;
      s.agentDetail = dm.agentDetail;
      s.status = dm.status;
    }
  }

  // Update status cache + seed knownProjects (so watcher only reconciles on truly new projects).
  for (const s of sessions) {
    lastKnownStatus.set(s.id, s.status);
    knownProjects.add(s.project);
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
    // idleCount field now carries the needs_input count (the device row's 2nd number).
    if (s.status === 'running') p.runningCount++;
    else if (s.status === 'needs_input') p.idleCount++;
    if (s.lastActive > p.lastActive) p.lastActive = s.lastActive;
  }
  const projectAggregates = Array.from(projects.values());
  const deviceAggregate = {
    sessionCount: sessions.length,
    projectCount: projectAggregates.length,
    runningCount: sessions.filter(s => s.status === 'running').length,
    idleCount: sessions.filter(s => s.status === 'needs_input').length,
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
  const needsInputCount = sessions.filter(s => s.status === 'needs_input').length;
  if (isInitialSync) {
    console.log(`[sync] ${sessions.length} sessions, ${runningCount} running, ${needsInputCount} needs input`);
  } else if (runningCount > 0 || needsInputCount > 0) {
    console.log(`[sync] ${sessions.length} sessions, ${runningCount} running, ${needsInputCount} needs input`);
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
      const status = lastKnownStatus.get(s.sessionId) || 'completed';
      const isLive = status !== 'completed';
      const isRecent = s.mtime > recentCutoffMs;
      if (!isLive && !isRecent) continue;
      syncedSessionIds.add(s.sessionId);
      syncJobs.push(async () => {
        const msgs = await readNewMessages(s.filePath, s.sessionId);
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

// Recount this device's DEV#/PROJ# aggregates server-side (scans DDB SESS# rows).
// Called on startup (first boot + post-upgrade restart) to keep totals accurate.
export async function reconcile(config) {
  try { await post('/api/bridge/reconcile', { deviceName: config.deviceName, os: process.platform }); }
  catch {}
}

// Update a session to a new status and push metadata + counter delta to the
// server. Used by the pool's status sync (syncPoolStatus in ws.mjs). No-op if
// status is unchanged.
export async function updateSessionStatus(config, sessionId, filePath, project, newStatus, detail) {
  project = normalizeProjectHash(project);
  const prevStatus = lastKnownStatus.get(sessionId);
  if (prevStatus === newStatus) return;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  lastKnownStatus.set(sessionId, newStatus);
  const lastActive = stat.mtime.toISOString();
  const projectName = readableProjectName(project);
  // Carry agent identity — put-overwrite would otherwise erase the DDB isAgent flag.
  const dm = getDaemonSessions().get(sessionId);
  const session = {
    id: sessionId,
    project,
    projectName,
    lastActive,
    size: stat.size,
    preview: getPreview(filePath) || '',
    model: getModel(filePath),
    status: newStatus,
  };
  if (dm) { session.isAgent = true; session.agentName = dm.agentName; session.agentDetail = detail || dm.agentDetail || ''; }
  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [session],
    statusDeltas: [{
      deviceName: config.deviceName,
      projectHash: project,
      projectName,
      from: prevStatus || 'completed',
      to: newStatus,
      lastActive,
    }],
  });
}

// Settle stale active rows to completed. Reads DDB's active set (survives restart +
// reaches jsonl-deleted orphans that lastKnownStatus can't), then per session:
// pool-owned/daemon-agent → skip; jsonl gone → completed; else getSessionStatus.
export async function checkStopped(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const active = await get('/api/bridge/active-sessions');
  if (!active || !Array.isArray(active.sessions)) return;

  const runningInfo = getRunningInfo();
  const daemonMeta = getDaemonSessions();
  const updates = [];
  const statusDeltas = [];

  for (const s of active.sessions) {
    const sessionId = s.sessionId;
    if (s.deviceName !== config.deviceName || !sessionId) continue;

    const filePath = findSessionFile(sessionId);
    const gone = !filePath || !fs.existsSync(filePath);
    // jsonl present → owner (pool / daemon-agent poll) manages it; gone → settle here (they'd skip it).
    if (!gone && (daemonMeta.has(sessionId) || poolOwns(sessionId))) continue;
    const newStatus = gone ? 'completed' : getSessionStatus(sessionId, filePath, runningInfo);
    if (newStatus === s.status) continue;

    const proj = normalizeProjectHash(s.projectHash || '');
    const lastActive = gone ? s.lastActive : fs.statSync(filePath).mtime.toISOString();
    lastKnownStatus.set(sessionId, newStatus);
    updates.push({
      id: sessionId, project: proj, projectName: readableProjectName(proj),
      lastActive, size: gone ? 0 : fs.statSync(filePath).size,
      preview: (gone ? s.preview : getPreview(filePath)) || s.preview || '',
      model: gone ? '' : getModel(filePath), status: newStatus,
    });
    statusDeltas.push({
      deviceName: config.deviceName, projectHash: proj, projectName: readableProjectName(proj),
      from: s.status, to: newStatus, lastActive,
    });
  }

  if (updates.length > 0) {
    await post('/api/bridge/sync-sessions', {
      deviceName: config.deviceName, os: process.platform, sessions: updates, statusDeltas,
    });
  }
}
