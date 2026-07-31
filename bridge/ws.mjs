import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { readAllMessages, uploadMessages, extractForApp, truncateToBytes, synced, countJsonlLines } from './extract.mjs';
import { findSessionFile, projectHashToPath, getDaemonRunningSessionIds, getAgentsJson, resolveClaudeBin } from './session.mjs';
import { WS_FRAME_LIMIT, CLAUDE_PROJECTS } from './config.mjs';
import { ClaudePool } from './headless.mjs';
import { post } from './http.mjs';
import { scanSlashCommands } from './commands.mjs';
import { updateSessionStatus, knownProjects } from './sync.mjs';

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

// onExit: a proc left the pool (reap/LRU/crash) without a turn result → settle to completed.
const _pool = new ClaudePool({ onExit: (sessionId) => syncPoolStatus(sessionId, 'completed') });

// True while the pool has a live process for this session — its status is owned
// by pool lifecycle events, so the jsonl watcher must not also write it.
export function poolOwns(sessionId) { return _pool.owns(sessionId); }

// uuids headless already broadcast live (stdout always beats jsonl landing, measured
// 100ms~several s). watcher checks this so the later jsonl copy only writes DDB, not WS.
// Cap holds many turns' worth (one heavy multi-tool turn ≈ 25 rows) so no uuid is
// evicted before its lagging jsonl copy arrives; a stale miss only costs a harmless
// re-push (still app-side uuid-deduped).
const _headlessPushed = new Set();
const _headlessOrder = [];        // FIFO, caps the set at recent messages
const HEADLESS_PUSHED_CAP = 256;
export function markHeadlessPushed(uuid) {
  if (!uuid || _headlessPushed.has(uuid)) return;
  _headlessPushed.add(uuid);
  _headlessOrder.push(uuid);
  if (_headlessOrder.length > HEADLESS_PUSHED_CAP) _headlessPushed.delete(_headlessOrder.shift());
}
export function headlessPushed(uuid) { return _headlessPushed.has(uuid); }

// Pending control_request per session (CC blocks one tool call at a time).
const _pendingControl = new Map(); // sessionId → { requestId, toolName, toolUseId, input, requiresInteraction }

function cwdForSession(sessionId) {
  const filePath = findSessionFile(sessionId);
  if (!filePath) return null;
  const projectHash = path.basename(path.dirname(filePath));
  return projectHashToPath(projectHash);
}

// Push a pool-owned session's status to DDB (dedup + counter delta live in updateSessionStatus).
async function syncPoolStatus(sessionId, status) {
  const filePath = findSessionFile(sessionId);
  if (!filePath || !_config) return;
  const projectHash = path.basename(path.dirname(filePath));
  try { await updateSessionStatus(_config, sessionId, filePath, projectHash, status); } catch {}
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
      await handleSendMessage(msg.sessionId, msg.text, msg.projectHash, msg.requestId, msg.asAgent, msg.clientId);
      break;
    case 'permission_reply':
      handlePermissionReply(msg);
      break;
    case 'create_project':
      await handleCreateProject(msg.projectPath, msg.asAgent);
      break;
    case 'interrupt':
      _pool.interrupt(msg.sessionId);
      break;
    case 'reveal_agent':
      await handleRevealAgent(msg.sessionId);
      break;
    case 'request_file':
      await handleRequestFile(msg);
      break;
    case 'delete_files':
      handleDeleteFiles(msg);
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
    // Fresh pool session whose jsonl hasn't landed yet → ok/empty, not not_found (which wipes the live view).
    if (_pool.owns(sessionId)) {
      wsSend({ action: 'sync_complete', sessionId, status: 'ok', count: 0 });
      return;
    }
    console.log(`[ws] session ${sessionId.slice(0, 8)} not found locally`);
    wsSend({ action: 'sync_complete', sessionId, status: 'not_found' });
    return;
  }

  const msgs = await readAllMessages(filePath, sessionId);
  if (msgs.length > 0) {
    await uploadMessages(sessionId, msgs);
    console.log(`[ws] synced ${msgs.length} messages for ${sessionId.slice(0, 8)}`);
  }
  wsSend({ action: 'sync_complete', sessionId, status: 'ok', count: msgs.length });
}

async function handleSendMessage(sessionId, text, projectHash, requestId, asAgent, clientId) {
  if (!text) return;
  if (!sessionId && !projectHash) return;

  const resolved = await resolveBridgeImages(text);

  // Existing session (regular or agent): headless streaming with daemon takeover.
  if (sessionId) {
    const handled = await handleHeadlessSend(sessionId, resolved, clientId, projectHash);
    if (handled) return;
    wsSend({ action: 'send_message_result', sessionId, ok: false, error: 'Session unavailable.', clientId });
    return;
  }

  // New session (projectHash only): agent → detached `claude --bg`; regular → headless stream.
  const cwd = projectHashToPath(projectHash);
  if (!cwd) {
    wsSend({ action: 'send_message_result', ok: false, error: 'Project path not found.', requestId, clientId });
    return;
  }
  // Project dir deleted/never-existed → recreate so CC can spawn there.
  try { if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true }); } catch {}
  if (asAgent) {
    const r = await newAgentSession(cwd, resolved);
    wsSend({ action: 'send_message_result', ok: r.ok, sessionId: r.sessionId, error: r.error, requestId, clientId });
  } else {
    await newRegularSession(cwd, resolved, requestId, clientId);
  }
}

// Replace claude-bridge: image refs with downloaded local paths CC's Read can open.
async function resolveBridgeImages(text) {
  const imgPattern = /!\[.*?\]\(claude-bridge:(.+?)\)/g;
  let resolved = text;
  let match;
  while ((match = imgPattern.exec(text)) !== null) {
    const localPath = await downloadBridgeImage(match[1]);
    if (localPath) resolved = resolved.replace(match[0], `![](${localPath})`);
  }
  return resolved;
}

const newStreamId = () => (crypto.randomUUID
  ? crypto.randomUUID()
  : 'sd-' + Date.now() + '-' + Math.random().toString(36).slice(2));

// Per-turn streaming callbacks shared by resume + new-regular sends (frames key off sessionId; streamId comes from each callback's `sid` arg).
function buildStreamCallbacks(sessionId, cwd, ack) {
  return {
    // Increment-only chunks + turn-level seq → app reorders by seq (see web/js/reorder.js).
    onDelta: (sid, chunk, seq, blockId) => {
      wsSend({ action: 'stream_delta', sessionId, streamId: sid, chunk, seq, blockId });
    },
    onInputDelta: (sid, chunk, seq, blockId) => {
      wsSend({ action: 'stream_tool_input', sessionId, streamId: sid, chunk, seq, blockId });
    },
    onBlockStart: (sid, blockId, kind, name, seq) => {
      wsSend({ action: 'stream_block_start', sessionId, streamId: sid, blockId, kind, name, seq });
    },
    onBlockStop: (sid, blockId, seq) => {
      wsSend({ action: 'stream_block_stop', sessionId, streamId: sid, blockId, seq });
    },
    // Full authoritative row; noCache so watcher owns DDB persistence. App dedupes by uuid.
    onMessage: async (sid, raw) => {
      try {
        const msg = await extractForApp(raw, cwd);
        if (!msg.uuid) return;
        let out = msg;
        if (Buffer.byteLength(JSON.stringify({ action: 'messages', sessionId, messages: [msg] })) > WS_FRAME_LIMIT) {
          out = truncateToBytes(msg, WS_FRAME_LIMIT - 512);
          out.truncated = true;
        }
        // streamId ties this row (user echo + assistant) to its send → app places/dedupes by identity.
        wsSend({ action: 'messages', sessionId, streamId: sid, messages: [out], noCache: true });
        markHeadlessPushed(msg.uuid); // watcher skips WS for this uuid's jsonl copy
      } catch (e) {
        console.log(`[ws] headless onMessage extract failed: ${e.message}`);
      }
    },
    onResult: (sid, result, finalSeq) => {
      wsSend({ action: 'stream_end', sessionId, streamId: sid, finalSeq, error: result.is_error ? (result.subtype || 'error') : undefined });
      // A turn awaiting a permission reply stays needs_input; otherwise the turn is done.
      syncPoolStatus(sessionId, _pendingControl.has(sessionId) ? 'needs_input' : 'completed');
    },
    onControlRequest: (req) => {
      const r = req.request || {};
      const input = r.input || {};
      // Surface to the app → permission_reply → handlePermissionReply (bypass mode never gets here).
      _pendingControl.set(sessionId, {
        requestId: req.request_id, toolName: r.tool_name,
        input, requiresInteraction: !!r.requires_user_interaction,
      });
      syncPoolStatus(sessionId, 'needs_input');
      let kind = 'tool';
      if (r.requires_user_interaction) {
        kind = (r.tool_name === 'ExitPlanMode' || r.tool_name === 'exit_plan_mode') ? 'plan' : 'ask';
      }
      wsSend({
        action: 'permission_request', sessionId, kind,
        requestId: req.request_id, toolName: r.tool_name,
        questions: input.questions, plan: input.plan, input,
      });
    },
    onError: (sid, err) => {
      console.log(`[ws] headless error for ${sessionId.slice(0, 8)}: code=${err.code} ${err.detail || ''}`);
      wsSend({ action: 'stream_end', sessionId, streamId: sid, error: 'unavailable' });
      ack(false, 'Session unavailable (busy elsewhere). Read-only.');
    },
  };
}

// Send to an existing session (regular OR agent), taking a daemon-held agent over into the pool via stopDaemon + --resume. See docs/headless-streaming.md §takeover.
async function handleHeadlessSend(sessionId, text, clientId, projectHash) {
  // cwd from projectHash (works even if jsonl was deleted); fall back to jsonl reverse-lookup.
  let cwd = projectHash ? projectHashToPath(projectHash) : null;
  if (!cwd) cwd = cwdForSession(sessionId);
  if (!cwd) return false;
  // Deleted/never-existed project dir → recreate so headless can spawn there (cheap: microseconds).
  try { if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true }); } catch {}

  // Baseline synced to the current jsonl length before this turn appends — else an old session with no synced entry gets its whole history re-pushed by the watcher (flicker). App already has history via REST.
  if (!synced.has(sessionId)) {
    const fp = findSessionFile(sessionId);
    if (fp) { try { synced.set(sessionId, countJsonlLines(fp)); } catch {} }
  }

  const streamId = newStreamId();
  let acked = false;
  const ack = (ok, error) => {
    if (acked) return;
    acked = true;
    // streamId lets the app bind this clientId to the turn's stream frames (which carry only streamId).
    wsSend({ action: 'send_message_result', sessionId, ok, error, clientId, streamId });
  };

  // Not in pool but daemon holds it → release so --resume can take over.
  if (!_pool.owns(sessionId) && getDaemonRunningSessionIds().has(sessionId)) {
    _pool.stopDaemon(sessionId);
  }

  syncPoolStatus(sessionId, 'running');

  const cb = buildStreamCallbacks(sessionId, cwd, ack);
  let res = await _pool.send(sessionId, text, { cwd, resumeId: sessionId, streamId, ...cb });
  // Roster read was stale (raced a still-active daemon agent) → stop + retry once.
  if (res && res.bgLocked) {
    _pool.stopDaemon(sessionId);
    res = await _pool.send(sessionId, text, { cwd, resumeId: sessionId, streamId, ...cb });
  }

  ack(true);
  return true;
}

// New regular session: mint sessionId upfront (--session-id), ack it FIRST so the app subscribes before deltas flow, then stream the first turn.
async function newRegularSession(cwd, text, requestId, clientId) {
  const sessionId = crypto.randomUUID();
  const streamId = newStreamId();
  // Ack sid before spawn → app subscribes; any pre-subscribe delta is corrected by the authoritative row + bufferAndFetch.
  wsSend({ action: 'send_message_result', sessionId, ok: true, requestId, clientId, streamId });
  syncPoolStatus(sessionId, 'running');
  const cb = buildStreamCallbacks(sessionId, cwd, () => {});
  await _pool.send(sessionId, text, { cwd, createId: sessionId, streamId, ...cb });
}

// New agent: launch detached `claude --bg` (can't pool — conflicts with -p), parse its `backgrounded · <shortid>`, resolve full sid via `claude agents --json`. First task shows via agent poll + watcher; next message takes it over (handleHeadlessSend).
async function newAgentSession(cwd, text) {
  const bin = resolveClaudeBin() || 'claude';
  let out = '';
  try {
    out = await new Promise((resolve, reject) => {
      const p = spawn(bin, ['--bg', text], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      p.stdout.on('data', (d) => { buf += d.toString(); });
      p.stderr.on('data', (d) => { buf += d.toString(); });
      p.on('close', () => resolve(buf));
      p.on('error', reject);
    });
  } catch (e) {
    return { ok: false, error: `Failed to launch agent: ${e.message}` };
  }

  const m = out.match(/backgrounded[^\n]*?\b([0-9a-f]{8})\b/i);
  if (!m) return { ok: false, error: 'Agent launch did not report a session id.' };
  const shortId = m[1];

  // Resolve full sessionId (daemon writes it lazily → retry a few times).
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    for (const sid of getAgentsJson(true).keys()) {
      if (sid.startsWith(shortId)) return { ok: true, sessionId: sid };
    }
  }
  // Fallback: scan the project dir for a fresh jsonl matching the short id.
  const dir = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const proj of fs.readdirSync(dir)) {
      const f = fs.readdirSync(path.join(dir, proj)).find((n) => n.startsWith(shortId) && n.endsWith('.jsonl'));
      if (f) return { ok: true, sessionId: f.replace('.jsonl', '') };
    }
  } catch {}
  return { ok: false, error: 'Agent launched but its session id could not be resolved yet.' };
}

// Create a new project directory and return its projectHash. No session is
// spawned — the app enters its new-session input and the user's first real
// message creates the session (SESS#/PROJ# land then). An empty project has no
// SESS# row, so it can't appear in the list until that first message anyway.
async function handleCreateProject(rawPath, asAgent) {
  if (!rawPath) {
    wsSend({ action: 'create_project_result', ok: false, error: 'no path provided', projectPath: rawPath });
    return;
  }
  try {
    const home = os.homedir();
    let projectPath = rawPath;
    if (!path.isAbsolute(projectPath)) projectPath = path.join(home, projectPath.replace(/^\/+/, ''));
    else if (!projectPath.startsWith(home)) projectPath = path.join(home, projectPath.replace(/^\/+/, ''));
    fs.mkdirSync(projectPath, { recursive: true });
    // Hash rule mirrors session.mjs — the dir now exists so projectHashToPath reverses it on first send.
    const projectHash = path.resolve(projectPath).replace(/[^a-zA-Z0-9-]/g, '-');
    const projectName = path.basename(projectPath); // breadcrumb label (matches the list's trailing-segment name)
    // Seed an empty PROJ# row so the project shows in the list right away (before its first session).
    try {
      await post('/api/bridge/create-project', {
        deviceName: _config.deviceName, projectHash, projectName, os: process.platform,
      });
      knownProjects.add(projectHash); // watcher won't re-reconcile it as a brand-new project
    } catch {}
    wsSend({ action: 'create_project_result', ok: true, projectHash, projectName, projectPath: rawPath, asAgent: !!asAgent });
  } catch (err) {
    wsSend({ action: 'create_project_result', ok: false, error: err.message, projectPath: rawPath });
  }
}

// App (re)subscribed: re-push any control_request still awaiting an answer so a refresh/reconnect re-shows the prompt.
async function handleRevealAgent(sessionId) {
  const p = _pendingControl.get(sessionId);
  if (!p) return;
  const kind = p.requiresInteraction ? (p.toolName === 'ExitPlanMode' || p.toolName === 'exit_plan_mode' ? 'plan' : 'ask') : 'tool';
  wsSend({
    action: 'permission_request', sessionId, kind,
    requestId: p.requestId, toolName: p.toolName,
    questions: p.input.questions, plan: p.input.plan, input: p.input,
  });
}

// Delete on-disk jsonl for sessions/projects (opt-in; DDB rows already removed via REST).
// Only touches paths inside CLAUDE_PROJECTS — never the user's real project/code dir.
function handleDeleteFiles(msg) {
  const root = path.resolve(CLAUDE_PROJECTS);
  const inRoot = (p) => { const r = path.resolve(p); return r === root || r.startsWith(root + path.sep); };
  const rmSafe = (p) => { try { if (inRoot(p)) fs.rmSync(p, { recursive: true, force: true }); } catch (e) { console.log(`[ws] delete failed ${p}: ${e.message}`); } };

  for (const sid of msg.sessionIds || []) {
    const fp = findSessionFile(sid);
    if (fp) rmSafe(fp);
    synced.delete(sid);
  }
  for (const ph of msg.projectHashes || []) {
    if (!ph || ph.includes('/') || ph.includes('..')) continue; // hash is a flat dir name
    rmSafe(path.join(root, ph)); // the CLAUDE_PROJECTS/<hash> dir holds the jsonl, NOT the real cwd
  }
  console.log(`[ws] deleted files: ${(msg.sessionIds || []).length} sessions, ${(msg.projectHashes || []).length} projects`);
  wsSend({ action: 'delete_files_result', requestId: msg.requestId, ok: true });
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

// App answered permission_request: tools → allow/deny; ask/plan → deny with answerText in message (CC's only answer channel, verified CC 2.1.211).
function handlePermissionReply(msg) {
  const { sessionId, requestId, decision, answerText } = msg;
  const pending = _pendingControl.get(sessionId);
  if (!pending || (requestId && pending.requestId !== requestId)) return;
  _pendingControl.delete(sessionId);

  if (pending.requiresInteraction) {
    // ask/plan answer → deny+message (CC renders it as the OUT); cancel → deny+interrupt (CC stops, no reply).
    if (decision === 'answer' && answerText) {
      _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: answerText });
    } else {
      _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: 'The user did not answer.', interrupt: true });
    }
    syncPoolStatus(sessionId, 'running'); // turn resumes; onResult settles to completed
    return;
  }
  // Ordinary tool: allow (input unchanged) or deny.
  if (decision === 'allow') {
    _pool.replyControl(sessionId, pending.requestId, { behavior: 'allow', updatedInput: pending.input });
  } else {
    _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: 'User denied this tool call.' });
  }
  syncPoolStatus(sessionId, 'running'); // turn resumes; onResult settles to completed
}
