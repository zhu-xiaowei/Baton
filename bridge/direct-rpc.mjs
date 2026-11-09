// v2 direct request channel: the Bridge keeps a `bridge_data` socket on the data API, receives
// signed App requests on it without Lambda, and answers straight to the requester's socket.
import WebSocket from 'ws';
import { deflateRawSync } from 'zlib';
import { createHeaderSigner } from './terminal-direct-protocol.mjs';
import { isRpcRequest, rpcErrorFrame, rpcResultFrames } from './direct-rpc-protocol.mjs';

const MAX_CONCURRENT = 4;
// A resend reuses its requestId: it gets the stored reply (or the reply still being computed).
const REPLY_TTL_MS = 30_000;
const MAX_REPLIES = 256;
const PING_MS = 5 * 60_000;
const PONG_TIMEOUT_MS = 10_000;

export class DirectRpcBridge {
  constructor({ key, sendControl, handlers, socketFactory }) {
    this.key = key;
    this.sendControl = sendControl;
    this.handlers = handlers;
    this.socketFactory = socketFactory || ((url) => new WebSocket(url, { handshakeTimeout: 15000, perMessageDeflate: false }));
    this.auth = null;
    this.socket = null;
    this.pending = false;
    this.running = 0;
    this.queue = [];
    this.signers = new Map();
    this.replies = new Map(); // requestId → { replyTo, frames, at }
    this.active = true;
  }

  onCredentials(authorization) {
    if (!this.active || !authorization) return;
    this.auth = authorization;
    this.signers.clear();
    if (!this.socket && !this.pending) this.requestToken();
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
    const known = this.replies.get(frame.requestId);
    if (known) {
      known.replyTo = frame.replyTo; // a reconnected App has a new connection id
      const missing = Array.isArray(frame.missing) ? frame.missing : null;
      if (known.frames) void this.deliver(known.frames.filter((out) => !missing || missing.includes(out.chunk.index)), frame.replyTo);
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
      const result = await handler(frame.params || {});
      frames = rpcResultFrames(frame.requestId, result,
        { deflate: frame.accept?.includes('deflate') ? deflateRawSync : null });
    } catch (error) {
      frames = [rpcErrorFrame(frame.requestId, error.message)];
    }
    const reply = this.replies.get(frame.requestId);
    if (reply) Object.assign(reply, { frames, at: Date.now() });
    await this.deliver(frames, reply?.replyTo || frame.replyTo);
    this.running--;
    const next = this.queue.shift();
    if (next) void this.serve(next);
  }

  async deliver(frames, replyTo) {
    try {
      const sign = this.signer(replyTo);
      for (const out of frames) {
        const signed = await sign(JSON.stringify(out));
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(signed);
      }
    } catch (error) {
      console.error(`[direct-rpc] reply failed: ${error.message}`);
    }
  }

  signer(target) {
    let sign = this.signers.get(target);
    if (!sign) {
      sign = createHeaderSigner({ endpoint: this.auth.endpoint, region: this.auth.region,
        credentials: this.auth.credentials, target, action: 'terminal_direct_data' });
      this.signers.set(target, sign);
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
      if (!this.socket) this.requestToken();
    }, 2000 + Math.random() * 3000);
    this.retryTimer.unref?.();
  }

  dispose() {
    this.active = false;
    clearTimeout(this.retryTimer);
    clearTimeout(this.tokenTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket) { socket.removeAllListeners(); socket.on('error', () => {}); socket.terminate(); }
  }
}
