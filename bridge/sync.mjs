import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import { post } from './http.mjs';
import { synced, readNewMessages, uploadMessages } from './extract.mjs';
import {
  getPreview, getModel, readableProjectName,
  isSessionActive, getLatestMtimeByProject, getRunningProjects,
} from './session.mjs';

// Sessions active in last 24h — only these get synced in periodic poll
export const recentSessions = new Set();
let isInitialSync = true;

export async function syncSessions(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) {
    console.log('No claude projects directory found yet.');
    return;
  }
  const running = getRunningProjects();
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

      sessions.push({
        id: sessionId,
        project,
        projectName: readableProjectName(project),
        lastActive: stat.mtime.toISOString(),
        size: stat.size,
        preview,
        model: getModel(filePath),
        isRunning: false,
        _mtime: stat.mtimeMs,
      });

      if (!projectSessions.has(project)) projectSessions.set(project, []);
      projectSessions.get(project).push({ sessionId, mtime: stat.mtimeMs, filePath });
    }
  }

  // Determine isRunning
  const latestMtime = getLatestMtimeByProject(
    sessions.map(s => ({ project: s.project, mtime: s._mtime })), running
  );
  for (const s of sessions) {
    s.isRunning = isSessionActive(s.project, s._mtime, running, latestMtime);
    delete s._mtime;
  }

  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions,
  });

  if (isInitialSync) {
    console.log(`[sync] ${sessions.length} sessions (${running.size} active)`);
  } else {
    console.log(`[sync] ${sessions.length} recent sessions (${running.size} active)`);
  }

  // Initial message sync
  const syncJobs = [];
  const syncedSessionIds = new Set();
  const latestMtimeForSync = getLatestMtimeByProject(
    [...projectSessions.entries()].flatMap(([project, items]) =>
      items.map(s => ({ project, mtime: s.mtime }))
    ), running
  );
  const recentCutoffMs = Date.now() - 86400_000;

  for (const [project, items] of projectSessions) {
    for (const s of items) {
      if (synced.has(s.sessionId) || syncedSessionIds.has(s.sessionId)) continue;
      const isActive = isSessionActive(project, s.mtime, running, latestMtimeForSync);
      const isRecent = s.mtime > recentCutoffMs;
      if (!isActive && !isRecent) continue;
      syncedSessionIds.add(s.sessionId);
      syncJobs.push(async () => {
        const msgs = await readNewMessages(s.filePath, s.sessionId);
        if (msgs.length > 0) {
          await uploadMessages(s.sessionId, msgs);
          console.log(`[init] ${s.sessionId.slice(0, 8)}: ${msgs.length} messages (${isActive ? 'active' : 'recent'})`);
          return msgs.length;
        }
        return 0;
      });
    }
  }

  if (syncJobs.length > 0) {
    console.log(`[init] syncing ${syncJobs.length} sessions (active + recent 24h)`);
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
