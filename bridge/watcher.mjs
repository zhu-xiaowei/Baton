import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS, CLAUDE_JOBS, VALID_TYPES, NEEDS_POLLING, WS_FRAME_LIMIT } from './config.mjs';
import { post } from './http.mjs';
import { synced, extractForApp, uploadMessages, truncateToBytes } from './extract.mjs';
import { getPreview, getModel, readableProjectName, statusFromEntry, resolveStatus, getSessionStatus, getRunningInfo, getDaemonSessions, findSessionFile, mapAgentState, agentDetailFor } from './session.mjs';
import { recentSessions, lastKnownStatus } from './sync.mjs';
import { wsSend, wsSendWithAck } from './ws.mjs';
import { projectHashToPath } from './tmux.mjs';

const _metaUuids = new Set(); // track isMeta message UUIDs to skip their replies
const _projectDirs = new Map(); // projectHash → resolved project directory

export function startWatcher(config) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return;
  const busy = new Map(); // sessionId → { pending }

  if (NEEDS_POLLING) {
    // WSL2: inotify doesn't work on /mnt/ (9P filesystem), use polling
    const mtimes = new Map(); // filePath → mtimeMs
    console.log('[watcher] WSL detected, using polling (2s interval)');
    setInterval(() => pollProjects(config, busy, mtimes), 2000);
  } else {
    fs.watch(CLAUDE_PROJECTS, { recursive: true }, (_event, filename) => {
      if (!filename?.endsWith('.jsonl')) return;
      if (filename.includes('subagents')) return;
      const sessionId = path.basename(filename, '.jsonl');

      const state = busy.get(sessionId);
      if (state) { state.pending = true; return; }
      busy.set(sessionId, { pending: false });
      processLoop(config, filename, sessionId);
    });
  }

  async function processLoop(config, filename, sessionId) {
    const state = busy.get(sessionId);
    do {
      state.pending = false;
      await readAndSend(config, filename, sessionId);
    } while (state.pending);
    busy.delete(sessionId);
  }
}

function pollProjects(config, busy, mtimes) {
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
          (async () => {
            const s = busy.get(sessionId);
            do { s.pending = false; await readAndSend(config, filename, sessionId); } while (s.pending);
            busy.delete(sessionId);
          })();
        } catch {}
      }
    }
  } catch {}
}

async function readAndSend(config, filename, sessionId) {
  const filePath = path.join(CLAUDE_PROJECTS, filename);
  if (!fs.existsSync(filePath)) return;

  const projectHash = path.basename(path.dirname(filename));
  if (!_projectDirs.has(projectHash)) {
    _projectDirs.set(projectHash, projectHashToPath(projectHash));
  }

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

    // Track status from every parsed entry (statusFromEntry returns null for non-status types)
    const s = statusFromEntry(raw);
    if (s) lastStatus = s;

    if (!VALID_TYPES.has(raw.type)) continue;
    // Skip isMeta user messages (VS Code replay duplicates), but keep their assistant replies
    if (raw.isMeta && raw.type === 'user') { _metaUuids.add(raw.uuid); continue; }
    if (raw.type === 'user' && raw.parentUuid && _metaUuids.has(raw.parentUuid)) { _metaUuids.delete(raw.parentUuid); continue; }
    if (raw.type === 'ai-title' || raw.type === 'custom-title' || raw.type === 'last-prompt') gotNewTitle = true;

    const msg = await extractForApp(raw, _projectDirs.get(projectHash));
    if (!msg.uuid) continue;

    // Messages over the API GW single-frame cap (32768B) would drop the whole WS
    // connection with code 1009. Send a truncated copy over WS for real-time
    // display (noCache → server skips DDB), and the full copy over HTTP to DDB.
    if (Buffer.byteLength(JSON.stringify({ action: 'messages', sessionId, messages: [msg] })) > WS_FRAME_LIMIT) {
      const wsMsg = truncateToBytes(msg, WS_FRAME_LIMIT - 512);
      wsMsg.truncated = true;
      wsSend({ action: 'messages', sessionId, messages: [wsMsg], noCache: true });
      await uploadMessages(sessionId, [msg]);
    } else {
      const acked = await wsSendWithAck({ action: 'messages', sessionId, messages: [msg] });
      if (!acked) await uploadMessages(sessionId, [msg]);
    }
  }

  synced.set(sessionId, lastParsedLine);

  // Sync metadata only when status changed, new session, or ai-title arrived
  if (lastParsedLine > lastLine && lastStatus) {
    // A finished agent resumed as a regular CC session (live --resume process) is
    // no longer an agent — ignore its stale daemon record. Matches sync.mjs.
    let dm = getDaemonSessions().get(sessionId);
    if (dm && dm.agentState === 'done' && getRunningInfo().sessions.has(sessionId)) dm = null;
    // Debounce + terminal-truth before downgrading (don't flicker the badge to
    // idle mid-task). Daemon sessions skip it — reconciled below.
    let newStatus = dm
      ? lastStatus
      : resolveStatus(sessionId, lastStatus, () => getRunningInfo().sessions.has(sessionId));
    if (dm) {
      if (dm.agentState === 'done') newStatus = 'stopped';
      else if (dm.agentState === 'blocked') newStatus = 'idle';
    }
    await postSessionMeta(config, filePath, filename, sessionId, newStatus, dm, gotNewTitle);
    // Trailing edge: content went idle but debounce held it 'running'. No more
    // writes will fire fs.watch, so re-evaluate once after debounce expires.
    if (!dm && lastStatus !== 'running' && newStatus === 'running') scheduleRecheck(config, filePath, filename, sessionId);
  }
}

// Post session metadata + counter delta when status changed, is new, or title arrived.
async function postSessionMeta(config, filePath, filename, sessionId, newStatus, dm, gotNewTitle) {
  const oldStatus = lastKnownStatus.get(sessionId);
  const statusChanged = newStatus !== oldStatus;
  const isNew = !recentSessions.has(sessionId);

  // Skip empty-shell sessions (e.g. /clear: metadata only, no preview, not running).
  const preview = getPreview(filePath);
  if (!preview && newStatus !== 'running' && !dm) return;
  if (!(statusChanged || isNew || gotNewTitle)) return;

  const stat = fs.statSync(filePath);
  const projectHash = path.basename(path.dirname(filename));
  lastKnownStatus.set(sessionId, newStatus);
  // Counter delta — server uses this to ADD/SUBTRACT counters; 'new' means += 1.
  const statusDelta = (statusChanged || isNew) ? {
    deviceName: config.deviceName,
    projectHash,
    from: isNew && oldStatus === undefined ? 'new' : (oldStatus || 'stopped'),
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
    model: getModel(filePath),
    status: newStatus,
  };
  if (dm) {
    sessionMeta.isAgent = true;
    sessionMeta.agentName = dm.agentName;
    sessionMeta.agentDetail = dm.agentDetail;
    sessionMeta.agentState = dm.agentState;
  }
  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [sessionMeta],
    ...(statusDelta ? { statusDelta } : {}),
  });
  recentSessions.add(sessionId);
}

const _recheckTimers = new Map(); // sessionId → timeout, reset on new activity
const RECHECK_DELAY_MS = 11_000;   // just past resolveStatus's 10s running debounce

function scheduleRecheck(config, filePath, filename, sessionId) {
  clearTimeout(_recheckTimers.get(sessionId));
  _recheckTimers.set(sessionId, setTimeout(async () => {
    _recheckTimers.delete(sessionId);
    if (!fs.existsSync(filePath)) return;
    const status = getSessionStatus(sessionId, filePath, getRunningInfo());
    await postSessionMeta(config, filePath, filename, sessionId, status, null, false);
  }, RECHECK_DELAY_MS));
}

const _jobsState = new Map();

export function startJobsWatcher(config) {
  if (!fs.existsSync(CLAUDE_JOBS)) return;

  loadAllJobStates();

  fs.watch(CLAUDE_JOBS, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith('state.json')) return;
    const short = path.dirname(filename);
    if (short.includes(path.sep)) return;
    handleJobStateChange(config, short);
  });
}

function loadAllJobStates() {
  try {
    for (const dir of fs.readdirSync(CLAUDE_JOBS)) {
      const statePath = path.join(CLAUDE_JOBS, dir, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      try {
        const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        if (state.backend !== 'daemon' || !state.sessionId) continue;
        _jobsState.set(dir, {
          sessionId: state.sessionId,
          agentName: state.name || '',
          agentDetail: agentDetailFor(state),
          agentState: mapAgentState(state),
        });
      } catch {}
    }
  } catch {}
}

async function handleJobStateChange(config, short) {
  const statePath = path.join(CLAUDE_JOBS, short, 'state.json');
  if (!fs.existsSync(statePath)) return;

  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf-8')); } catch { return; }
  if (state.backend !== 'daemon' || !state.sessionId) return;

  const newEntry = {
    sessionId: state.sessionId,
    agentName: state.name || '',
    agentDetail: agentDetailFor(state),
    agentState: mapAgentState(state),
  };

  const old = _jobsState.get(short);
  if (old && old.agentName === newEntry.agentName
    && old.agentDetail === newEntry.agentDetail
    && old.agentState === newEntry.agentState) return;

  _jobsState.set(short, newEntry);

  const filePath = findSessionFile(state.sessionId);
  if (!filePath) return;

  const projectHash = path.basename(path.dirname(filePath));
  const stat = fs.statSync(filePath);

  await post('/api/bridge/sync-sessions', {
    deviceName: config.deviceName,
    os: process.platform,
    sessions: [{
      id: state.sessionId,
      project: projectHash,
      projectName: readableProjectName(projectHash),
      lastActive: stat.mtime.toISOString(),
      size: stat.size,
      preview: getPreview(filePath) || newEntry.agentName || 'Agent session',
      model: getModel(filePath),
      status: newEntry.agentState === 'done' ? 'stopped' : newEntry.agentState === 'blocked' ? 'idle' : (lastKnownStatus.get(state.sessionId) || 'idle'),
      isAgent: true,
      agentName: newEntry.agentName,
      agentDetail: newEntry.agentDetail,
      agentState: newEntry.agentState,
    }],
  });
}
