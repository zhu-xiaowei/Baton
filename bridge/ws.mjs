import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { readAllMessages, uploadMessages } from './extract.mjs';
import { findSessionFile, projectHashToPath } from './session.mjs';
import { ClaudePool } from './headless.mjs';
import { post } from './http.mjs';
import { scanSlashCommands } from './commands.mjs';

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
      _pool.interrupt(msg.sessionId);
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

  // Headless streaming path for existing sessions.
  if (sessionId) {
    const handled = await handleHeadlessSend(sessionId, resolved, clientId);
    if (handled) return;
    wsSend({ action: 'send_message_result', sessionId, ok: false, error: 'Session unavailable.', clientId });
    return;
  }

  // New session (projectHash only): tmux-based creation removed. Headless
  // new-session (spawn without --resume, sessionId from system/init) not wired yet.
  wsSend({ action: 'send_message_result', ok: false, error: 'New session creation is not available yet.', requestId, clientId });
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

// New-session creation (regular + agent) and create_project were tmux-based and
// removed with tmux.mjs. Headless new-session (spawn without --resume, sessionId
// from system/init) is not wired yet.
async function handleCreateProject(rawPath) {
  wsSend({ action: 'create_project_result', ok: false, error: 'Project creation is not available yet.', projectPath: rawPath });
}

// App opened an agent whose AskUserQuestion was stuck in daemon memory. The old
// rescue drove the agents TUI over tmux (Escape to flush) — removed with tmux.
// Headless surfaces the question via control_request instead (not wired yet).
async function handleRevealAgent(_sessionId) {
  // no-op until the headless permission path lands
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

// Permission replies were driven over tmux (arrow-nav / type / Escape into CC's
// TUI) and removed with tmux.mjs. Under headless, permissions arrive as
// control_requests and are answered via _pool.replyControl — not wired to the
// app's reply protocol yet.
function handlePermissionReply(_sessionId, _approved) {
  // no-op until the headless permission path lands
}
