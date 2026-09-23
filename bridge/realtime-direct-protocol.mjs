import { verifyFrame } from './terminal-direct-protocol.mjs';
import { STREAM_EVENT_ACTIONS, OPTIONAL_TURN_EVENT_ACTIONS } from './live-turn-stream.mjs';

const encoder = new TextEncoder();

export function isRealtimeEvent(event) {
  return !!event?.sessionId && !!event?.turnId && Number.isInteger(event.seq) && event.seq >= 0
    && (STREAM_EVENT_ACTIONS.has(event.action) || OPTIONAL_TURN_EVENT_ACTIONS.has(event.action));
}

export function realtimePayload(event) {
  const { replyConnectionId, deliveryId, noCache, directDeliveredTo, ...payload } = event;
  return payload;
}

export class RealtimeReceiver {
  constructor({ control, key, receive, onStatusChange = () => {}, socketFactory = url => new WebSocket(url) }) {
    this.control = control;
    this.key = key;
    this.receive = receive;
    this.onStatusChange = onStatusChange;
    this.status = '';
    this.socketFactory = socketFactory;
    this.generation = 0;
    this.disposed = false;
    this.reset();
  }

  start() {
    if (this.disposed || this.control.readyState !== 1 || !globalThis.crypto?.subtle
      || typeof crypto.randomUUID !== 'function') return;
    this.reset();
    this.requestId = crypto.randomUUID();
    this.control.send(JSON.stringify({ action: 'realtime_direct', v: 1, op: 'open', requestId: this.requestId }));
    this.timeout = setTimeout(() => {
      const retry = !!this.socket;
      this.reset();
      if (retry) this.retry = setTimeout(() => this.start(), 3000);
      this.setStatus(retry ? 'reconnecting' : 'fallback');
    }, 15000);
  }

  handle(message) {
    if (message?.action !== 'realtime_direct' || message.v !== 1) return false;
    if (this.disposed || message.requestId !== this.requestId) return true;
    if (message.type === 'offer') {
      if (this.socket) return true;
      try {
        const url = new URL(message.endpoint);
        if (url.protocol !== 'https:' || !message.bindingId || !message.joinToken) return true;
        this.bindingId = message.bindingId;
        url.protocol = 'wss:';
        url.search = new URLSearchParams({ apiKey: this.key, role: 'realtime_data' });
        const socket = this.socketFactory(url.href);
        this.socket = socket;
        const generation = this.generation;
        socket.onopen = () => {
          if (generation !== this.generation) return;
          socket.send(JSON.stringify({ action: 'realtime_direct', v: 1, op: 'join',
            controlId: message.controlId, bindingId: this.bindingId, joinToken: message.joinToken }));
        };
        socket.onmessage = event => {
          if (generation === this.generation) this.accept(event.data);
        };
        socket.onerror = () => {};
        socket.onclose = () => {
          if (generation !== this.generation) return;
          this.reset();
          this.retry = setTimeout(() => this.start(), 3000);
          this.setStatus('reconnecting');
        };
      } catch {
        this.reset();
        this.setStatus('fallback');
      }
    } else if (message.type === 'ready' && message.bindingId === this.bindingId) {
      if (!/^[0-9a-f]{64}$/.test(message.frameKey || '')) return true;
      this.frameKey = message.frameKey;
      clearTimeout(this.timeout);
      this.setStatus('connected');
      const pending = this.pending;
      this.pending = [];
      this.pendingBytes = 0;
      for (const payload of pending) this.accept(payload);
    } else if (message.type === 'closed' || message.type === 'unsupported' || message.type === 'error') {
      this.reset();
      if (message.type === 'closed') this.retry = setTimeout(() => this.start(), 3000);
      this.setStatus(message.type === 'closed' ? 'reconnecting' : 'fallback');
    }
    return true;
  }

  setStatus(status) {
    if (this.disposed || this.status === status) return;
    this.status = status;
    this.onStatusChange(status);
  }

  accept(payload) {
    if (typeof payload !== 'string') return;
    const bytes = encoder.encode(payload).length;
    if (bytes > 32 * 1024) return;
    if (!this.frameKey) {
      if (this.pendingBytes + bytes > 256 * 1024) return;
      this.pending.push(payload);
      this.pendingBytes += bytes;
      return;
    }
    if (this.receiveBytes + bytes > 1024 * 1024) return;
    const generation = this.generation;
    const key = this.frameKey;
    this.receiveBytes += bytes;
    this.queue = this.queue.then(async () => {
      try {
        const envelope = JSON.parse(payload);
        if (!await verifyFrame(envelope, key) || generation !== this.generation) return;
        const frame = JSON.parse(envelope.payload);
        if (frame.action !== 'realtime_direct_frame' || frame.v !== 1 || frame.bindingId !== this.bindingId
          || !isRealtimeEvent(frame.event)) return;
        this.receive(frame.event);
      } catch {
      } finally {
        if (generation === this.generation) this.receiveBytes -= bytes;
      }
    });
  }

  reset() {
    this.generation++;
    clearTimeout(this.timeout);
    clearTimeout(this.retry);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.close();
    }
    this.socket = null;
    this.requestId = null;
    this.bindingId = null;
    this.frameKey = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.receiveBytes = 0;
    this.queue = Promise.resolve();
  }

  dispose() {
    this.disposed = true;
    this.reset();
  }
}
