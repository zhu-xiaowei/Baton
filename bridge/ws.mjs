import WebSocket from 'ws';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { readAllMessages, uploadMessages } from './extract.mjs';
import { findSessionFile, getDaemonSessions, hasNoDanglingTurn } from './session.mjs';
import { armStallRescue } from './stall.mjs';
import { ClaudePool } from './headless.mjs';
import { sendMessageToSession, sendArrowSelect, sendTypeInput, sendKey, sendKeys, interruptSession, launchClaudeSession, launchAgentsSession, newTmuxSession, projectHashToPath, captureCommandOutput, findTmuxTargetForSession } from './tmux.mjs';
import { CLAUDE_PROJECTS, CLAUDE_JOBS } from './config.mjs';
import { post } from './http.mjs';
import { scanSlashCommands, LOCAL_COMMANDS, DIALOG_COMMANDS, SYNTHETIC_COMMANDS } from './commands.mjs';

let _ws = null;
let _config = null;
let _reconnectTimer = null;
let _heartbeatTimer = null;
let _connectWatchdog = null;
let _consecutiveFailures = 0;
const HEARTBEAT_INTERVAL = 4 * 60_000;
const RECONNECT_DELAY = 5_000;
const SLOW_RECONNECT_DELAY = 5 * 60_000;
const CONNECT_TIMEOUT = 15_000;
const SLOW_RECONNECT_THRESHOLD = 12;

// Launch locks: prevent concurrent tmux creation for same project/session
// Key: projectHash or sessionId, Value: Promise<{ok, sessionId?, tmuxName?}>
const _launchLocks = new Map();

const _pool = new ClaudePool();

export function headlessBusy(sessionId) { return _pool.isBusy(sessionId); }

function cwdForSession(sessionId) {
  const filePath = findSessionFile(sessionId);
  if (!filePath) return null;
  const projectHash = path.basename(path.dirname(filePath));
  return projectHashToPath(projectHash);
}

export function initWs(config) {
  _config = config;
  connect();
}

export function wsSend(data) {
  if (!_ws || _ws.readyState !== WebSocket.OPEN) return false;
  try {
    _ws.send(JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

// Ack-based send: resolves true if server acks within timeout, false otherwise
const _pendingAcks = new Map(); // sessionId → { resolve, timer }

export function wsSendWithAck(data, timeout = 5000) {
  return new Promise((resolve) => {
    if (!wsSend(data)) return resolve(false);
    const sid = data.sessionId;
    // If there's already a pending ack for this session, let it timeout naturally
    const timer = setTimeout(() => { _pendingAcks.delete(sid); resolve(false); }, timeout);
    _pendingAcks.set(sid, { resolve, timer });
  });
}

function connect() {
  if (!_config) return;

  // Derive WS URL from REST URL: https://xxx.execute-api.xxx.amazonaws.com/v1
  // → wss://xxx-ws.execute-api.xxx.amazonaws.com/v1
  // For now, use a WS URL env var or derive from config
  const wsUrl = _config.wsUrl;
  if (!wsUrl) {
    // WS API not configured yet — silently skip
    return;
  }

  // Clean up old connection
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  if (_connectWatchdog) { clearTimeout(_connectWatchdog); _connectWatchdog = null; }
  if (_ws) {
    _ws.removeAllListeners();
    _ws.terminate();
    _ws = null;
  }

  const url = `${wsUrl}?apiKey=${_config.apiKey}&role=bridge&device=${encodeURIComponent(_config.deviceName)}`;
  console.log(`[ws] connecting to ${wsUrl}...`);

  // Use the system resolver (default). A custom dns.resolve4 lookup was tried
  // here but it bypasses split-horizon/VPN DNS config and returns unreachable
  // public IPs (varying each call), causing WS handshake timeouts.
  _ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT });

  _connectWatchdog = setTimeout(() => {
    if (_ws && _ws.readyState !== WebSocket.OPEN) {
      console.log('[ws] connect timeout, forcing reconnect...');
      _ws.removeAllListeners();
      _ws.terminate();
      _ws = null;
      scheduleReconnect();
    }
  }, CONNECT_TIMEOUT);

  _ws.on('open', () => {
    if (_connectWatchdog) { clearTimeout(_connectWatchdog); _connectWatchdog = null; }
    console.log('[ws] connected');
    _consecutiveFailures = 0;
    _heartbeatTimer = setInterval(() => {
      if (_ws?.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ action: 'heartbeat' }));
      }
    }, HEARTBEAT_INTERVAL);
  });

  _ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      await handleMessage(msg);
    } catch (err) {
      console.error(`[ws] message error: ${err.message}`);
    }
  });

  _ws.on('close', (code, reason) => {
    console.log(`[ws] disconnected (code=${code}, reason=${reason?.toString() || ''}), reconnecting...`);
    scheduleReconnect();
  });

  _ws.on('error', (err) => {
    console.error(`[ws] error: ${err.message} (code: ${err.code}, type: ${err.type})`);
    scheduleReconnect();
  });

  _ws.on('unexpected-response', (_req, res) => {
    console.error(`[ws] unexpected-response: ${res.statusCode}`);
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      console.error(`[ws] response body: ${body.slice(0, 200)}`);
      scheduleReconnect();
    });
  });
}

function scheduleReconnect() {
  if (_reconnectTimer) return;
  _consecutiveFailures += 1;
  const delay = _consecutiveFailures >= SLOW_RECONNECT_THRESHOLD
    ? SLOW_RECONNECT_DELAY : RECONNECT_DELAY;
  if (_consecutiveFailures === SLOW_RECONNECT_THRESHOLD) {
    console.log(`[ws] ${_consecutiveFailures} failures, switching to 5-min reconnect interval`);
  }
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, delay);
}

async function handleMessage(msg) {
  switch (msg.action) {
    case 'sync_session':
      await handleSyncSession(msg.sessionId);
      break;
    case 'send_message':
      await handleSendMessage(msg.sessionId, msg.text, msg.projectHash, msg.requestId, msg.asAgent, msg.clientId, msg.streamMode);
      break;
    case 'permission_reply':
      handlePermissionReply(msg.sessionId, msg.approved);
      break;
    case 'create_project':
      await handleCreateProject(msg.projectPath, msg.asAgent);
      break;
    case 'interrupt':
      interruptSession(msg.sessionId);
      break;
    case 'reveal_agent':
      await handleRevealAgent(msg.sessionId);
      break;
    case 'request_file':
      await handleRequestFile(msg);
      break;
    case 'list_commands':
      handleListCommands(msg);
      break;
    case 'messages_ack': {
      const p = _pendingAcks.get(msg.sessionId);
      if (p) { clearTimeout(p.timer); _pendingAcks.delete(msg.sessionId); p.resolve(true); }
      break;
    }
    case 'heartbeat':
      // Server heartbeat response — no-op
      break;
    default:
      console.log(`[ws] unknown action: ${msg.action}`);
  }
}

async function handleSyncSession(sessionId) {
  console.log(`[ws] sync_session: ${sessionId.slice(0, 8)}`);
  const filePath = findSessionFile(sessionId);
  if (!filePath) {
    console.log(`[ws] session ${sessionId.slice(0, 8)} not found locally`);
    wsSend({ action: 'sync_complete', sessionId, status: 'not_found' });
    return;
  }

  const projectHash = path.basename(path.dirname(filePath));
  const projectDir = projectHashToPath(projectHash);
  const msgs = await readAllMessages(filePath, sessionId, projectDir);
  if (msgs.length > 0) {
    await uploadMessages(sessionId, msgs);
    console.log(`[ws] synced ${msgs.length} messages for ${sessionId.slice(0, 8)}`);
  }
  wsSend({ action: 'sync_complete', sessionId, status: 'ok', count: msgs.length });
}

async function handleSendMessage(sessionId, text, projectHash, requestId, asAgent, clientId, streamMode) {
  if (!text) return;
  if (!sessionId && !projectHash) return;

  // Detect claude-bridge: image references and download to local
  const imgPattern = /!\[.*?\]\(claude-bridge:(.+?)\)/g;
  let resolved = text;
  let match;
  while ((match = imgPattern.exec(text)) !== null) {
    const key = match[1];
    const localPath = await downloadBridgeImage(key);
    if (localPath) {
      resolved = resolved.replace(match[0], `![](${localPath})`);
    }
  }

  // Synthetic commands (e.g. /stats-models): CC has no such command, so send its
  // realCmd into tmux instead and remember the spec for nav-based capture below.
  let synthetic = null;
  const sm = /^\/([\w:-]+)\s*$/.exec(resolved.trim());
  if (sm && SYNTHETIC_COMMANDS[sm[1]]) {
    synthetic = SYNTHETIC_COMMANDS[sm[1]];
    resolved = synthetic.realCmd;
  }

  // Headless streaming path for existing sessions; falls through to tmux if it can't attempt.
  if (streamMode && sessionId) {
    const handled = await handleHeadlessSend(sessionId, resolved, clientId);
    if (handled) return;
  }

  // New session: create tmux + claude, send message, detect sessionId
  if (!sessionId && projectHash) {
    const lockKey = requestId || projectHash;

    // If already launching for this requestId, wait then send to existing session
    if (_launchLocks.has(lockKey)) {
      console.log(`[ws] waiting for in-flight launch (${lockKey.slice(0, 8)})...`);
      const prev = await _launchLocks.get(lockKey);
      if (prev.ok && prev.tmuxName) {
        try { sendKeys(prev.tmuxName, resolved); } catch {}
        wsSend({ action: 'send_message_result', ok: true, sessionId: prev.sessionId, requestId, clientId });
      } else {
        wsSend({ action: 'send_message_result', ok: false, error: 'Previous launch failed. Please try again.', requestId, clientId });
      }
      return;
    }

    const promise = asAgent
      ? handleNewAgentSession(projectHash, resolved)
      : handleNewSessionMessage(projectHash, resolved);
    _launchLocks.set(lockKey, promise);
    const result = await promise;
    setTimeout(() => _launchLocks.delete(lockKey), 30_000);
    wsSend({ action: 'send_message_result', ...result, requestId, clientId });
    return;
  }

  let result = sendMessageToSession(sessionId, resolved);

  if (!result.ok && result.error === 'no_tmux_target') {
    if (_launchLocks.has(sessionId)) {
      console.log(`[ws] waiting for in-flight launch (session ${sessionId.slice(0, 8)})...`);
      const prev = await _launchLocks.get(sessionId);
      if (prev.ok && prev.tmuxName) {
        try { sendKeys(prev.tmuxName, resolved); result = { ok: true }; } catch (err) { result = { ok: false, error: err.message }; }
      } else {
        result = { ok: false, error: 'Previous launch failed. Please try again.' };
      }
    } else {
      const isAgent = getDaemonSessions().has(sessionId);
      console.log(`[ws] no tmux target for ${sessionId.slice(0, 8)}, launching ${isAgent ? 'agents' : 'CC'}...`);

      const promise = isAgent
        ? launchAgentForSession(sessionId)
        : launchRegularForSession(sessionId);

      _launchLocks.set(sessionId, promise);
      const launchResult = await promise;
      setTimeout(() => _launchLocks.delete(sessionId), 30_000);

      if (launchResult.ok) {
        try { sendKeys(launchResult.tmuxName, resolved); result = { ok: true }; } catch (err) { result = { ok: false, error: err.message }; }
      } else {
        result = launchResult;
      }
    }
  }

  if (!result.ok) {
    console.log(`[ws] send_message failed: ${result.error}`);
  }
  wsSend({ action: 'send_message_result', sessionId, ...result, clientId });

  // "local" slash commands (e.g. /goal, /usage) render only in CC's terminal and
  // never reach the .jsonl. If we just sent one, grab its terminal output and push
  // it so the app shows the result instead of spinning forever.
  if (result.ok && sessionId) maybeCaptureLocalCommand(sessionId, resolved, requestId, synthetic);
}

// Headless streaming send for an existing session. Returns false only when no cwd (caller falls back).
async function handleHeadlessSend(sessionId, text, clientId) {
  const cwd = cwdForSession(sessionId);
  if (!cwd) return false;

  const streamId = crypto.randomUUID
    ? crypto.randomUUID()
    : 'sd-' + Date.now() + '-' + Math.random().toString(36).slice(2);

  let acked = false;
  const ack = (ok, error) => {
    if (acked) return;
    acked = true;
    wsSend({ action: 'send_message_result', sessionId, ok, error, clientId });
  };

  await _pool.send(sessionId, text, {
    cwd,
    resumeId: sessionId,
    streamId,
    onDelta: (sid, fullText, seq, blockId) => {
      wsSend({ action: 'stream_delta', sessionId, streamId: sid, text: fullText, seq, blockId });
    },
    onBlockStart: (sid, blockId, kind) => {
      wsSend({ action: 'stream_block_start', sessionId, streamId: sid, blockId, kind });
    },
    onBlockStop: (sid, blockId) => {
      wsSend({ action: 'stream_block_stop', sessionId, streamId: sid, blockId });
    },
    onResult: (sid, result) => {
      wsSend({ action: 'stream_end', sessionId, streamId: sid, error: result.is_error ? (result.subtype || 'error') : undefined });
    },
    onControlRequest: (req) => {
      const r = req.request || {};
      if (r.requires_user_interaction) return;
      _pool.replyControl(sessionId, req.request_id, { behavior: 'allow', updatedInput: r.input });
    },
    onError: (sid, err) => {
      console.log(`[ws] headless error for ${sessionId.slice(0, 8)}: code=${err.code} ${err.detail || ''}`);
      wsSend({ action: 'stream_end', sessionId, streamId: sid, error: 'unavailable' });
      ack(false, 'Session unavailable (busy elsewhere). Read-only.');
    },
  });

  ack(true);
  return true;
}

// If `text` is a bare local slash command, asynchronously capture its terminal
// output and push it to the app. Fire-and-forget — never blocks the send.
function maybeCaptureLocalCommand(sessionId, text, requestId, synthetic) {
  const m = /^\/([\w:-]+)\s*$/.exec((text || '').trim()); // bare "/cmd", no args
  if (!m) return; // args → triggers AI → shown via .jsonl, no capture needed
  const name = m[1].split(':').pop(); // strip plugin namespace
  // Synthetic commands always capture (realCmd's dialog + nav); else local-only.
  const dismiss = synthetic ? true : DIALOG_COMMANDS.has(name);
  if (!synthetic && !LOCAL_COMMANDS.has(name)) return;
  captureCommandOutput(sessionId, text, dismiss, synthetic || {})
    .then(ansi => {
      // Always reply (ansi may be empty) so the app can stop its spinner.
      wsSend({ action: 'command_output', sessionId, requestId, ansi: ansi || '' });
    })
    .catch(err => {
      console.error(`[ws] capture local cmd failed: ${err.message}`);
      wsSend({ action: 'command_output', sessionId, requestId, ansi: '' });
    });
}

async function handleNewSessionMessage(projectHash, text, rawProjectPath) {
  try {
    const projectPath = rawProjectPath || projectHashToPath(projectHash);
    const projectDir = path.join(CLAUDE_PROJECTS, projectHash);

    // Snapshot existing .jsonl files
    const before = new Set(fs.existsSync(projectDir)
      ? fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
      : []);

    const now = new Date();
    const ts = String(now.getMonth() + 1).padStart(2, '0')
      + String(now.getDate()).padStart(2, '0')
      + String(now.getHours()).padStart(2, '0')
      + String(now.getMinutes()).padStart(2, '0')
      + String(now.getSeconds()).padStart(2, '0');
    const projName = projectPath.split(path.sep).pop().replace(/[^a-zA-Z0-9_.-]/g, '_');
    const tmuxName = `apeek_${projName}_${ts}`;
    newTmuxSession(tmuxName, projectPath, 'claude');

    const ready = await waitForCCReady(tmuxName);
    if (!ready) {
      try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
      return { ok: false, error: 'Claude did not become ready after 30s.' };
    }

    sendKeys(tmuxName, text);

    // Poll for new .jsonl (CC creates it after receiving first message)
    let sessionId = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const after = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        const fresh = after.find(f => !before.has(f));
        if (fresh) { sessionId = fresh.replace('.jsonl', ''); break; }
      } catch {}
    }

    // Rename tmux session to include sessionId, matching launchClaudeSession convention
    // so findTmuxTargetForSession can find it by name suffix
    let finalTmuxName = tmuxName;
    if (sessionId) {
      finalTmuxName = `apeek_${projName}_${sessionId.slice(0, 8)}`;
      try {
        execSync(`tmux rename-session -t "${tmuxName}" "${finalTmuxName}"`, { stdio: 'ignore' });
      } catch {}
    }

    return { ok: true, sessionId, tmuxName: finalTmuxName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleNewAgentSession(projectHash, text) {
  try {
    const projectPath = projectHashToPath(projectHash);
    const projectDir = path.join(CLAUDE_PROJECTS, projectHash);
    const tmuxName = 'apeek_newagent';

    const before = new Set(fs.existsSync(projectDir)
      ? fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'))
      : []);

    newTmuxSession(tmuxName, projectPath, `claude agents --cwd "${projectPath}"`);

    const ready = await waitForAgentsTUI(tmuxName);
    if (!ready) {
      try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
      return { ok: false, error: 'claude agents TUI did not load' };
    }

    sendKeys(tmuxName, text);

    let sessionId = null;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const after = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        const fresh = after.find(f => !before.has(f));
        if (fresh) { sessionId = fresh.replace('.jsonl', ''); break; }
      } catch {}
    }

    try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    return { ok: true, sessionId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function waitForAgentsTUI(tmuxTarget) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const content = execSync(
        `tmux capture-pane -t "${tmuxTarget}" -p`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      if (content.includes('❯')) return true;
    } catch {}
  }
  return false;
}

async function handleCreateProject(rawPath, asAgent) {
  if (!rawPath) {
    wsSend({ action: 'create_project_result', ok: false, error: 'no path provided', projectPath: rawPath });
    return;
  }
  try {
    const home = os.homedir();
    let projectPath = rawPath;
    if (!projectPath.startsWith(home)) {
      projectPath = path.join(home, projectPath.replace(/^\/+/, ''));
    }
    console.log(`[ws] create_project: ${projectPath} (agent=${!!asAgent})`);
    fs.mkdirSync(projectPath, { recursive: true });
    const projectHash = path.resolve(projectPath).replace(/[^a-zA-Z0-9-]/g, '-');
    const result = asAgent
      ? await handleNewAgentSession(projectHash, 'Hello')
      : await handleNewSessionMessage(projectHash, 'Hello', projectPath);
    wsSend({ action: 'create_project_result', ...result, projectPath: rawPath });
  } catch (err) {
    wsSend({ action: 'create_project_result', ok: false, error: err.message, projectPath: rawPath });
  }
}

/**
 * Wait for Claude Code to be ready in a tmux pane.
 * Checks pane content for the '>' prompt. Polls every 500ms, up to 30s.
 */
async function waitForCCReady(tmuxTarget) {
  let trustAccepted = false;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const content = execSync(
        `tmux capture-pane -t "${tmuxTarget}" -p`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      // Trust dialog: auto-accept "Yes, I trust this folder" (once only — text lingers in pane buffer)
      if (!trustAccepted && /Yes, I trust this folder/m.test(content)) {
        execSync(`tmux send-keys -t "${tmuxTarget}" Enter`, { stdio: 'ignore' });
        console.log(`[ws] auto-accepted trust dialog for ${tmuxTarget}`);
        trustAccepted = true;
        continue;
      }
      // CC shows '>' or '❯' prompt when ready for input
      if (/^[>❯]\s*$/m.test(content)) return true;
    } catch {}
  }
  console.log(`[ws] CC did not become ready within 30s`);
  return false;
}

function launchForSession(sessionId) {
  const filePath = findSessionFile(sessionId);
  if (!filePath) return null;

  const parts = filePath.split(path.sep);
  const projIdx = parts.indexOf('projects');
  if (projIdx < 0 || projIdx + 1 >= parts.length) return null;
  const projectHash = parts[projIdx + 1];

  try {
    return launchClaudeSession(sessionId, projectHash);
  } catch (err) {
    console.log(`[ws] launchForSession failed: ${err.message}`);
    throw err;
  }
}

async function launchRegularForSession(sessionId) {
  let tmuxName;
  try { tmuxName = launchForSession(sessionId); } catch (err) { return { ok: false, error: err.message }; }
  if (!tmuxName) return { ok: false, error: 'Failed to launch Claude. Session file may be missing.' };
  const ready = await waitForCCReady(tmuxName);
  if (!ready) {
    try { execSync(`tmux kill-session -t "${tmuxName}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    return { ok: false, error: 'Claude did not become ready after 30s.' };
  }
  return { ok: true, tmuxName };
}

async function launchAgentForSession(sessionId, onRescueEscape) {
  const agentMeta = getAgentCwd(sessionId);
  if (!agentMeta) return { ok: false, error: 'Agent session metadata not found' };

  try {
    // The agents TUI labels a session by its name, falling back to the prompt text
    // (`intent`) when unnamed. Pass both so navigation can match reliably.
    const tmuxName = await launchAgentsSession(sessionId, agentMeta.cwd, agentMeta.name || agentMeta.intent, onRescueEscape);
    return { ok: true, tmuxName };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// App opened an agent whose AskUserQuestion is stuck in daemon memory (never
// flushed to jsonl — the daemon's state can even read 'done' while the question
// waits). Gate on hasNoDanglingTurn, not agentState: open the agents TUI,
// navigate in — waitForAgentPrompt sends Escape, arming the stall rescue so
// watcher.mjs hides the synthetic pair and tags the flushed tool_use for the
// app's rescued-wizard path.
async function handleRevealAgent(sessionId) {
  const dm = getDaemonSessions().get(sessionId);
  if (!dm) return;
  if (findTmuxTargetForSession(sessionId)) return;
  const fp = findSessionFile(sessionId);
  if (!fp || !hasNoDanglingTurn(fp)) return;
  if (_launchLocks.has(sessionId)) return;

  console.log(`[ws] reveal_agent: ${sessionId.slice(0, 8)}`);
  const promise = launchAgentForSession(sessionId, () => armStallRescue(sessionId));
  _launchLocks.set(sessionId, promise);
  await promise;
  setTimeout(() => _launchLocks.delete(sessionId), 30_000);
}

function getAgentCwd(sessionId) {
  if (!fs.existsSync(CLAUDE_JOBS)) return null;
  for (const dir of fs.readdirSync(CLAUDE_JOBS)) {
    const statePath = path.join(CLAUDE_JOBS, dir, 'state.json');
    if (!fs.existsSync(statePath)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      if (state.sessionId === sessionId && state.backend === 'daemon') {
        return {
          cwd: state.cwd || state.originCwd || '',
          name: state.name || '',
          intent: state.intent || '',
        };
      }
    } catch {}
  }
  return null;
}

const FILE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const VIDEO_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB — streamed to S3, never buffered
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi']);
const _uploadedFileKeys = new Set();

// Stream a large video straight to S3 via a presigned PUT (never through Lambda).
// Returns true on success. Skips the upload if the content-hash key already exists.
async function uploadVideo(absPath, key, size) {
  const prep = await post('/api/bridge/video-prepare', { key });
  if (!prep || !prep.ok) return false;
  let info;
  try { info = await prep.json(); } catch { return false; }
  if (info.error) return false;
  if (info.exists) return true; // already in S3 — reuse it
  if (!info.url) return false;
  try {
    const res = await fetch(info.url, {
      method: 'PUT',
      headers: { 'Content-Type': info.contentType, 'Content-Length': String(size) },
      body: fs.createReadStream(absPath),
      duplex: 'half',
    });
    return res.ok;
  } catch (err) {
    console.error(`[ws] video upload failed: ${err.message}`);
    return false;
  }
}

async function handleRequestFile(msg) {
  const { path: rawPath, projectHash, sessionId, requestId } = msg;
  const reply = (extra) => wsSend({ action: 'file_ready', requestId, sessionId, ...extra });
  if (!rawPath) return reply({ error: 'no path provided' });

  let absPath = rawPath;
  if (!path.isAbsolute(absPath)) {
    const dir = typeof projectHash === 'string' && projectHash ? projectHashToPath(projectHash) : null;
    if (!dir) return reply({ error: 'not found' });
    absPath = path.join(dir, absPath);
  }

  let st;
  try { st = fs.statSync(absPath); } catch { return reply({ error: 'not found', path: absPath }); }
  if (st.isDirectory()) return reply({ error: 'is a directory', path: absPath });

  const ext = path.extname(absPath).toLowerCase();
  const key = crypto.createHash('sha256').update(`${absPath}#${st.mtimeMs}#${st.size}`).digest('hex').slice(0, 16) + ext;

  if (VIDEO_EXT.has(ext)) {
    if (st.size > VIDEO_MAX_BYTES) return reply({ error: 'video too large', path: absPath });
    // Streaming a large video to S3 can far exceed the app's request timeout — send
    // an immediate ack so the app stops its timeout/retry and shows "uploading" instead.
    wsSend({ action: 'file_progress', requestId, sessionId, video: true });
    const ok = await uploadVideo(absPath, key, st.size);
    if (!ok) return reply({ error: 'upload failed', path: absPath });
    return reply({ key, path: absPath, size: st.size, video: true });
  }

  const isImage = IMAGE_EXT.has(ext);
  if (isImage && st.size > IMAGE_MAX_BYTES) return reply({ error: 'image too large', path: absPath });

  const truncated = !isImage && st.size > FILE_MAX_BYTES;
  const done = (extra) => reply({ key, path: absPath, size: st.size, truncated, image: isImage, ...extra });

  if (_uploadedFileKeys.has(key)) {
    _uploadedFileKeys.delete(key);
    _uploadedFileKeys.add(key);
    return done();
  }

  let buf;
  try {
    const cap = isImage ? st.size : Math.min(st.size, FILE_MAX_BYTES);
    const fd = fs.openSync(absPath, 'r');
    buf = Buffer.alloc(cap);
    fs.readSync(fd, buf, 0, cap, 0);
    fs.closeSync(fd);
  } catch { return reply({ error: 'not found' }); }

  if (!isImage && buf.subarray(0, 8192).includes(0)) return reply({ error: 'binary file' });

  // Drop a possibly-incomplete final line when truncated, so line matching stays clean.
  if (truncated) { const nl = buf.lastIndexOf(0x0a); if (nl > 0) buf = buf.subarray(0, nl); }

  const endpoint = isImage ? '/api/bridge/upload-image' : '/api/bridge/upload-file';
  const res = await post(endpoint, { key, data: buf.toString('base64') });
  if (!res || !res.ok) return reply({ error: 'upload failed' });

  _uploadedFileKeys.add(key);
  if (_uploadedFileKeys.size > 1000) _uploadedFileKeys.delete(_uploadedFileKeys.values().next().value);

  done();
}

function handleListCommands(msg) {
  const { projectHash, requestId } = msg;
  let commands = [];
  try {
    const dir = typeof projectHash === 'string' && projectHash ? projectHashToPath(projectHash) : null;
    commands = scanSlashCommands(dir);
  } catch (err) {
    console.error(`[ws] list_commands failed: ${err.message}`);
  }
  wsSend({ action: 'commands_list', requestId, commands });
}

async function downloadBridgeImage(key) {
  try {
    const tmpDir = path.join(os.homedir(), '.claude-bridge', 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const localPath = path.join(tmpDir, key);
    const url = `${_config.server}/api/bridge/image/${key}`;
    const res = await fetch(url, { headers: { 'x-api-key': _config.apiKey } });
    if (!res.ok) return null;
    // API Gateway returns base64-encoded body for binary responses
    const text = await res.text();
    const buf = Buffer.from(text, 'base64');
    // Verify it's a valid image (JPEG starts with FF D8)
    if (buf[0] === 0xFF && buf[1] === 0xD8) {
      fs.writeFileSync(localPath, buf);
    } else {
      // Might be raw binary (local dev), save as-is
      fs.writeFileSync(localPath, buf.length > 0 ? buf : text);
    }
    return localPath;
  } catch { return null; }
}

function handlePermissionReply(sessionId, approved) {
  if (!sessionId) return;
  const keys = typeof approved === 'string' ? approved : (approved ? 'y' : 'n');

  // escape = send Escape key (cancel prompt)
  if (keys === 'escape') {
    const result = sendKey(sessionId, 'Escape');
    if (!result.ok) console.log(`[ws] permission_reply failed: ${result.error}`);
    return;
  }

  // arrow:N = send N down-arrows then Enter (for AskUserQuestion navigation)
  if (keys.startsWith('arrow:')) {
    const n = parseInt(keys.slice(6), 10);
    const result = sendArrowSelect(sessionId, n);
    if (!result.ok) console.log(`[ws] permission_reply failed: ${result.error}`);
    return;
  }

  // type:N:text = navigate to "Type something" option N, type text, Enter
  if (keys.startsWith('type:')) {
    const parts = keys.split(':');
    const n = parseInt(parts[1], 10);
    const text = parts.slice(2).join(':'); // rejoin in case text contains ':'
    if (text) {
      const result = sendTypeInput(sessionId, n, text);
      if (!result.ok) console.log(`[ws] permission_reply failed: ${result.error}`);
    }
    return;
  }

  const result = sendMessageToSession(sessionId, keys);
  if (!result.ok) {
    console.log(`[ws] permission_reply failed: ${result.error}`);
  }
}
