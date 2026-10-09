import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createPreviewBridge } from '../../bridge/preview-bridge.mjs';
import { PreviewDataChannel } from '../../bridge/preview-protocol.mjs';

const requireBridge = createRequire(new URL('../../bridge/package.json', import.meta.url));
const WebSocket = requireBridge('ws');
const device = 'test-ec2-preview';
const port = Number(process.env.BATON_PREVIEW_TEST_PORT || 5173);
const timeoutMs = 30000;

function urlWith(endpoint, fields) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams(fields);
  return url;
}

function socketFactory(url) {
  return new WebSocket(url, { maxPayload: 28 * 1024, perMessageDeflate: false });
}

async function directRequest(request) {
  const socket = net.connect({ host: '127.0.0.1', port });
  await once(socket, 'connect');
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  socket.end(request);
  await once(socket, 'close');
  return Buffer.concat(chunks);
}

function bodyOf(response) {
  const end = response.indexOf('\r\n\r\n');
  assert.ok(end >= 0, 'HTTP response headers missing');
  return response.subarray(end + 4);
}

function requestThroughChannel(channel, request, { upgrade = false } = {}) {
  const streamId = randomUUID();
  let nextSeq = 1;
  let lastSeq = null;
  const pending = new Map();
  const chunks = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Preview stream timed out')), timeoutMs);
    function finish(error, bytes) {
      clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      channel.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve(bytes);
    }
    function onError(event) { finish(new Error(event.data || 'Preview channel failed')); }
    function onMessage(event) {
      const message = event.data;
      if (message.streamId !== streamId) return;
      if (message.type === 'opened') {
        channel.send({ type: 'bytes', streamId, seq: 1, data: request.toString('base64') });
      } else if (message.type === 'bytes') {
        pending.set(message.seq, Buffer.from(message.data, 'base64'));
        while (pending.has(nextSeq)) {
          chunks.push(pending.get(nextSeq));
          pending.delete(nextSeq);
          channel.send({ type: 'ack', streamId, seq: nextSeq++ });
        }
        const bytes = Buffer.concat(chunks);
        if (upgrade && bytes.includes('101 Switching Protocols')) {
          channel.send({ type: 'close', streamId });
          finish(null, bytes);
        } else if (lastSeq !== null && nextSeq > lastSeq) {
          finish(null, bytes);
        }
      } else if (message.type === 'fin') {
        lastSeq = message.seq;
        if (nextSeq > lastSeq) finish(null, Buffer.concat(chunks));
      } else if (message.type === 'error' || message.type === 'close') {
        finish(new Error(`Preview stream ${message.type}: ${message.code || ''}`));
      }
    }
    channel.addEventListener('message', onMessage);
    channel.addEventListener('error', onError);
    if (!channel.send({ type: 'open', streamId })) finish(new Error('Failed to open preview stream'));
  });
}

async function main() {
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
  const config = JSON.parse(await readFile(path.join(os.homedir(), '.baton-bridge', 'config.json'), 'utf8'));
  assert.ok(config.apiKey && config.wsUrl, 'Installed Bridge config needs an API key and WS URL');
  const bridgeControl = socketFactory(urlWith(config.wsUrl, {
    apiKey: config.apiKey, role: 'bridge', device, preview: '1',
  }));
  const bridge = createPreviewBridge({
    endpoint: config.wsUrl, key: config.apiKey, device,
    sendControl: message => bridgeControl.send(JSON.stringify(message)),
    socketFactory,
  });
  let appControl;
  let channel;
  try {
    bridgeControl.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.action === 'preview_tunnel') bridge.handle(message);
    });
    await once(bridgeControl, 'open');
    appControl = socketFactory(urlWith(config.wsUrl, {
      apiKey: config.apiKey, role: 'app',
    }));
    await once(appControl, 'open');
    const tunnelId = randomUUID();
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview pairing timed out')), timeoutMs);
      appControl.on('message', bytes => {
        const message = JSON.parse(bytes.toString());
        if (message.action !== 'preview_tunnel' || message.tunnelId !== tunnelId) return;
        if (message.type === 'offer') {
          channel = new PreviewDataChannel({ key: config.apiKey, offer: message, socketFactory });
          channel.addEventListener('open', () => { clearTimeout(timer); resolve(channel); }, { once: true });
          channel.addEventListener('error', event => { clearTimeout(timer); reject(new Error(event.data)); }, { once: true });
        } else if (message.type === 'ready') {
          channel?.authorize(message);
        } else if (message.type === 'error' || message.type === 'closed') {
          clearTimeout(timer);
          reject(new Error(message.message || message.reason || 'Preview pairing failed'));
        }
      });
    });
    appControl.send(JSON.stringify({ action: 'preview_tunnel', v: 1, op: 'open',
      tunnelId, device, port }));
    await ready;
    const request = Buffer.from(`GET /js/ws.js HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
    const direct = await directRequest(request);
    const tunneled = await requestThroughChannel(channel, request);
    assert.ok(tunneled.toString('latin1').startsWith('HTTP/1.1 200'));
    assert.ok(bodyOf(tunneled).length > 32 * 1024);
    assert.deepEqual(bodyOf(tunneled), bodyOf(direct));
    console.log('HTTP bytes', bodyOf(tunneled).length, 'SHA256', createHash('sha256').update(bodyOf(tunneled)).digest('hex').slice(0, 16));
    const wsKey = randomBytes(16).toString('base64');
    const upgrade = Buffer.from(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Protocol: vite-hmr\r\nOrigin: http://localhost:${port}\r\n\r\n`);
    const upgraded = await requestThroughChannel(channel, upgrade, { upgrade: true });
    assert.ok(upgraded.toString('latin1').startsWith('HTTP/1.1 101'));
    console.log('WebSocket upgrade 101');
    appControl.send(JSON.stringify({ action: 'preview_tunnel', v: 1, op: 'close', tunnelId }));
    console.log('PREVIEW_BACKEND_LIVE_PASS');
  } finally {
    channel?.close();
    bridge.dispose();
    appControl?.close();
    bridgeControl.close();
  }
}

main().catch(error => {
  console.error('PREVIEW_BACKEND_LIVE_FAIL', String(error.message || error).replace(/apiKey=[^&\s]+/g, 'apiKey=<redacted>'));
  process.exitCode = 1;
});
