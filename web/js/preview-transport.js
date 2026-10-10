import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { PreviewDataChannel } from '../../bridge/preview-protocol.mjs';

const CHUNK_BYTES = 16 * 1024;
const WINDOW_BYTES = 128 * 1024;
const MAX_PENDING_BYTES = 512 * 1024;
const CHANNEL_HIGH_BYTES = 256 * 1024;
const RETRANSMIT_MS = 1500;
const RETRANSMIT_CHECK_MS = 500;
const RECONNECT_DELAYS_MS = [0, 1000, 2000, 4000, 8000];
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
  constructor({ device, target, wsUrl, key, onStatus, onTraffic }) {
    this.device = device;
    this.target = target;
    this.wsUrl = wsUrl;
    this.key = key;
    this.onStatus = onStatus;
    this.onTraffic = onTraffic;
    this.inboundBytes = 0;
    // localId keys the native listener for the whole preview; tunnelId changes on each pairing.
    this.localId = crypto.randomUUID();
    this.tunnelId = null;
    this.streams = new Map();
    this.portChecks = new Map();
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

  async pair() {
    const endpoint = new URL(this.wsUrl);
    if (endpoint.protocol !== 'wss:') throw new Error('Preview requires a secure WS endpoint');
    endpoint.search = new URLSearchParams({ apiKey: this.key, role: 'app' });
    this.tunnelId = crypto.randomUUID();
    const control = this.control = new WebSocket(endpoint);
    control.addEventListener('message', event => {
      if (this.control === control) this.handleControl(event.data);
    });
    control.addEventListener('close', () => {
      if (this.control === control) this.lost('Preview control connection closed');
    });
    const ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    ready.catch(() => {});
    this.pairTimer = setTimeout(() => this.rejectReady?.(new Error('Preview pairing timed out')), 30000);
    try {
      await waitForOpen(control);
      if (this.closed) throw new Error('Preview closed');
      this.sendControl('open');
      await ready;
      if (this.closed) throw new Error('Preview closed');
    } finally {
      clearTimeout(this.pairTimer);
      this.resolveReady = null;
      this.rejectReady = null;
    }
  }

  // Bridge reconnects (API Gateway closes every WebSocket within 2 hours) end the remote side
  // of a tunnel. Keep the local listener and pair again so the open page keeps its origin.
  lost(reason) {
    if (this.closed) return;
    if (this.rejectReady) return this.rejectReady(new Error(reason));
    if (!this.localOrigin) return this.fail(reason);
    if (!this.reconnecting) this.reconnecting = this.reconnect(reason);
  }

  async reconnect(reason) {
    this.status(reason);
    for (let attempt = 0; !this.closed; attempt++) {
      this.detachRemote();
      if (attempt >= RECONNECT_DELAYS_MS.length) {
        this.reconnecting = null;
        this.fail(reason);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAYS_MS[attempt]));
      if (this.closed) return;
      try {
        await this.pair();
        this.reconnecting = null;
        this.status(`Connected to port ${this.target.port} on ${this.device}`);
        return;
      } catch (error) {
        reason = error.message || String(error);
      }
    }
  }

  detachRemote() {
    clearTimeout(this.renewTimer);
    const { channel } = this;
    this.sendControl('close');
    this.control?.close();
    this.control = null;
    this.channel = null;
    channel?.close();
    for (const finish of this.portChecks.values()) finish(new Error('Preview reconnecting'));
    for (const streamId of [...this.streams.keys()]) this.closeStream(streamId, false);
  }

  async start() {
    if (this.started) throw new Error('Preview already started');
    this.started = true;
    try {
      await this.pair();
      await this.checkPort();
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
        tunnelId: this.localId, preferredPort: this.target.port,
      });
      if (this.closed) {
        await invoke('preview_stop', { tunnelId: this.localId }).catch(() => {});
        throw new Error('Preview closed');
      }
      this.retransmitTimer = setInterval(() => this.retransmit(), RETRANSMIT_CHECK_MS);
      const url = `${this.localOrigin}${this.target.pathname}${this.target.search}${this.target.hash}`;
      this.status(`Opening ${this.target.displayUrl} on ${this.device}`);
      return url;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  checkPort() {
    if (this.closed) return Promise.reject(new Error('Preview closed'));
    this.status(`Checking port ${this.target.port} on ${this.device}…`);
    return new Promise((resolve, reject) => {
      const streamId = crypto.randomUUID();
      const timer = setTimeout(() => finish(new Error(`Port check timed out on ${this.device}:${this.target.port}`)), 5000);
      const finish = error => {
        clearTimeout(timer);
        this.portChecks.delete(streamId);
        this.channel?.send({ type: 'close', streamId });
        if (error) reject(error);
        else resolve();
      };
      this.portChecks.set(streamId, finish);
      if (!this.channel?.send({ type: 'open', streamId })) {
        finish(new Error('Could not check the remote port'));
      }
    });
  }

  handleControl(value) {
    let message;
    try { message = JSON.parse(value); } catch { return; }
    if (message.action !== 'preview_tunnel' || message.tunnelId !== this.tunnelId || this.closed) return;
    if (message.type === 'offer') {
      if (message.side !== 'app' || this.channel) return this.lost('Invalid preview offer');
      try {
        const channel = this.channel = new PreviewDataChannel({ key: this.key, offer: message });
        channel.addEventListener('open', () => {
          if (this.channel === channel) this.resolveReady?.();
        });
        channel.addEventListener('message', event => {
          if (this.channel === channel) this.remoteMessage(event.data);
        });
        channel.addEventListener('error', event => {
          if (this.channel === channel) this.lost(event.data || 'Preview data connection failed');
        });
        channel.addEventListener('close', () => {
          if (this.channel === channel) this.lost('Preview data connection closed');
        });
      } catch {
        this.lost('Could not open preview data channel');
      }
    } else if (message.type === 'ready') {
      this.channel?.authorize(message);
      clearTimeout(this.renewTimer);
      const delay = message.credentials?.expiresAt * 1000 - Date.now() - 120000;
      if (Number.isFinite(delay)) this.renewTimer = setTimeout(() => this.sendControl('renew'),
        Math.max(60000, Math.min(300000, delay)));
    } else if (message.type === 'error' || message.type === 'closed') {
      this.lost(message.message || message.reason || 'Preview connection closed');
    }
  }

  nativeOpen(payload) {
    if (this.closed || payload.tunnelId !== this.localId || !UUID.test(payload.streamId)) return;
    this.status(`Connecting to port ${this.target.port} on ${this.device}`);
    const stream = {
      id: payload.streamId, opened: false, localFin: false, remoteFin: false,
      nextOutgoing: 1, nextIncoming: 1, lastWritten: 0,
      pendingOutgoing: new Map(), pendingIncoming: new Map(), pendingBytes: 0,
      outstanding: new Map(), lastAcked: 0, localFinSeq: null, remoteFinSeq: null,
      flushing: false, openSentAt: Date.now(),
    };
    this.streams.set(stream.id, stream);
    // While pairing again, retransmit() sends the open once the new channel is ready.
    if (!this.channel || this.reconnecting) stream.openSentAt = 0;
    else if (!this.channel.send({ type: 'open', streamId: stream.id })) this.lost('Preview stream could not open');
  }

  // API Gateway can drop frames sent on a deflate-negotiated socket, which browsers always offer.
  // The Bridge ignores duplicate bytes and answers a duplicate open again.
  retransmit() {
    if (!this.channel || this.reconnecting) return;
    const now = Date.now();
    for (const stream of this.streams.values()) {
      if (!stream.opened) {
        if (now - stream.openSentAt < RETRANSMIT_MS) continue;
        stream.openSentAt = now;
        if (!this.channel.send({ type: 'open', streamId: stream.id })) return;
        continue;
      }
      for (const [seq, frame] of stream.outstanding) {
        if (now - frame.sentAt < RETRANSMIT_MS) break;
        if (this.channel.bufferedAmount >= CHANNEL_HIGH_BYTES) return;
        frame.sentAt = now;
        if (!this.channel.send({ type: 'bytes', streamId: stream.id, seq, data: frame.data })) return;
      }
    }
  }

  nativeBytes(payload) {
    const stream = this.streams.get(payload.streamId);
    if (!stream || payload.tunnelId !== this.localId || !stream.opened
      || !Number.isSafeInteger(payload.seq) || payload.seq < stream.nextOutgoing
      || payload.seq > stream.nextOutgoing + 32) return;
    if (stream.pendingOutgoing.has(payload.seq)) return;
    stream.pendingOutgoing.set(payload.seq, payload.data);
    this.flushOutgoing(stream);
  }

  nativeFin(payload) {
    const stream = this.streams.get(payload.streamId);
    if (!stream || payload.tunnelId !== this.localId) return;
    stream.localFinSeq = payload.seq;
    this.flushOutgoing(stream);
  }

  nativeClose(payload) {
    if (payload.tunnelId !== this.localId) return;
    this.closeStream(payload.streamId, true);
  }

  scheduleFlush() {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      for (const stream of this.streams.values()) this.flushOutgoing(stream);
    }, 5);
  }

  flushOutgoing(stream) {
    while (stream.opened && stream.pendingOutgoing.has(stream.nextOutgoing)) {
      // Native credit bounds each stream; this bounds their sum on the shared channel.
      if (this.channel.bufferedAmount >= CHANNEL_HIGH_BYTES) {
        this.scheduleFlush();
        return;
      }
      const seq = stream.nextOutgoing++;
      const data = stream.pendingOutgoing.get(seq);
      stream.pendingOutgoing.delete(seq);
      const bytes = decodedLength(data);
      if (bytes <= 0 || bytes > CHUNK_BYTES
        || !this.channel.send({ type: 'bytes', streamId: stream.id, seq, data })) {
        this.closeStream(stream.id, true);
        return;
      }
      stream.outstanding.set(seq, { bytes, data, sentAt: Date.now() });
    }
    if (!stream.localFin && stream.localFinSeq !== null
      && stream.nextOutgoing > stream.localFinSeq) {
      stream.localFin = true;
      this.channel.send({ type: 'fin', streamId: stream.id, seq: stream.localFinSeq });
      this.maybeCloseStream(stream);
    }
  }

  remoteMessage(message) {
    if (this.closed) return;
    const portCheck = this.portChecks.get(message.streamId);
    if (portCheck) {
      if (message.type === 'opened') portCheck();
      else if (message.type === 'error' || message.type === 'close' || message.type === 'fin') {
        portCheck(new Error(message.code === 'connection_refused'
          ? `Port ${this.target.port} is not listening on ${this.device}`
          : `Could not connect to port ${this.target.port} on ${this.device}`));
      }
      return;
    }
    const stream = this.streams.get(message.streamId);
    if (!stream || this.closed) return;
    if (message.type === 'opened') {
      stream.opened = true;
      this.status(`Connected to port ${this.target.port} on ${this.device}`);
      void invoke('preview_credit', { streamId: stream.id, bytes: WINDOW_BYTES })
        .catch(() => this.closeStream(stream.id, true));
      this.status(`Loading ${this.target.displayUrl}`);
    } else if (message.type === 'ack') {
      if (message.seq >= stream.nextOutgoing) {
        this.closeStream(stream.id, true);
        return;
      }
      // Frames are relayed independently, so an older cumulative ACK can arrive late.
      if (message.seq <= stream.lastAcked) return;
      let credited = 0;
      for (const [seq, frame] of stream.outstanding) {
        if (seq > message.seq) break;
        stream.outstanding.delete(seq);
        credited += frame.bytes;
      }
      stream.lastAcked = message.seq;
      if (credited) void invoke('preview_credit', { streamId: stream.id, bytes: credited })
        .catch(() => this.closeStream(stream.id, true));
    } else if (message.type === 'bytes') {
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
    } catch {
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
    for (const finish of this.portChecks.values()) finish(new Error('Preview closed'));
    this.rejectReady?.(new Error('Preview closed'));
    clearTimeout(this.flushTimer);
    clearInterval(this.retransmitTimer);
    clearTimeout(this.pairTimer);
    clearTimeout(this.renewTimer);
    this.sendControl('close');
    this.channel?.close();
    this.control?.close();
    this.streams.clear();
    for (const unlisten of this.unlisteners) unlisten();
    this.unlisteners = [];
    if (this.localOrigin) await invoke('preview_stop', { tunnelId: this.localId }).catch(() => {});
  }
}
