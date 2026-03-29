import WebSocket from 'ws';
import { readAllMessages, uploadMessages } from './extract.mjs';
import { findSessionFile } from './session.mjs';

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

  _ws.on('unexpected-response', (req, res) => {
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
