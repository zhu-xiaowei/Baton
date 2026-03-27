import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS } from './config.mjs';
import { post } from './http.mjs';
import { synced, readNewMessages, uploadMessages } from './extract.mjs';
import { getPreview, getModel, readableProjectName, getRunningProjects } from './session.mjs';
import { recentSessions } from './sync.mjs';
import { wsSend } from './ws.mjs';

export function startWatcher(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const timers = new Map();

  fs.watch(CLAUDE_PROJECTS, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith('.jsonl')) return;
    if (filename.includes('subagents')) return;
    const sessionId = path.basename(filename, '.jsonl');

    if (timers.has(sessionId)) clearTimeout(timers.get(sessionId));
    timers.set(sessionId, setTimeout(() => {
      timers.delete(sessionId);
      processFileChange(config, filename, sessionId);
    }, 100));
  });
}

async function processFileChange(config, filename, sessionId) {
  const filePath = path.join(CLAUDE_PROJECTS, filename);
  if (!fs.existsSync(filePath)) return;

  const stat = fs.statSync(filePath);
  const isNewSession = !synced.has(sessionId);
  const isResumedHistory = !isNewSession && !recentSessions.has(sessionId);

  const newMsgs = await readNewMessages(filePath, sessionId);
  if (newMsgs.length > 0) {
    // Push via WS (real-time) — server handles DDB write + app relay
    const sent = wsSend({
      action: 'messages',
      sessionId,
      messages: newMsgs,
    });

    // Fallback to HTTP POST if WS not connected
    if (!sent) {
      await uploadMessages(sessionId, newMsgs);
    }

    console.log(`[watch] ${sessionId.slice(0, 8)}: +${newMsgs.length} messages${sent ? ' (ws)' : ''}`);

    // New/resumed session — immediately sync metadata
    if (isNewSession || isResumedHistory) {
      const projectHash = path.basename(path.dirname(filename));
      const preview = getPreview(filePath) || 'New session';
      const running = getRunningProjects();
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
          model: getModel(filePath),
          isRunning: running.has(projectHash),
        }],
      });
      recentSessions.add(sessionId);
      console.log(`[watch] ${isNewSession ? 'new' : 'resumed'} session ${sessionId.slice(0, 8)} synced`);
    }
  }
}
