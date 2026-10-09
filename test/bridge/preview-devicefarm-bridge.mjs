import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createPreviewBridge } from '../../bridge/preview-bridge.mjs';

const requireBridge = createRequire(new URL('../../bridge/package.json', import.meta.url));
const WebSocket = requireBridge('ws');
const configPath = process.env.BATON_PREVIEW_TEST_CONFIG;
if (!configPath) throw new Error('Set BATON_PREVIEW_TEST_CONFIG to an isolated test config file');
const config = JSON.parse(await readFile(configPath, 'utf8'));
if (!config.apiKey || !config.wsUrl?.startsWith('wss://') || !config.device) {
  throw new Error('Test config needs apiKey, wsUrl and device');
}

let control;
let manager;
let heartbeat;
let retry;
let stopping = false;

function socketFactory(url) {
  return new WebSocket(url, { maxPayload: 28 * 1024, perMessageDeflate: false });
}

function connect() {
  if (stopping) return;
  const url = new URL(config.wsUrl);
  url.search = new URLSearchParams({
    apiKey: config.apiKey, role: 'bridge', device: config.device, preview: '1',
  });
  control = socketFactory(url);
  manager = createPreviewBridge({
    endpoint: config.wsUrl, key: config.apiKey, device: config.device,
    sendControl: message => {
      if (control?.readyState === WebSocket.OPEN) control.send(JSON.stringify(message));
    },
    socketFactory,
  });
  control.on('open', () => {
    console.log('Isolated preview Bridge connected');
    heartbeat = setInterval(() => {
      if (control?.readyState === WebSocket.OPEN) control.send(JSON.stringify({ action: 'heartbeat' }));
    }, 60000);
  });
  control.on('message', bytes => {
    try {
      const message = JSON.parse(bytes.toString());
      if (message.action === 'preview_tunnel') manager.handle(message);
    } catch {
      console.error('Invalid preview control message');
    }
  });
  control.on('error', () => {});
  control.on('close', () => {
    clearInterval(heartbeat);
    manager.dispose();
    if (!stopping) retry = setTimeout(connect, 5000);
  });
}

function stop() {
  stopping = true;
  clearInterval(heartbeat);
  clearTimeout(retry);
  manager?.dispose();
  control?.close();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
connect();
