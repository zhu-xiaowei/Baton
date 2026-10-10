import { authenticateFrame, createHeaderSigner, verifyFrame } from './terminal-direct-protocol.mjs';

const MAX_FRAME = 28 * 1024;
const KEEPALIVE_MS = 5 * 60 * 1000;
const KEEPALIVE = JSON.stringify({ action: 'ping' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTION = /^[A-Za-z0-9_+=.-]{1,256}$/;
const APP_TYPES = new Set(['open', 'bytes', 'ack', 'fin', 'close']);
const BRIDGE_TYPES = new Set(['opened', 'bytes', 'ack', 'fin', 'close', 'error']);
const encoder = new TextEncoder();

function emit(target, type, fields = {}) {
  target.dispatchEvent(Object.assign(new Event(type), fields));
}

function validDataChunk(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = value.length / 4 * 3 - padding;
  return bytes > 0 && bytes <= 16 * 1024;
}

export function validatePreviewMessage(message, side) {
  const allowed = side === 'app' ? APP_TYPES : BRIDGE_TYPES;
  if (!message || typeof message !== 'object' || !allowed.has(message.type)
    || !UUID.test(message.streamId || '')) throw new Error('Invalid preview message');
  if (['bytes', 'ack', 'fin'].includes(message.type)
    && (!Number.isSafeInteger(message.seq) || message.seq < 0)) throw new Error('Invalid preview sequence');
  if (message.type === 'bytes' && (message.seq < 1 || !validDataChunk(message.data))) {
    throw new Error('Invalid preview data');
  }
  if (message.type === 'error' && (typeof message.code !== 'string' || message.code.length > 64)) {
    throw new Error('Invalid preview error');
  }
  return message;
}

export class PreviewDataChannel extends EventTarget {
  constructor({ key, offer, socketFactory = url => new WebSocket(url) }) {
    super();
    if (!UUID.test(offer?.tunnelId || '') || !['app', 'bridge'].includes(offer?.side)
      || typeof offer?.device !== 'string' || !Number.isInteger(offer?.port)
      || offer.port < 1 || offer.port > 65535) throw new Error('Invalid preview offer');
    this.offer = offer;
    this.readyState = 0;
    this.pendingBytes = 0;
    this.incomingBytes = 0;
    this.incoming = [];
    this.receiveBytes = 0;
    this.sendQueue = Promise.resolve();
    this.receiveQueue = Promise.resolve();
    this.endpoint = new URL(offer.dataEndpoint);
    if (this.endpoint.protocol !== 'https:' || this.endpoint.search || this.endpoint.hash
      || this.endpoint.username || this.endpoint.password) throw new Error('Invalid preview data endpoint');
    const url = new URL(this.endpoint);
    url.protocol = 'wss:';
    url.search = new URLSearchParams({ apiKey: key, role: 'preview_data', version: 'preview-1' });
    this.socket = socketFactory(url);
    this.timeout = setTimeout(() => this.fail('Preview authorization timed out'), 30000);
    this.socket.addEventListener('open', () => {
      if (this.readyState !== 0) return;
      this.socket.send(JSON.stringify({ action: 'preview_tunnel', v: 1, op: 'join',
        tunnelId: offer.tunnelId, side: offer.side, joinToken: offer.joinToken }));
    });
    this.socket.addEventListener('message', event => this.receive(event.data));
    this.socket.addEventListener('error', () => this.fail('Preview data connection failed'));
    this.socket.addEventListener('close', () => this.finish('Preview data connection closed'));
  }

  get bufferedAmount() {
    return this.pendingBytes + (this.socket?.bufferedAmount || 0);
  }

  authorize(message) {
    if (this.readyState > 1) return;
    if (message.tunnelId !== this.offer.tunnelId || message.device !== this.offer.device
      || message.port !== this.offer.port || message.side !== this.offer.side
      || message.endpoint !== this.endpoint.href.replace(/\/$/, '')
      || !CONNECTION.test(message.connectionId || '')
      || !CONNECTION.test(message.peerConnectionId || '')
      || message.connectionId === message.peerConnectionId || this.socket.readyState !== 1
      || !/^[0-9a-f]{64}$/.test(message.frameKey || '')) {
      this.fail('Preview authorization mismatch');
      return;
    }
    try {
      if (this.binding && (this.binding.connectionId !== message.connectionId
        || this.binding.peerConnectionId !== message.peerConnectionId)) {
        throw new Error('Preview binding changed');
      }
      if (this.frameKey && this.frameKey !== message.frameKey) throw new Error('Frame key changed');
      this.frameKey = message.frameKey;
      this.binding = { connectionId: message.connectionId, peerConnectionId: message.peerConnectionId };
      this.signer = createHeaderSigner({
        endpoint: message.endpoint, region: message.region, target: message.peerConnectionId,
        credentials: message.credentials, action: 'preview_data',
      });
      const remaining = message.credentials.expiresAt * 1000 - Date.now() - 3000;
      if (remaining <= 0) throw new Error('Credentials expired');
      clearTimeout(this.expiry);
      this.expiry = setTimeout(() => this.fail('Preview authorization expired'), remaining);
      clearTimeout(this.timeout);
      const opening = this.readyState === 0;
      this.readyState = 1;
      if (opening) {
        // API Gateway closes a socket after 10 idle minutes; frames posted to it do not count.
        this.keepalive = setInterval(() => {
          if (this.socket.readyState === 1) this.socket.send(KEEPALIVE);
        }, KEEPALIVE_MS);
        emit(this, 'open');
      }
      const pending = this.incoming;
      this.incoming = [];
      this.incomingBytes = 0;
      for (const payload of pending) this.receive(payload);
    } catch {
      this.fail('Invalid preview signing authorization');
    }
  }

  send(message) {
    if (this.readyState !== 1) return false;
    try {
      validatePreviewMessage(message, this.offer.side);
      const payload = JSON.stringify({ action: 'preview_frame', v: 1,
        tunnelId: this.offer.tunnelId, device: this.offer.device, message });
      const bytes = encoder.encode(payload).length + 4096;
      if (this.bufferedAmount + bytes > 1024 * 1024) throw new Error('Preview send backlog');
      this.pendingBytes += bytes;
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          if (this.readyState !== 1) return;
          const body = JSON.stringify(await authenticateFrame(payload, this.frameKey));
          const frame = await this.signer(body);
          if (this.readyState === 1 && this.socket.readyState === 1) this.socket.send(frame);
        } finally {
          this.pendingBytes -= bytes;
        }
      }).catch(() => this.fail('Preview data send failed'));
      return true;
    } catch {
      this.fail('Invalid or oversized preview frame');
      return false;
    }
  }

  receive(value) {
    if (this.readyState > 1) return;
    const payload = typeof value === 'string' ? value : new TextDecoder().decode(value);
    const bytes = encoder.encode(payload).length;
    if (bytes > MAX_FRAME) return this.fail('Preview frame too large');
    if (this.readyState === 0) {
      if (this.incomingBytes + bytes > 256 * 1024) return this.fail('Preview receive backlog');
      this.incomingBytes += bytes;
      this.incoming.push(payload);
      return;
    }
    if (this.receiveBytes + bytes > 1024 * 1024) return this.fail('Preview receive backlog');
    this.receiveBytes += bytes;
    this.receiveQueue = this.receiveQueue.then(async () => {
      try {
        if (this.readyState !== 1) return;
        const envelope = JSON.parse(payload);
        if (!await verifyFrame(envelope, this.frameKey)) throw new Error('Invalid preview MAC');
        const frame = JSON.parse(envelope.payload);
        if (frame.action !== 'preview_frame' || frame.v !== 1
          || frame.tunnelId !== this.offer.tunnelId || frame.device !== this.offer.device) {
          throw new Error('Preview tunnel mismatch');
        }
        validatePreviewMessage(frame.message, this.offer.side === 'app' ? 'bridge' : 'app');
        if (this.readyState === 1) emit(this, 'message', { data: frame.message });
      } catch {
        this.fail('Invalid preview frame');
      } finally {
        this.receiveBytes -= bytes;
      }
    });
  }

  fail(reason) {
    if (this.readyState > 1) return;
    emit(this, 'error', { data: reason });
    this.close();
  }

  finish(reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.signer = null;
    this.frameKey = null;
    this.binding = null;
    this.incoming = [];
    this.incomingBytes = 0;
    clearTimeout(this.timeout);
    clearTimeout(this.expiry);
    clearInterval(this.keepalive);
    emit(this, 'close', { reason });
  }

  close() {
    if (this.readyState > 1) return;
    this.readyState = 2;
    this.socket.close(1000, 'Preview session closed');
    this.finish();
  }
}
