import WebSocket from 'ws';
import { readAllMessages, uploadMessages } from './extract.mjs';
import { findSessionFile } from './session.mjs';
import { sendMessageToSession, sendArrowSelect, sendTypeInput, sendKey } from './tmux.mjs';


let _ws = null;
let _config = null;
let _reconnectTimer = null;
const HEARTBEAT_INTERVAL = 5 * 60_000;
const RECONNECT_DELAY = 5_000;

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

  const url = `${wsUrl}?apiKey=${_config.apiKey}&role=bridge`;
  console.log(`[ws] connecting to ${wsUrl}...`);

  _ws = new WebSocket(url);

  _ws.on('open', () => {
    console.log('[ws] connected');
    // Start heartbeat
    const hb = setInterval(() => {
      if (_ws?.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ action: 'heartbeat' }));
      } else {
        clearInterval(hb);
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
    res.on('end', () => console.error(`[ws] response body: ${body.slice(0, 200)}`));
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
      handleSendMessage(msg.sessionId, msg.text);
      break;
    case 'permission_reply':
      handlePermissionReply(msg.sessionId, msg.approved);
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

function handleSendMessage(sessionId, text) {
  if (!sessionId || !text) return;
  const result = sendMessageToSession(sessionId, text);
  if (!result.ok) {
    console.log(`[ws] send_message failed: ${result.error}`);
  }
  wsSend({ action: 'send_message_result', sessionId, ...result });
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
