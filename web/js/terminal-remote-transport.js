import { openStream } from './v2/direct-transport.js';

// A terminal page's stream to its Bridge, on the App's one direct socket. Input carries
// `clientSeq` and is sent again until acknowledged; output carries `eventSeq` and is put back in
// order. A gap that does not fill in GAP_MS ends the stream, and the page reconnects with a fresh
// snapshot.
const RESEND_MS = 1500;
const HEARTBEAT_MS = 30_000;
const SILENT_MS = 90_000;
const GAP_MS = 3000;
const MAX_UNACKED_BYTES = 256 * 1024;

export class RemoteTerminalSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  stream = null;
  clientSeq = 0;
  eventSeq = 1;
  outputSeq = 0;
  pending = new Map();
  pendingBytes = 0;
  unacked = new Map(); // clientSeq (0 = open) → { message, size, sentAt }
  // 72 random bits: unique among one Bridge's pages, shorter on every frame than a UUID.
  terminalId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(9)))).replace(/\+/g, '-').replace(/\//g, '_');

  constructor(device, { projectHash } = {}) {
    super();
    this.device = device;
    this.projectHash = projectHash;
    Promise.resolve().then(() => this.connect());
  }

  get bufferedAmount() {
    return (this.stream?.bufferedAmount || 0) + [...this.unacked.values()].reduce((sum, entry) => sum + entry.size, 0);
  }

  connect() {
    if (this.readyState !== WebSocket.CONNECTING) return;
    if (!this.device || !this.projectHash) return this.fail('Sign in on the main page and select an online device.');
    this.stream = openStream(this.device, 'terminal', this.terminalId, message => this.receive(message));
    this.readyState = WebSocket.OPEN;
    this.readyTimeout = setTimeout(() => this.fail('Remote terminal timed out. Check that Bridge is online and updated.'), 15000);
    this.resendTimer = setInterval(() => this.resend(), 500);
    this.dispatchEvent(new Event('open'));
  }

  send(payload) {
    if (this.readyState !== WebSocket.OPEN) return;
    const message = JSON.parse(payload);
    const clientSeq = message.type === 'open' ? 0 : ++this.clientSeq;
    const out = { ...message, clientSeq, ...(clientSeq ? {} : { projectHash: this.projectHash }) };
    const size = JSON.stringify(out).length;
    if (this.bufferedAmount + size > MAX_UNACKED_BYTES) {
      return this.fail('Input queue full. Session stopped; input will not be replayed.');
    }
    this.unacked.set(clientSeq, { message: out, size, sentAt: Date.now() });
    this.stream.send(out);
  }

  // A frame lost on the way is sent again; the Bridge acknowledges a duplicate without applying it.
  resend() {
    const now = Date.now();
    for (const entry of this.unacked.values()) {
      if (now - entry.sentAt < RESEND_MS) continue;
      entry.sentAt = now;
      this.stream.send(entry.message);
    }
  }

  receive(message) {
    try {
      if (this.readyState !== WebSocket.OPEN) return;
      this.unacked.delete(0); // any answer means the open arrived
      // The Bridge sends input acknowledgements on its next message when it has one.
      if (Number.isSafeInteger(message.ack) && message.type !== 'ack') this.deliver({ type: 'ack', clientSeq: message.ack });
      if (message.type === 'ack' && message.eventSeq === 0) {
        if (!Number.isSafeInteger(message.clientSeq) || message.clientSeq < 1) throw new Error('Invalid input acknowledgment');
        return this.deliver(message);
      }
      if (message.type === 'error' && message.eventSeq === 0) return this.deliver(message);
      if (!Number.isSafeInteger(message.eventSeq) || message.eventSeq < 1) throw new Error('Invalid output sequence');
      if (message.eventSeq < this.eventSeq || this.pending.has(message.eventSeq)) return;
      this.pending.set(message.eventSeq, message);
      this.pendingBytes += message.data?.length || 0;
      if (message.eventSeq - this.eventSeq > 256 || this.pendingBytes > 2 * 1024 * 1024) throw new Error('Output reorder queue full');
      while (this.pending.has(this.eventSeq)) {
        const next = this.pending.get(this.eventSeq);
        this.pending.delete(this.eventSeq++);
        this.pendingBytes -= next.data?.length || 0;
        this.deliver(next);
      }
      if (!this.pending.size) { clearTimeout(this.gapTimeout); this.gapTimeout = null; }
      else if (!this.gapTimeout) this.gapTimeout = setTimeout(() => this.fail('Output missing. Reconnecting.'), GAP_MS);
    } catch (error) {
      this.fail(error.message);
    }
  }

  deliver(message) {
    if (message.type === 'ack') {
      this.lastAckAt = Date.now();
      for (const sequence of this.unacked.keys()) if (sequence <= message.clientSeq) this.unacked.delete(sequence);
      return;
    }
    if (message.type === 'ready') {
      clearTimeout(this.readyTimeout);
      clearInterval(this.heartbeat);
      this.lastAckAt = Date.now();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastAckAt > SILENT_MS) return this.fail('Bridge is not responding. Session stopped.');
        this.send(JSON.stringify({ type: 'heartbeat' }));
      }, HEARTBEAT_MS);
    }
    if (message.type === 'output') message = { ...message, seq: ++this.outputSeq };
    if (message.type === 'closed') return this.close();
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  cleanup() {
    clearTimeout(this.readyTimeout);
    clearTimeout(this.gapTimeout);
    clearInterval(this.heartbeat);
    clearInterval(this.resendTimer);
    this.pending.clear();
    this.unacked.clear();
  }

  fail(message) {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.dispatchEvent(new MessageEvent('error', { data: message }));
    this.close();
  }

  close() {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    this.stream?.send({ type: 'detach', clientSeq: ++this.clientSeq });
    this.stream?.close();
    this.cleanup();
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code: 1000, reason: 'Terminal closed' }));
  }
}
