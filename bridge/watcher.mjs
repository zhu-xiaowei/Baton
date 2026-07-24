import fs from 'fs';
import path from 'path';
import { CLAUDE_PROJECTS, CLAUDE_JOBS, VALID_TYPES, NEEDS_POLLING, WS_FRAME_LIMIT, AGENTS_POLL_INTERVAL_MS } from './config.mjs';
import { post } from './http.mjs';
import { synced, extractForApp, uploadMessages, truncateToBytes } from './extract.mjs';
import { getPreview, getModel, readableProjectName, statusFromEntry, resolveStatus, getSessionStatus, getRunningInfo, getDaemonSessions, getDaemonRunningSessionIds, findSessionFile, getAgentsJson, normalizeProjectHash } from './session.mjs';
import { recentSessions, lastKnownStatus } from './sync.mjs';
import { wsSend, wsSendWithAck, headlessBusy } from './ws.mjs';
import { projectHashToPath } from './tmux.mjs';
import { isArmed, getRescuedToolUseId, setRescuedToolUseId, disarmStallRescue } from './stall.mjs';

const _metaUuids = new Set(); // track isMeta message UUIDs to skip their replies
const _projectDirs = new Map(); // projectHash → resolved project directory

// Recognize the two synthetic jsonl entries a stall-rescue Escape produces
// (see stall.mjs): a rejection tool_result for the flushed tool_use, and CC's
// standard "[Request interrupted by user for tool use]" marker. Only checked
// while armed, so this can't misfire on a user manually cancelling a normal
// live prompt (that path never arms).
function textOf(raw) {
  const c = raw.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length === 1 && c[0].type === 'text') return c[0].text || '';
  return '';
}

function isStallRescueArtifact(sessionId, raw) {
  if (raw.type !== 'user') return false;
  if (textOf(raw).startsWith('[Request interrupted by user')) return true;
  const rescuedId = getRescuedToolUseId(sessionId);
  const content = raw.message?.content;
  if (!rescuedId || !Array.isArray(content)) return false;
  return content.some((b) => b.type === 'tool_result' && b.tool_use_id === rescuedId);
}

// The interrupt marker is always the last of the two synthetic lines — once
// seen, the rescue sequence is done. (The STALL_ARM_TIMEOUT_MS backstop in
// stallState.mjs covers the case where it never arrives.)
function disarmIfRescueComplete(sessionId, raw) {
  if (textOf(raw).startsWith('[Request interrupted by user')) disarmStallRescue(sessionId);
}

// Mark the tool_use flushed by a rescue so the app renders it as a rescued
// wizard (answer via a normal chat message) instead of the live arrow-key
// navigation path — CC's AskUserQuestion state is already gone by the time
// this lands, so permission_reply's tmux navigation would hit nothing.
function tagStallRescue(sessionId, raw, msg) {
  if (raw.type !== 'assistant' || !Array.isArray(msg.content)) return;
  for (const block of msg.content) {
    if (block.type !== 'tool_use') continue;
    block.stallRescued = true;
    setRescuedToolUseId(sessionId, block.id);
  }
}

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

    // A stall rescue (see stall.mjs) sends Escape, which flushes the real question
    // data we want — but also writes a synthetic rejection tool_result + interrupt
    // marker that are bridge-internal noise, not real conversation. Hide those two
    // from the app/DDB entirely (never mutate the actual .jsonl).
    const armed = isArmed(sessionId);
    const isStallArtifact = armed && isStallRescueArtifact(sessionId, raw);

    // Track status from every parsed entry (statusFromEntry returns null for
    // non-status types). Force idle for stall artifacts: a rejected tool_result
    // may not carry is_error, which statusFromEntry relies on, but a rescue
    // rejection always means the turn is over.
    const s = isStallArtifact ? 'idle' : statusFromEntry(raw);
    if (s) lastStatus = s;

    if (!VALID_TYPES.has(raw.type)) continue;
    // Skip isMeta user messages (VS Code replay duplicates), but keep their assistant replies
    if (raw.isMeta && raw.type === 'user') { _metaUuids.add(raw.uuid); continue; }
    if (raw.type === 'user' && raw.parentUuid && _metaUuids.has(raw.parentUuid)) { _metaUuids.delete(raw.parentUuid); continue; }
    if (raw.type === 'ai-title' || raw.type === 'custom-title' || raw.type === 'last-prompt') gotNewTitle = true;

    if (isStallArtifact) { disarmIfRescueComplete(sessionId, raw); continue; }

    const msg = await extractForApp(raw, _projectDirs.get(projectHash));
    if (!msg.uuid) continue;

    if (armed) tagStallRescue(sessionId, raw, msg);

    // A headless-driven session streams messages live to the app itself; the
    // watcher only persists them to DDB (skip the duplicate WS push).
    if (headlessBusy(sessionId)) {
      await uploadMessages(sessionId, [msg]);
      continue;
    }

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
    // Exception: the daemon itself resumes done agents to keep them on standby
    // (still listed in roster) — those remain agents.
    let dm = getDaemonSessions().get(sessionId);
    if (dm && dm.agentState === 'done' && getRunningInfo().sessions.has(sessionId) && !getDaemonRunningSessionIds().has(sessionId)) dm = null;
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
  const projectHash = normalizeProjectHash(path.basename(path.dirname(filename)));
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

const _jobsState = new Map(); // sessionId → { agentName, agentDetail, agentState }

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
    // Title: --json name first, then the jsonl's first user message. At launch
    // both can be empty for a poll or two (name not inferred yet, jsonl not
    // written), so preview is part of the diff — a title arriving later re-pushes.
    const preview = e.agentName || getPreview(filePath) || 'Agent session';
    const old = _jobsState.get(sid);
    if (old && old.agentName === e.agentName && old.agentDetail === e.agentDetail && old.agentState === e.agentState && old.preview === preview) continue;
    _jobsState.set(sid, { ...e, preview });
    await pushAgentMeta(config, sid, e, filePath, preview);
  }
}

async function pushAgentMeta(config, sessionId, e, filePath, preview) {
  const projectHash = normalizeProjectHash(path.basename(path.dirname(filePath)));
  const stat = fs.statSync(filePath);
  const status = e.agentState === 'done' ? 'stopped' : e.agentState === 'blocked' ? 'idle' : 'running';
  lastKnownStatus.set(sessionId, status);
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
      status,
      isAgent: true,
      agentName: e.agentName,
      agentDetail: e.agentDetail,
      agentState: e.agentState,
    }],
  });
}
