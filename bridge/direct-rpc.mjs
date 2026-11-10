// v2 direct channel: the Bridge keeps a `bridge_data` socket on the data API, receives signed App
// requests on it without Lambda, answers straight to the requester's socket, and pushes Session
// events to the connections subscribed to them.
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { deflateRawSync, inflateRawSync } from 'zlib';
import { createHeaderSigner } from './terminal-direct-protocol.mjs';
import { RpcAssembler, decodeRpcPayload, isRpcRequest, pushFrames, rpcAckFrame, rpcErrorFrame, rpcResultFrames } from './direct-rpc-protocol.mjs';

const MAX_CONCURRENT = 4;
// A resend reuses its requestId: it gets the stored reply (or the reply still being computed).
const REPLY_TTL_MS = 30_000;
const MAX_REPLIES = 256;
const PING_MS = 5 * 60_000;
const PONG_TIMEOUT_MS = 10_000;
const LEASE_MS = 150_000;
const RENEW_MS = 5 * 60_000;
const MAX_BUFFERED = 1024 * 1024;
const MAX_REQUEST_CHUNKS = 64; // about 1.2 MB of compressed params

// Which App connections watch which Session. Nothing tells the Bridge that an App socket closed,
// so a subscription is a lease the App renews; only these connections receive pushes.
export class SessionSubscribers {
  constructor() {
    this.sessions = new Map(); // sessionId → Map(connectionId → { expires, deflate })
  }

  add(sessionId, connectionId, deflate) {
    if (!sessionId || !connectionId) return;
    let targets = this.sessions.get(sessionId);
    if (!targets) this.sessions.set(sessionId, targets = new Map());
    targets.set(connectionId, { expires: Date.now() + LEASE_MS, deflate: deflate ?? targets.get(connectionId)?.deflate ?? false });
  }

  remove(sessionId, connectionId) {
    const targets = this.sessions.get(sessionId);
    if (targets?.delete(connectionId) && !targets.size) this.sessions.delete(sessionId);
  }

  targets(sessionId, now = Date.now()) {
    const targets = this.sessions.get(sessionId);
    if (!targets) return [];
    for (const [connectionId, entry] of targets) if (entry.expires <= now) targets.delete(connectionId);
    if (!targets.size) this.sessions.delete(sessionId);
    return [...targets];
  }
}

export class DirectRpcBridge {
  constructor({ key, sendControl, handlers, subscribers, socketFactory }) {
    this.key = key;
    this.sendControl = sendControl;
    this.handlers = handlers;
    this.subscribers = subscribers || new SessionSubscribers();
    this.socketFactory = socketFactory || ((url) => new WebSocket(url, { handshakeTimeout: 15000, perMessageDeflate: false }));
    this.auth = null;
    this.socket = null;
    this.pending = false;
    this.running = 0;
    this.queue = [];
    this.signers = new Map();
    this.replies = new Map(); // requestId → { replyTo, frames, at }
    this.requestParts = new RpcAssembler(32);
    this.active = true;
  }

  start() {
    this.requestCredentials();
  }

  // Data-API credentials come from the server over the control socket. They are asked for at
  // start and again when a frame is about to be signed with little time left; no timer.
  requestCredentials() {
    if (!this.active || this.renewing) return;
    this.askedAt = Date.now();
    let done;
    this.renewing = new Promise((resolve) => { done = resolve; });
    const finish = () => { clearTimeout(timer); this.renewing = null; this.credentialsArrived = null; done(); };
    const timer = setTimeout(finish, 10_000);
    timer.unref?.();
    this.credentialsArrived = finish;
    if (!this.sendControl({ action: 'direct_rpc', op: 'credentials' })) finish();
  }

  async authorization() {
    const left = this.auth ? this.auth.credentials.expiresAt * 1000 - Date.now() : 0;
    if (left < RENEW_MS && Date.now() - (this.askedAt || 0) > 10_000) this.requestCredentials();
    if (left < 5000) await this.renewing;
    return this.auth;
  }

  requestToken() {
    if (!this.active) return;
    this.pending = true;
    clearTimeout(this.tokenTimer);
    this.tokenTimer = setTimeout(() => { if (this.pending && !this.socket) this.retry(); }, 10_000);
    this.tokenTimer.unref?.();
    if (!this.sendControl({ action: 'direct_rpc', op: 'bridge_token' })) this.retry();
  }

  // Control-socket replies for this channel; returns true when consumed.
  handleControl(message) {
    if (message?.action !== 'direct_rpc') return false;
    if (message.type === 'credentials') {
      if (message.credentials) {
        this.auth = { endpoint: message.endpoint, region: message.region, credentials: message.credentials };
        this.signers.clear();
      }
      this.credentialsArrived?.();
      if (!this.auth) this.retry();
      else if (!this.socket && !this.pending) this.requestToken();
      return true;
    }
    clearTimeout(this.tokenTimer);
    if (message.type === 'token' && this.auth) this.open(message.token);
    else this.retry();
    return true;
  }

  open(token) {
    const url = new URL(this.auth.endpoint);
    url.protocol = 'wss:';
    url.search = new URLSearchParams({ apiKey: this.key, role: 'bridge_data' }).toString();
    const socket = this.socket = this.socketFactory(url.href);
    socket.on('open', () => socket.send(JSON.stringify({ action: 'direct_rpc', op: 'bridge_join', token })));
    socket.on('message', (data) => this.receive(socket, data.toString()));
    socket.on('close', () => this.closed(socket));
    socket.on('error', () => {});
  }

  receive(socket, text) {
    if (socket !== this.socket) return;
    if (text === '{"action":"realtime_pong"}') { clearTimeout(this.pongTimer); return; }
    let frame;
    try { frame = JSON.parse(text); } catch { return; }
    if (frame.action === 'direct_rpc' && frame.type === 'joined') {
      this.pending = false;
      console.log('[direct-rpc] joined');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(socket), PING_MS);
      this.pingTimer.unref?.();
      return;
    }
    if (frame.action === 'direct_rpc' && frame.type === 'error') { socket.close(); return; }
    if (!isRpcRequest(frame)) return;
    if (frame.chunk) return void this.receiveChunk(frame);
    this.accept(frame);
  }

  // Chunks of a long request; the request is handled once all of them arrived.
  async receiveChunk(frame) {
    if (this.replies.has(frame.requestId)) return frame.chunk.index === 0 ? this.accept(frame) : undefined; // a resend: reply once
    if (!(frame.chunk.count <= MAX_REQUEST_CHUNKS)) return this.deliver([rpcErrorFrame(frame.requestId, 'too_large', frame.method)], frame.replyTo, { method: frame.method });
    const part = this.requestParts.add({ ...frame, kind: 'rpc_result' });
    if (!part?.payload) return;
    const { chunk, enc, data, ...head } = frame;
    let params;
    try { params = await decodeRpcPayload(part.payload, inflateRawSync); } catch { return; }
    this.accept({ ...head, params });
  }

  accept(frame) {
    const label = { method: frame.method };
    if (frame.ack) void this.deliver([rpcAckFrame(frame.requestId)], frame.replyTo, label);
    const known = this.replies.get(frame.requestId);
    if (known) {
      known.replyTo = frame.replyTo; // a reconnected App has a new connection id
      const missing = Array.isArray(frame.missing) ? frame.missing : null;
      if (known.frames) void this.deliver(known.frames.filter((out) => !missing || missing.includes(out.chunk.index)), frame.replyTo, label);
      return;
    }
    this.remember(frame);
    if (this.running >= MAX_CONCURRENT) this.queue.push(frame);
    else void this.serve(frame);
  }

  remember(frame) {
    const now = Date.now();
    for (const [id, reply] of this.replies) { // oldest first; replies still being computed stay
      if (!reply.frames) continue;
      if (now - reply.at < REPLY_TTL_MS && this.replies.size < MAX_REPLIES) break;
      this.replies.delete(id);
    }
    this.replies.set(frame.requestId, { replyTo: frame.replyTo, frames: null, at: now });
  }

  ping(socket) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ action: 'realtime_ping' }));
    clearTimeout(this.pongTimer);
    this.pongTimer = setTimeout(() => socket.terminate(), PONG_TIMEOUT_MS);
    this.pongTimer.unref?.();
  }

  async serve(frame) {
    this.running++;
    let frames;
    try {
      const handler = this.handlers[frame.method];
      if (!handler) throw new Error('unknown method');
      const deflate = !!frame.accept?.includes('deflate');
      const result = await handler(frame.params || {}, { replyTo: frame.replyTo, deflate });
      frames = rpcResultFrames(frame.requestId, result, { deflate: deflate ? deflateRawSync : null, method: frame.method });
    } catch (error) {
      frames = [rpcErrorFrame(frame.requestId, error.message, frame.method)];
    }
    const reply = this.replies.get(frame.requestId);
    if (reply) Object.assign(reply, { frames, at: Date.now() });
    await this.deliver(frames, reply?.replyTo || frame.replyTo, { method: frame.method });
    this.running--;
    const next = this.queue.shift();
    if (next) void this.serve(next);
  }

  // Pushes are best effort: with no subscriber, no socket or a backlog the event is dropped, and
  // the App recovers from the turn's seq gap or its next history request.
  // `targets` (default: the Session's subscribers) is [[connectionId, { deflate }]].
  publish(event, targets = this.subscribers.targets(event.sessionId)) {
    if (!targets.length || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_BUFFERED) return;
    const id = randomUUID();
    const label = { event: event.action };
    let plain;
    let deflated;
    for (const [connectionId, { deflate }] of targets) {
      const frames = deflate ? (deflated ||= pushFrames(id, event, { deflate: deflateRawSync })) : (plain ||= pushFrames(id, event));
      void this.deliver(frames, connectionId, label, 'push');
    }
  }

  async deliver(frames, target, label, action = 'rpc') {
    try {
      if (!await this.authorization()) return;
      const sign = this.signer(target, action);
      for (const out of frames) {
        const signed = await sign(JSON.stringify(out), undefined, label);
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(signed);
      }
    } catch (error) {
      console.error(`[direct-rpc] ${action} failed: ${error.message}`);
    }
  }

  signer(target, action) {
    const key = action + ' ' + target;
    let sign = this.signers.get(key);
    if (!sign) {
      sign = createHeaderSigner({ endpoint: this.auth.endpoint, region: this.auth.region,
        credentials: this.auth.credentials, target, action });
      this.signers.set(key, sign);
      if (this.signers.size > 256) this.signers.delete(this.signers.keys().next().value);
    }
    return sign;
  }

  closed(socket) {
    if (socket !== this.socket) return;
    this.socket = null;
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    this.retry();
  }

  retry() {
    this.pending = false;
    if (!this.active || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.socket) return;
      if (this.auth) this.requestToken();
      else this.requestCredentials();
    }, 2000 + Math.random() * 3000);
    this.retryTimer.unref?.();
  }

  dispose() {
    this.active = false;
    this.credentialsArrived?.();
    clearTimeout(this.retryTimer);
    clearTimeout(this.tokenTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.removeAllListeners(); socket.on('error', () => {}); socket.terminate(); }
  }
}
