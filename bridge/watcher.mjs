import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS, VALID_TYPES } from './config.mjs';
import { post } from './http.mjs';
import { synced, extractForApp, uploadMessages } from './extract.mjs';
import { getPreview, getModel, readableProjectName, getRunningProjects } from './session.mjs';
import { recentSessions } from './sync.mjs';
import { wsSend } from './ws.mjs';

export function startWatcher(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const busy = new Map(); // sessionId → { pending }

  fs.watch(CLAUDE_PROJECTS, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith('.jsonl')) return;
    if (filename.includes('subagents')) return;
    const sessionId = path.basename(filename, '.jsonl');

    const state = busy.get(sessionId);
    if (state) { state.pending = true; return; }
    busy.set(sessionId, { pending: false });
    processLoop(config, filename, sessionId);
  });

  async function processLoop(config, filename, sessionId) {
    const state = busy.get(sessionId);
    do {
      state.pending = false;
      await readAndSend(config, filename, sessionId);
    } while (state.pending);
    busy.delete(sessionId);
  }
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

  for (let i = lastLine; i < lines.length; i++) {
    if (!lines[i].trim()) { lastParsedLine = i + 1; continue; }
    let raw;
    try { raw = JSON.parse(lines[i]); } catch { break; }
    lastParsedLine = i + 1;

    if (!VALID_TYPES.has(raw.type)) continue;
    if (raw.type === 'ai-title') gotNewTitle = true;

    const msg = await extractForApp(raw);
    if (!msg.uuid) continue;

    const sent = wsSend({ action: 'messages', sessionId, messages: [msg] });
    if (!sent) await uploadMessages(sessionId, [msg]);
  }

  synced.set(sessionId, lastParsedLine);

  // Sync metadata: new session or ai-title arrived (update preview)
  if (lastParsedLine > lastLine && (gotNewTitle || !recentSessions.has(sessionId))) {
    const stat = fs.statSync(filePath);
    const projectHash = path.basename(path.dirname(filename));
    await post('/api/bridge/sync-sessions', {
      deviceName: config.deviceName,
      os: process.platform,
      sessions: [{
        id: sessionId,
        project: projectHash,
        projectName: readableProjectName(projectHash),
        lastActive: stat.mtime.toISOString(),
        size: stat.size,
        preview: getPreview(filePath) || 'New session',
        model: getModel(filePath),
        isRunning: getRunningProjects().has(projectHash),
      }],
    });
    recentSessions.add(sessionId);
  }
}
