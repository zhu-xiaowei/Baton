import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { uploadMessages, extractForApp, truncateToBytes, synced, countJsonlLines } from './extract.mjs';
import { projectHashToPath, getDaemonRunningSessionIds, getAgentsJson, resolveClaudeBin } from './session.mjs';
import { parseStorageSessionId } from './session-identity.mjs';
import { getRuntimeAdapter, runtimeAdapters } from './runtime-registry.mjs';
import { WS_FRAME_LIMIT } from './config.mjs';
import { ClaudePool } from './headless.mjs';
import {
  liveMessagePushed,
  liveMessageStream,
  markLiveMessagePushed,
  registerLiveMessageStream,
} from './live-message-registry.mjs';
import { post } from './http.mjs';
import { scanSlashCommands } from './commands.mjs';
import { updateSessionStatus, knownProjects } from './sync.mjs';
import { BRIDGE_VERSION } from './version.mjs';
import { PermissionQueue } from './permission-queue.mjs';
import { ClaudeHookServer } from './claude-hook.mjs';

let _ws = null;
let _config = null;
let _reconnectTimer = null;
let _heartbeatTimer = null;
let _connectWatchdog = null;
let _consecutiveFailures = 0;
const _sendWhenConnected = [];
const HEARTBEAT_INTERVAL = 4 * 60_000;
const RECONNECT_DELAY = 5_000;
const SLOW_RECONNECT_DELAY = 5 * 60_000;
const CONNECT_TIMEOUT = 15_000;
const SLOW_RECONNECT_THRESHOLD = 12;

// onExit only fires when a process exits during an active turn.
const _pool = new ClaudePool({ onExit: (sessionId) => syncPoolStatus(sessionId, 'completed') });
const _claudeRuntime = getRuntimeAdapter('claude');
let _claudeHookServer = null;

// Idle pooled processes do not block terminal-driven status updates.
export function poolOwns(sessionId) { return _pool.isBusy(sessionId); }

export async function shutdownInteractions() {
  _pool.shutdownAll();
  await _claudeHookServer?.close();
  _claudeHookServer = null;
  await Promise.allSettled(
    runtimeAdapters
      .map((adapter) => adapter.interaction?.shutdown?.())
      .filter(Boolean),
  );
}

// uuids headless already broadcast live (stdout always beats jsonl landing, measured
// 100ms~several s). watcher checks this so the later jsonl copy only writes DDB, not WS.
// Cap holds many turns' worth (one heavy multi-tool turn ≈ 25 rows) so no uuid is
// evicted before its lagging jsonl copy arrives; a stale miss only costs a harmless
// re-push (still app-side uuid-deduped).
export function markHeadlessPushed(uuid, streamId = '') {
  markLiveMessagePushed('claude', uuid, streamId);
}
export function headlessPushed(uuid) { return liveMessagePushed('claude', uuid); }
export function headlessStream(uuid) { return liveMessageStream('claude', uuid); }

// Codex may issue several approvals in parallel. Match its TUI: keep the first
// visible and process later requests newest-first.
const _pendingControl = new PermissionQueue();
const _statusSyncs = new Map();

function cwdForSession(sessionId) {
  const filePath = _claudeRuntime.findSessionFile(sessionId);
  if (!filePath) return null;
  const projectHash = path.basename(path.dirname(filePath));
  return projectHashToPath(projectHash);
}

// Push an interaction-owned session's status to DDB.
function syncInteractionStatus(sessionId, status, detail, runtimeHint) {
  const identity = parseStorageSessionId(sessionId, runtimeHint);
  const key = identity.sessionId;
  const previous = _statusSyncs.get(key) || Promise.resolve();
  const next = previous.then(async () => {
    const adapter = getRuntimeAdapter(identity.runtime);
    const filePath = adapter.findSessionFile(identity.nativeSessionId);
    if (!filePath || !_config) return;
    const projectHash = path.basename(path.dirname(filePath));
    try {
      await updateSessionStatus(
        _config,
        identity.sessionId,
        filePath,
        projectHash,
        status,
        detail,
        identity.runtime,
      );
    } catch {}
  });
  _statusSyncs.set(key, next);
  next.finally(() => {
    if (_statusSyncs.get(key) === next) _statusSyncs.delete(key);
  });
  return next;
}

function syncPoolStatus(sessionId, status, detail) {
  return syncInteractionStatus(sessionId, status, detail, 'claude');
}

function controlDetail(p) {
  if (!p) return '';
  const input = p.input || {};
  if (Array.isArray(input.questions) && input.questions.length) return input.questions[0].question || '';
  if (p.toolName === 'ExitPlanMode' || p.toolName === 'exit_plan_mode') return 'Review plan';
  return input.command || input.file_path || input.path || p.toolName || '';
}

export function pendingInteractionDetail(sessionId) {
  const pending = _pendingControl.current(sessionId);
  return pending ? controlDetail(pending) : null;
}

function permissionKind(p) {
  if (!p.requiresInteraction) return 'tool';
  return p.toolName === 'ExitPlanMode' || p.toolName === 'exit_plan_mode' ? 'plan' : 'ask';
}

function sendPermissionRequest(sessionId, p) {
  wsSend({
    action: 'permission_request',
    sessionId,
    kind: permissionKind(p),
    requestId: p.requestId,
    toolName: p.toolName,
    approvalType: p.approvalType || null,
    questions: p.input.questions,
    plan: p.input.plan,
    input: p.input,
  });
}

function clearPendingControls(sessionId) {
  const cleared = _pendingControl.clear(sessionId);
  if (cleared?.current) {
    wsSend({
      action: 'permission_resolved',
      sessionId,
      requestId: cleared.current.requestId,
    });
  }
}

function dismissPendingControl(sessionId, requestId) {
  const dismissed = _pendingControl.dismiss(sessionId, requestId);
  if (!dismissed || dismissed.current) return;
  wsSend({ action: 'permission_resolved', sessionId, requestId });
  if (dismissed.next) {
    sendPermissionRequest(sessionId, dismissed.next);
  }
  const statusTarget = dismissed.next || dismissed.resolved;
  if (statusTarget.syncStatus) {
    syncInteractionStatus(
      sessionId,
      dismissed.next ? 'needs_input' : 'running',
      controlDetail(dismissed.next),
      statusTarget.runtime,
    );
  }
}

function handleClaudeHookRequest(input, reply) {
  const sessionId = input.session_id;
  const toolName = input.tool_name;
  const toolUseId = input.tool_use_id;
  if (!sessionId || !toolName || !toolUseId) {
    reply({ action: 'pass' });
    return null;
  }

  const requestId = `hook:${toolUseId}`;
  const requiresInteraction = toolName === 'AskUserQuestion'
    || toolName === 'ExitPlanMode'
    || toolName === 'exit_plan_mode';
  const queued = _pendingControl.enqueue(sessionId, {
    requestId,
    toolName,
    input: input.tool_input || {},
    requiresInteraction,
    runtime: 'claude',
    nativeSessionId: sessionId,
    syncStatus: true,
    hookReply: reply,
  });
  syncInteractionStatus(sessionId, 'needs_input', controlDetail(queued.current), 'claude');
  if (queued.shouldPresent) sendPermissionRequest(sessionId, queued.current);
  return () => dismissPendingControl(sessionId, requestId);
}

export function initWs(config) {
  _config = config;
  if (!_claudeHookServer) {
    _claudeHookServer = new ClaudeHookServer({ onRequest: handleClaudeHookRequest });
    _claudeHookServer.start()
      .then(() => console.log('[hook] Claude relay ready'))
      .catch((error) => {
        console.log(`[hook] Claude relay unavailable: ${error.message}`);
        _claudeHookServer = null;
      });
  }
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

export function wsSendWhenConnected(data) {
  if (wsSend(data)) return true;
  _sendWhenConnected.push(data);
  return false;
}

// Ack-based send: resolves true if server acks within timeout, false otherwise
const _pendingAcks = new Map(); // sessionId → { resolve, timer }

export function wsSendWithAck(data, timeout = 5000) {
  return new Promise((resolve) => {
    const sid = data.sessionId;
    if (_pendingAcks.has(sid) || !wsSend(data)) return resolve(false);
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

  const url = `${wsUrl}?apiKey=${_config.apiKey}&role=bridge`
    + `&device=${encodeURIComponent(_config.deviceName)}`
    + `&version=${encodeURIComponent(BRIDGE_VERSION)}`;
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
    while (_sendWhenConnected.length > 0) {
      const queued = _sendWhenConnected.shift();
      if (!wsSend(queued)) {
        _sendWhenConnected.unshift(queued);
        break;
      }
    }
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
      await handleSyncSession(msg.sessionId, msg.runtime, msg.nativeSessionId);
      break;
    case 'send_message':
      await handleSendMessage(
        msg.sessionId,
        msg.text,
        msg.projectHash,
        msg.requestId,
        msg.asAgent,
        msg.clientId,
        msg.runtime,
        msg.takeover,
        msg.expectedWriterPid,
      );
      break;
    case 'permission_reply':
      handlePermissionReply(msg);
      break;
    case 'create_project':
      await handleCreateProject(msg.projectPath, msg.asAgent);
      break;
    case 'interrupt':
      {
        const identity = parseStorageSessionId(msg.sessionId, msg.runtime);
        const adapter = getRuntimeAdapter(identity.runtime);
        if (adapter.features.interrupt) {
          if (adapter.interaction?.interrupt) adapter.interaction.interrupt(identity.nativeSessionId);
          else _pool.interrupt(identity.nativeSessionId);
        }
      }
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

async function handleSyncSession(sessionId, runtime, nativeSessionId) {
  const identity = parseStorageSessionId(sessionId, runtime);
  if (nativeSessionId) identity.nativeSessionId = nativeSessionId;
  const adapter = getRuntimeAdapter(identity.runtime);
  console.log(`[ws] sync_session: ${identity.runtime}:${identity.nativeSessionId.slice(0, 8)}`);
  const filePath = adapter.findSessionFile(identity.nativeSessionId);
  if (!filePath) {
    // Fresh pool session whose jsonl hasn't landed yet → ok/empty, not not_found (which wipes the live view).
    if (adapter.ownsLiveSession?.(identity.nativeSessionId, { pool: _pool })) {
      wsSend({ action: 'sync_complete', sessionId, status: 'ok', count: 0 });
      return;
    }
    console.log(`[ws] session ${sessionId.slice(0, 8)} not found locally`);
    wsSend({ action: 'sync_complete', sessionId, status: 'not_found' });
    return;
  }

  const { messages } = await adapter.syncAllMessages({
    runtime: identity.runtime,
    nativeSessionId: identity.nativeSessionId,
    _filePath: filePath,
  }, {
    storageSessionId: identity.sessionId,
    watermarks: synced,
    uploader: uploadMessages,
  });
  if (messages.length > 0) {
    console.log(`[ws] synced ${messages.length} messages for ${identity.runtime}:${identity.nativeSessionId.slice(0, 8)}`);
  }
  wsSend({ action: 'sync_complete', sessionId: identity.sessionId, status: 'ok', count: messages.length });
}

async function handleSendMessage(
  sessionId,
  text,
  projectHash,
  requestId,
  asAgent,
  clientId,
  runtime,
  takeover,
  expectedWriterPid,
) {
  if (!text) return;
  if (!sessionId && !projectHash) return;
  const identity = parseStorageSessionId(sessionId || '', runtime);
  const adapter = getRuntimeAdapter(identity.runtime);
  const allowed = sessionId ? adapter.features.send : adapter.features.create;
  if (!allowed) {
    wsSend({
      action: 'send_message_result',
      sessionId,
      ok: false,
      error: sessionId
        ? `${adapter.displayName} sessions are read-only in this Bridge version.`
        : `${adapter.displayName} session creation is unavailable.`,
      requestId,
      clientId,
    });
    return;
  }

  const resolved = await resolveBridgeImages(text);

  // Existing session: route through the runtime interaction adapter when available.
  if (sessionId) {
    const handled = adapter.interaction
      ? await handleAdapterSend(
        adapter,
        identity,
        resolved,
        clientId,
        { takeover: !!takeover, expectedWriterPid },
      )
      : await handleHeadlessSend(identity.nativeSessionId, resolved, clientId, projectHash);
    if (handled) return;
    wsSend({ action: 'send_message_result', sessionId, ok: false, error: 'Session unavailable.', clientId });
    return;
  }

  // New session (projectHash only): dispatch creation through the selected runtime.
  const cwd = projectHashToPath(projectHash);
  if (!cwd) {
    wsSend({ action: 'send_message_result', ok: false, error: 'Project path not found.', requestId, clientId });
    return;
  }
  // Project dir deleted/never-existed → recreate so the runtime can spawn there.
  try { if (!fs.existsSync(cwd)) fs.mkdirSync(cwd, { recursive: true }); } catch {}
  if (identity.runtime === 'claude' && asAgent) {
    const r = await newAgentSession(cwd, resolved);
    wsSend({ action: 'send_message_result', ok: r.ok, sessionId: r.sessionId, error: r.error, requestId, clientId });
  } else if (adapter.interaction?.create) {
    await newAdapterSession(adapter, cwd, resolved, requestId, clientId);
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
function buildStreamCallbacks(sessionId, cwd, ack, options = {}) {
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
    onMessage: async (sid, raw, meta = {}) => {
      try {
        if (!meta.runtime && raw?.uuid) {
          registerLiveMessageStream('claude', raw.uuid, sid);
        }
        const msg = meta.normalized ? raw : await extractForApp(raw, cwd);
        if (!msg.uuid) return;
        let out = msg;
        if (Buffer.byteLength(JSON.stringify({ action: 'messages', sessionId, messages: [msg] })) > WS_FRAME_LIMIT) {
          out = truncateToBytes(msg, WS_FRAME_LIMIT - 512);
          out.truncated = true;
        }
        // streamId ties this row (user echo + assistant) to its send → app places/dedupes by identity.
        if (meta.runtime && meta.liveKey) {
          markLiveMessagePushed(meta.runtime, meta.liveKey, sid);
        } else {
          markHeadlessPushed(msg.uuid, sid);
        }
        wsSend({ action: 'messages', sessionId, streamId: sid, messages: [out], noCache: true });
      } catch (e) {
        console.log(`[ws] live message extract failed: ${e.message}`);
      }
    },
    onResult: (sid, result, finalSeq) => {
      wsSend({ action: 'stream_end', sessionId, streamId: sid, finalSeq, error: result.is_error ? (result.subtype || 'error') : undefined });
      if ((options.runtime || 'claude') !== 'claude') clearPendingControls(sessionId);
      // A turn awaiting a permission reply stays needs_input; otherwise the turn is done.
      if (options.syncStatus !== false) {
        syncInteractionStatus(
          sessionId,
          _pendingControl.has(sessionId) ? 'needs_input' : 'completed',
          controlDetail(_pendingControl.current(sessionId)),
          options.runtime,
        );
      }
    },
    onControlRequest: (req) => {
      const r = req.request || {};
      const input = r.input || {};
      // Surface to the app → permission_reply → handlePermissionReply (bypass mode never gets here).
      const queued = _pendingControl.enqueue(sessionId, {
        requestId: req.request_id, toolName: r.tool_name,
        input, requiresInteraction: !!r.requires_user_interaction,
        approvalType: r.approval_type || null,
        runtime: options.runtime || 'claude',
        nativeSessionId: options.nativeSessionId || sessionId,
        syncStatus: options.syncStatus !== false,
      });
      if (options.syncStatus !== false) {
        syncInteractionStatus(
          sessionId,
          'needs_input',
          controlDetail(queued.current),
          options.runtime,
        );
      }
      if (queued.shouldPresent) sendPermissionRequest(sessionId, queued.current);
    },
    onControlResolved: (requestId) => {
      dismissPendingControl(sessionId, requestId);
    },
    onError: (sid, err) => {
      console.log(`[ws] live interaction error for ${sessionId.slice(0, 8)}: code=${err.code} ${err.detail || ''}`);
      if ((options.runtime || 'claude') !== 'claude') clearPendingControls(sessionId);
      wsSend({ action: 'stream_end', sessionId, streamId: sid, error: 'unavailable' });
      ack(false, err.detail || 'Session unavailable (busy elsewhere). Read-only.');
    },
  };
}

async function handleAdapterSend(adapter, identity, text, clientId, sendOptions = {}) {
  const filePath = adapter.findSessionFile(identity.nativeSessionId);
  if (!synced.has(identity.sessionId) && filePath) {
    try { synced.set(identity.sessionId, countJsonlLines(filePath)); } catch {}
  }

  const streamId = newStreamId();
  let acked = false;
  const ack = (ok, error, meta = {}) => {
    if (acked) return;
    acked = true;
    wsSend({
      action: 'send_message_result',
      sessionId: identity.sessionId,
      ok,
      error,
      clientId,
      streamId,
      ...meta,
    });
  };
  const callbacks = buildStreamCallbacks(identity.sessionId, '', ack, {
    runtime: identity.runtime,
    nativeSessionId: identity.nativeSessionId,
    syncStatus: false,
  });
  try {
    await adapter.interaction.sendExisting({
      sessionId: identity.sessionId,
      nativeSessionId: identity.nativeSessionId,
      streamId,
      text,
      callbacks,
      takeover: sendOptions.takeover,
      expectedWriterPid: sendOptions.expectedWriterPid,
    });
    ack(true);
    return true;
  } catch (error) {
    const errorCode = {
      CODEX_ACTIVE_WRITER: 'codex_active_writer',
      CODEX_WRITER_CHANGED: 'codex_writer_changed',
      CODEX_WRITER_UNSAFE: 'codex_writer_unsafe',
    }[error.code];
    ack(
      false,
      error.message || 'Session unavailable.',
      errorCode ? { errorCode, writer: error.writer } : {},
    );
    return true;
  }
}

async function newAdapterSession(adapter, cwd, text, requestId, clientId) {
  const streamId = newStreamId();
  let acked = false;
  const ack = (ok, sessionId, error) => {
    if (acked) return;
    acked = true;
    wsSend({
      action: 'send_message_result',
      sessionId,
      ok,
      error,
      requestId,
      clientId,
      streamId,
    });
  };
  try {
    await adapter.interaction.create({
      cwd,
      text,
      streamId,
      onCreated: ({ nativeSessionId, sessionId }) => {
        const callbacks = buildStreamCallbacks(sessionId, cwd, (_ok, error) => {
          ack(false, sessionId, error);
        }, {
          runtime: adapter.runtime,
          nativeSessionId,
          syncStatus: false,
        });
        ack(true, sessionId);
        return callbacks;
      },
    });
  } catch (error) {
    ack(false, '', error.message || 'Session creation failed.');
  }
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
    const fp = _claudeRuntime.findSessionFile(sessionId);
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

// App (re)subscribed: show a known prompt, or passively attach to an active
// managed Codex thread so app-server can replay TUI-owned pending requests.
async function handleRevealAgent(sessionId) {
  const p = _pendingControl.current(sessionId);
  if (p) {
    if (p.syncStatus) {
      syncInteractionStatus(sessionId, 'needs_input', controlDetail(p), p.runtime);
    }
    sendPermissionRequest(sessionId, p);
    return;
  }
  const identity = parseStorageSessionId(sessionId);
  const adapter = getRuntimeAdapter(identity.runtime);
  if (typeof adapter.interaction?.observeExisting !== 'function') return;
  const callbacks = buildStreamCallbacks(
    identity.sessionId,
    '',
    () => {},
    {
      runtime: identity.runtime,
      nativeSessionId: identity.nativeSessionId,
      syncStatus: true,
    },
  );
  await adapter.interaction.observeExisting({
    sessionId: identity.sessionId,
    nativeSessionId: identity.nativeSessionId,
    callbacks,
  });
}

// Delete on-disk jsonl for sessions/projects (opt-in; DDB rows already removed via REST).
// Only touches paths inside CLAUDE_PROJECTS — never the user's real project/code dir.
function handleDeleteFiles(msg) {
  let skippedReadOnly = 0;
  let deletedSessions = 0;
  for (const sid of msg.sessionIds || []) {
    const identity = parseStorageSessionId(sid);
    const adapter = getRuntimeAdapter(identity.runtime);
    if (!adapter.features.deleteHistory) {
      skippedReadOnly++;
      continue;
    }
    if (adapter.deleteSessionHistory(identity.nativeSessionId, { watermarks: synced })) {
      deletedSessions++;
    }
  }
  for (const ph of msg.projectHashes || []) {
    for (const adapter of runtimeAdapters) {
      if (adapter.features.deleteHistory) adapter.deleteProjectHistory(ph);
    }
  }
  console.log(`[ws] deleted files: ${deletedSessions} sessions, ${(msg.projectHashes || []).length} projects`);
  wsSend({ action: 'delete_files_result', requestId: msg.requestId, ok: true, skippedReadOnly });
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

// App answered permission_request. Claude uses allow/deny; Codex preserves its native
// approval decision; ask/plan use deny with answerText (CC's only answer channel).
function handlePermissionReply(msg) {
  const {
    sessionId, requestId, decision, answerText, approvalResponse,
  } = msg;
  const pending = _pendingControl.current(sessionId);
  if (!pending || (requestId && pending.requestId !== requestId)) return;

  let replied = false;
  if (pending.runtime !== 'claude') {
    const adapter = getRuntimeAdapter(pending.runtime);
    replied = !!adapter.interaction?.replyControl?.(
      pending.nativeSessionId,
      pending.requestId,
      { decision, answerText, approvalResponse },
    );
  } else if (pending.hookReply) {
    if (pending.requiresInteraction && decision === 'answer' && answerText) {
      replied = pending.hookReply({ action: 'answer', answerText });
    } else if (decision === 'allow') {
      replied = pending.hookReply({ action: 'allow' });
    } else {
      replied = pending.hookReply({
        action: 'deny',
        reason: pending.requiresInteraction
          ? 'The user did not answer through AgentPeek.'
          : 'The user denied this tool call through AgentPeek.',
      });
    }
  } else if (pending.requiresInteraction) {
    // ask/plan answer → deny+message (CC renders it as the OUT); cancel → deny+interrupt (CC stops, no reply).
    if (decision === 'answer' && answerText) {
      replied = _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: answerText });
    } else {
      replied = _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: 'The user did not answer.', interrupt: true });
    }
  } else {
    // Ordinary Claude tool: allow (input unchanged) or deny.
    replied = decision === 'allow'
      ? _pool.replyControl(sessionId, pending.requestId, { behavior: 'allow', updatedInput: pending.input })
      : _pool.replyControl(sessionId, pending.requestId, { behavior: 'deny', message: 'User denied this tool call.' });
  }
  if (!replied) return;

  const advanced = _pendingControl.resolve(sessionId, pending.requestId);
  if (!advanced) return;
  if (advanced.next) {
    sendPermissionRequest(sessionId, advanced.next);
    if (advanced.next.syncStatus) {
      syncInteractionStatus(
        sessionId,
        'needs_input',
        controlDetail(advanced.next),
        advanced.next.runtime,
      );
    }
  } else {
    wsSend({ action: 'permission_resolved', sessionId, requestId: pending.requestId });
    if (pending.syncStatus) {
      syncInteractionStatus(sessionId, 'running', '', pending.runtime);
    }
  }
}
