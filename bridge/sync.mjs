import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import { post } from './http.mjs';
import { synced, readNewMessages, uploadMessages } from './extract.mjs';
import {
  getPreview, getModel, readableProjectName,
  getSessionStatus, getRunningInfo,
} from './session.mjs';

// Sessions seen in last 24h — only these get metadata synced by watcher
export const recentSessions = new Set();
let isInitialSync = true;

// Cache of last-known status per sessionId for periodic stopped detection
export const lastKnownStatus = new Map();

export async function syncSessions(config) {
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

  // Update status cache
  for (const s of sessions) {
    lastKnownStatus.set(s.id, s.status);
    delete s._filePath;
  }

  // ~350-800 bytes per session, 5000 ≈ 1.7-4MB, safe under Lambda 6MB limit
  const BATCH = 5000;
  for (let i = 0; i < sessions.length; i += BATCH) {
    await post('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: sessions.slice(i, i + BATCH),
    });
  }

  const runningCount = sessions.filter(s => s.status === 'running').length;
  const idleCount = sessions.filter(s => s.status === 'idle').length;
  if (isInitialSync) {
    console.log(`[sync] ${sessions.length} sessions, ${runningCount} running, ${idleCount} idle`);
  } else if (runningCount > 0 || idleCount > 0) {
    console.log(`[sync] ${sessions.length} sessions, ${runningCount} running, ${idleCount} idle`);
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

/**
 * Lightweight periodic check: only detect processes that disappeared.
 * Called every 5 minutes. If a session was running/idle but CC process is gone,
 * sync just that session's status to "stopped".
 */
export async function checkStopped(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const runningInfo = getRunningInfo();
  const updates = [];

  for (const [sessionId, prevStatus] of lastKnownStatus) {
    if (prevStatus === 'stopped') continue;

    // Find the session's project hash
    for (const project of fs.readdirSync(CLAUDE_PROJECTS)) {
      const filePath = path.join(CLAUDE_PROJECTS, project, `${sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) continue;

      const newStatus = getSessionStatus(sessionId, filePath, runningInfo);
      if (newStatus !== prevStatus) {
        lastKnownStatus.set(sessionId, newStatus);
        const stat = fs.statSync(filePath);
        updates.push({
          id: sessionId,
          project,
          projectName: readableProjectName(project),
          lastActive: stat.mtime.toISOString(),
          size: stat.size,
          preview: getPreview(filePath) || '',
          model: getModel(filePath),
          status: newStatus,
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
    });
  }
}
