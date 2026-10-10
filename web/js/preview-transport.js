import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { PreviewDataChannel } from '../../bridge/preview-protocol.mjs';

const CHUNK_BYTES = 16 * 1024;
const WINDOW_BYTES = 128 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function decodedLength(value) {
  return value.length / 4 * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Preview control connection timed out')), 15000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Preview control connection failed')); }, { once: true });
    socket.addEventListener('close', () => { clearTimeout(timer); reject(new Error('Preview control connection closed')); }, { once: true });
  });
}

export class PreviewTunnel {
  constructor({ device, target, wsUrl, key, onStatus, onTraffic, onDiagnostic }) {
    this.device = device;
    this.target = target;
    this.wsUrl = wsUrl;
    this.key = key;
    this.onStatus = onStatus;
    this.onTraffic = onTraffic;
    this.onDiagnostic = onDiagnostic;
    this.inboundBytes = 0;
    this.tunnelId = crypto.randomUUID();
    this.streams = new Map();
    this.unlisteners = [];
    this.closed = false;
    this.started = false;
  }

  status(message) {
    this.onStatus?.(message);
  }

  sendControl(op, fields = {}) {
    if (this.control?.readyState === WebSocket.OPEN) {
      this.control.send(JSON.stringify({
        action: 'preview_tunnel', v: 1, op, tunnelId: this.tunnelId,
        ...(op === 'open' ? { device: this.device, port: this.target.port } : {}),
        ...fields,
      }));
    }
  }

  async start() {
    if (this.started) throw new Error('Preview already started');
    this.started = true;
    const endpoint = new URL(this.wsUrl);
    if (endpoint.protocol !== 'wss:') throw new Error('Preview requires a secure WS endpoint');
    endpoint.search = new URLSearchParams({ apiKey: this.key, role: 'app' });
    this.control = new WebSocket(endpoint);
    this.control.addEventListener('message', event => this.handleControl(event.data));
    this.control.addEventListener('close', () => {
      if (!this.closed) this.fail('Preview control connection closed');
    });
    try {
      await waitForOpen(this.control);
      if (this.closed) throw new Error('Preview closed');
      const ready = new Promise((resolve, reject) => {
        this.resolveReady = resolve;
        this.rejectReady = reject;
        this.pairTimer = setTimeout(() => reject(new Error('Preview pairing timed out')), 30000);
      });
      this.sendControl('open');
      await ready;
      if (this.closed) throw new Error('Preview closed');
      for (const [name, handler] of [
        ['preview-socket-open', event => this.nativeOpen(event.payload)],
        ['preview-socket-bytes', event => this.nativeBytes(event.payload)],
        ['preview-socket-fin', event => this.nativeFin(event.payload)],
        ['preview-socket-close', event => this.nativeClose(event.payload)],
      ]) {
        const unlisten = await listen(name, handler);
        if (this.closed) {
          unlisten();
          throw new Error('Preview closed');
        }
        this.unlisteners.push(unlisten);
      }
      this.localOrigin = await invoke('preview_start', {
        tunnelId: this.tunnelId, preferredPort: this.target.port,
      });
      if (this.closed) {
        await invoke('preview_stop', { tunnelId: this.tunnelId }).catch(() => {});
        throw new Error('Preview closed');
      }
      const url = `${this.localOrigin}${this.target.pathname}${this.target.search}${this.target.hash}`;
      this.status(`Opening ${this.target.displayUrl} on ${this.device}`);
      return url;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  handleControl(value) {
    let message;
    try { message = JSON.parse(value); } catch { return; }
    if (message.action !== 'preview_tunnel' || message.tunnelId !== this.tunnelId || this.closed) return;
    if (message.type === 'offer') {
      if (message.side !== 'app' || this.channel) return this.fail('Invalid preview offer');
      try {
        this.channel = new PreviewDataChannel({ key: this.key, offer: message });
        this.channel.addEventListener('open', () => {
          clearTimeout(this.pairTimer);
          this.resolveReady?.();
        });
        this.channel.addEventListener('message', event => this.remoteMessage(event.data));
        this.channel.addEventListener('error', event => this.fail(event.data || 'Preview data connection failed'));
        this.channel.addEventListener('close', () => {
          if (!this.closed) this.fail('Preview data connection closed');
        });
      } catch {
        this.fail('Could not open preview data channel');
      }
    } else if (message.type === 'ready') {
      this.channel?.authorize(message);
      clearTimeout(this.renewTimer);
      const delay = message.credentials?.expiresAt * 1000 - Date.now() - 120000;
      if (Number.isFinite(delay)) this.renewTimer = setTimeout(() => this.sendControl('renew'),
        Math.max(60000, Math.min(300000, delay)));
    } else if (message.type === 'error' || message.type === 'closed') {
      this.fail(message.message || message.reason || 'Preview connection closed');
    }
  }

  nativeOpen(payload) {
    if (this.closed || payload.tunnelId !== this.tunnelId || !UUID.test(payload.streamId)) return;
    this.onDiagnostic?.('native-open');
    this.status(`Connecting to port ${this.target.port} on ${this.device}`);
    const stream = {
      id: payload.streamId, opened: false, localFin: false, remoteFin: false,
      nextOutgoing: 1, nextIncoming: 1, lastWritten: 0,
      pendingOutgoing: new Map(), pendingIncoming: new Map(), pendingBytes: 0,
      outstanding: new Map(), lastAcked: 0, localFinSeq: null, remoteFinSeq: null,
      flushing: false,
    };
    this.streams.set(stream.id, stream);
    if (!this.channel?.send({ type: 'open', streamId: stream.id })) this.fail('Preview stream could not open');
  }

  nativeBytes(payload) {
    const stream = this.streams.get(payload.streamId);
    if (stream && payload.seq === 1) this.onDiagnostic?.('browser-request-bytes');
    if (!stream || payload.tunnelId !== this.tunnelId || !stream.opened
      || !Number.isSafeInteger(payload.seq) || payload.seq < stream.nextOutgoing
      || payload.seq > stream.nextOutgoing + 32) return;
    if (stream.pendingOutgoing.has(payload.seq)) return;
    stream.pendingOutgoing.set(payload.seq, payload.data);
    this.flushOutgoing(stream);
  }

  nativeFin(payload) {
    const stream = this.streams.get(payload.streamId);
    if (!stream || payload.tunnelId !== this.tunnelId) return;
    stream.localFinSeq = payload.seq;
    this.flushOutgoing(stream);
  }

  nativeClose(payload) {
    if (payload.tunnelId !== this.tunnelId) return;
    this.onDiagnostic?.('native-close');
    this.closeStream(payload.streamId, true);
  }

  flushOutgoing(stream) {
    while (stream.opened && stream.pendingOutgoing.has(stream.nextOutgoing)) {
      const seq = stream.nextOutgoing++;
      const data = stream.pendingOutgoing.get(seq);
      stream.pendingOutgoing.delete(seq);
      const bytes = decodedLength(data);
      if (bytes <= 0 || bytes > CHUNK_BYTES
        || !this.channel.send({ type: 'bytes', streamId: stream.id, seq, data })) {
        this.closeStream(stream.id, true);
        return;
      }
      stream.outstanding.set(seq, bytes);
    }
    if (!stream.localFin && stream.localFinSeq !== null
      && stream.nextOutgoing > stream.localFinSeq) {
      stream.localFin = true;
      this.channel.send({ type: 'fin', streamId: stream.id, seq: stream.localFinSeq });
      this.maybeCloseStream(stream);
    }
  }

  remoteMessage(message) {
    const stream = this.streams.get(message.streamId);
    if (!stream || this.closed) return;
    if (message.type === 'opened') {
      stream.opened = true;
      this.onDiagnostic?.('remote-opened');
      this.status(`Connected to port ${this.target.port} on ${this.device}`);
      void invoke('preview_credit', { streamId: stream.id, bytes: WINDOW_BYTES })
        .then(() => this.onDiagnostic?.('credit-ok'))
        .catch(error => {
          this.onDiagnostic?.(`credit-failed: ${error.message || error}`);
          this.closeStream(stream.id, true);
        });
      this.status(`Loading ${this.target.displayUrl}`);
    } else if (message.type === 'ack') {
      if (message.seq < stream.lastAcked || message.seq >= stream.nextOutgoing) {
        this.closeStream(stream.id, true);
        return;
      }
      let credited = 0;
      for (const [seq, bytes] of stream.outstanding) {
        if (seq > message.seq) break;
        stream.outstanding.delete(seq);
        credited += bytes;
      }
      stream.lastAcked = message.seq;
      if (credited) void invoke('preview_credit', { streamId: stream.id, bytes: credited })
        .catch(() => this.closeStream(stream.id, true));
    } else if (message.type === 'bytes') {
      if (message.seq === 1) this.onDiagnostic?.('remote-response-bytes');
      if (message.seq < stream.nextIncoming) {
        this.channel.send({ type: 'ack', streamId: stream.id, seq: stream.lastWritten });
        return;
      }
      if (message.seq > stream.nextIncoming + 32
        || stream.pendingBytes + decodedLength(message.data) > MAX_PENDING_BYTES) {
        this.closeStream(stream.id, true);
        return;
      }
      if (!stream.pendingIncoming.has(message.seq)) {
        stream.pendingIncoming.set(message.seq, message.data);
        stream.pendingBytes += decodedLength(message.data);
      }
      void this.flushIncoming(stream);
    } else if (message.type === 'fin') {
      if (message.seq < stream.nextIncoming - 1 || message.seq > stream.nextIncoming + 32) {
        this.closeStream(stream.id, true);
        return;
      }
      stream.remoteFinSeq = message.seq;
      void this.flushIncoming(stream);
    } else if (message.type === 'error') {
      this.onDiagnostic?.(`remote-error: ${message.code}`);
      this.status(message.code === 'connection_refused'
        ? `Port ${this.target.port} is not listening on ${this.device}`
        : 'Remote preview service failed');
      this.closeStream(stream.id, false);
    } else if (message.type === 'close') {
      this.closeStream(stream.id, false);
    }
  }

  async flushIncoming(stream) {
    if (stream.flushing || !this.streams.has(stream.id)) return;
    stream.flushing = true;
    try {
      while (stream.pendingIncoming.has(stream.nextIncoming)) {
        const seq = stream.nextIncoming++;
        const data = stream.pendingIncoming.get(seq);
        stream.pendingIncoming.delete(seq);
        stream.pendingBytes -= decodedLength(data);
        await invoke('preview_write', { streamId: stream.id, data });
        if (!this.streams.has(stream.id)) return;
        this.inboundBytes += decodedLength(data);
        this.onTraffic?.(this.inboundBytes);
        stream.lastWritten = seq;
        if (!this.channel.send({ type: 'ack', streamId: stream.id, seq })) {
          this.closeStream(stream.id, true);
          return;
        }
      }
      if (!stream.remoteFin && stream.remoteFinSeq !== null
        && stream.nextIncoming > stream.remoteFinSeq) {
        await invoke('preview_shutdown_write', { streamId: stream.id });
        stream.remoteFin = true;
        this.maybeCloseStream(stream);
      }
    } catch (error) {
      this.onDiagnostic?.(`remote-write-failed: ${error.message || error}`);
      this.closeStream(stream.id, true);
    } finally {
      stream.flushing = false;
      if (this.streams.has(stream.id) && stream.pendingIncoming.has(stream.nextIncoming)) {
        void this.flushIncoming(stream);
      }
    }
  }

  maybeCloseStream(stream) {
    if (stream.localFin && stream.remoteFin) this.closeStream(stream.id, false);
  }

  closeStream(streamId, notify) {
    if (!this.streams.has(streamId)) return;
    this.streams.delete(streamId);
    if (notify && this.channel?.readyState === 1) this.channel.send({ type: 'close', streamId });
    void invoke('preview_close_socket', { streamId }).catch(() => {});
  }

  fail(reason) {
    if (this.closed) return;
    this.status(reason);
    this.rejectReady?.(new Error(reason));
    void this.close();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.pairTimer);
    clearTimeout(this.renewTimer);
    this.sendControl('close');
    this.channel?.close();
    this.control?.close();
    this.streams.clear();
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    if (this.localOrigin) await invoke('preview_stop', { tunnelId: this.tunnelId }).catch(() => {});
  }
}
