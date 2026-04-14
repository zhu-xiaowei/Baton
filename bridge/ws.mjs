import WebSocket from 'ws';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readAllMessages, uploadMessages } from './extract.mjs';
import { findSessionFile } from './session.mjs';
import { sendMessageToSession, sendArrowSelect, sendTypeInput, sendKey, sendKeys, launchClaudeSession, newTmuxSession, projectHashToPath } from './tmux.mjs';
import { CLAUDE_PROJECTS } from './config.mjs';

let _ws = null;
let _config = null;
let _reconnectTimer = null;
let _heartbeatTimer = null;
const HEARTBEAT_INTERVAL = 4 * 60_000;
const RECONNECT_DELAY = 5_000;

// Launch locks: prevent concurrent tmux creation for same project/session
// Key: projectHash or sessionId, Value: Promise<{ok, sessionId?, tmuxName?}>
const _launchLocks = new Map();

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
  if (_ws) {
    _ws.removeAllListeners();
    _ws.terminate();
    _ws = null;
  }

  const url = `${wsUrl}?apiKey=${_config.apiKey}&role=bridge&device=${encodeURIComponent(_config.deviceName)}`;
  console.log(`[ws] connecting to ${wsUrl}...`);

  _ws = new WebSocket(url);

  _ws.on('open', () => {
    console.log('[ws] connected');
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

  _ws.on('close', () => {
    console.log('[ws] disconnected, reconnecting...');
    scheduleReconnect();
  });

  _ws.on('error', (err) => {
    console.error(`[ws] error: ${err.message} (code: ${err.code}, type: ${err.type})`);
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
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

async function handleMessage(msg) {
  switch (msg.action) {
    case 'sync_session':
      await handleSyncSession(msg.sessionId);
      break;
    case 'send_message':
      await handleSendMessage(msg.sessionId, msg.text, msg.projectHash, msg.requestId);
      break;
    case 'permission_reply':
      handlePermissionReply(msg.sessionId, msg.approved);
      break;
    case 'interrupt':
      sendKey(msg.sessionId, 'Escape');
      sendKey(msg.sessionId, 'C-u');
      break;
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

  const msgs = await readAllMessages(filePath, sessionId);
  if (msgs.length > 0) {
    await uploadMessages(sessionId, msgs);
    console.log(`[ws] synced ${msgs.length} messages for ${sessionId.slice(0, 8)}`);
  }
  wsSend({ action: 'sync_complete', sessionId, status: 'ok', count: msgs.length });
}

async function handleSendMessage(sessionId, text, projectHash, requestId) {
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

  // New session: create tmux + claude, send message, detect sessionId
  if (!sessionId && projectHash) {
    const lockKey = requestId || projectHash;

    // If already launching for this requestId, wait then send to existing session
    if (_launchLocks.has(lockKey)) {
      console.log(`[ws] waiting for in-flight launch (${lockKey.slice(0, 8)})...`);
      const prev = await _launchLocks.get(lockKey);
      if (prev.ok && prev.tmuxName) {
        try { sendKeys(prev.tmuxName, resolved); } catch {}
        wsSend({ action: 'send_message_result', ok: true, sessionId: prev.sessionId });
      } else {
        wsSend({ action: 'send_message_result', ok: false, error: 'previous launch failed' });
      }
      return;
    }

    const promise = handleNewSessionMessage(projectHash, resolved);
    _launchLocks.set(lockKey, promise);
    const result = await promise;
    setTimeout(() => _launchLocks.delete(lockKey), 30_000);
    wsSend({ action: 'send_message_result', ...result });
    return;
  }

  let result = sendMessageToSession(sessionId, resolved);

  // No running CC in tmux → auto-launch, then send-keys directly to the new tmux session
  if (!result.ok && result.error === 'no_tmux_target') {
    // If already launching for this session, wait then send
    if (_launchLocks.has(sessionId)) {
      console.log(`[ws] waiting for in-flight launch (session ${sessionId.slice(0, 8)})...`);
      const prev = await _launchLocks.get(sessionId);
      if (prev.ok && prev.tmuxName) {
        try { sendKeys(prev.tmuxName, resolved); result = { ok: true }; } catch (err) { result = { ok: false, error: err.message }; }
      } else {
        result = { ok: false, error: 'previous launch failed' };
      }
    } else {
      console.log(`[ws] no tmux target for ${sessionId.slice(0, 8)}, launching CC...`);
      const promise = (async () => {
        const tmuxName = launchForSession(sessionId);
        if (!tmuxName) return { ok: false, error: 'failed to launch claude' };
        const ready = await waitForCCReady(tmuxName);
        if (!ready) return { ok: false, error: 'claude did not become ready' };
        return { ok: true, tmuxName };
      })();
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
  wsSend({ action: 'send_message_result', sessionId, ...result });
}

async function handleNewSessionMessage(projectHash, text) {
  try {
    const projectPath = projectHashToPath(projectHash);
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
    if (!ready) return { ok: false, error: 'claude did not become ready' };

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

/**
 * Wait for Claude Code to be ready in a tmux pane.
 * Checks pane content for the '>' prompt. Polls every 500ms, up to 15s.
 */
async function waitForCCReady(tmuxTarget) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const content = execSync(
        `tmux capture-pane -t "${tmuxTarget}" -p`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      );
      // Trust dialog: auto-accept "Yes, I trust this folder"
      if (/Yes, I trust this folder/m.test(content)) {
        execSync(`tmux send-keys -t "${tmuxTarget}" Enter`, { stdio: 'ignore' });
        console.log(`[ws] auto-accepted trust dialog for ${tmuxTarget}`);
        continue;
      }
      // CC shows '>' or '❯' prompt when ready for input
      if (/^[>❯]\s*$/m.test(content)) return true;
    } catch {}
  }
  console.log(`[ws] CC did not become ready within 15s`);
  return false;
}

/**
 * Launch CC in tmux for an existing session.
 * Returns tmux session name, or null on failure.
 */
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
    return null;
  }
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
