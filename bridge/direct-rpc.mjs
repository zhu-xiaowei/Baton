// v2 direct channel: the Bridge keeps a `bridge_data` socket on the data API, receives signed App
// requests on it without Lambda, answers straight to the requester's socket, pushes Session
// events to the connections subscribed to them, and carries terminal and preview streams.
import { createHash, randomUUID } from 'crypto';
import WebSocket from 'ws';
import { deflateRawSync, inflateRawSync } from 'zlib';
import { RpcAssembler, createHeaderSigner, decodeRpcPayload, isRpcRequest, isStreamFrame, openStreamMessage, packStreamMessage, pushFrames,
  relayChunkChars, rpcAckFrame, rpcErrorFrame, rpcProgressFrame, rpcResultFrames, sealStreamMessage, streamFrame, unpackStreamMessage } from './direct-rpc-protocol.mjs';
import { bridgeKeys, sealDeviceName } from './e2ee-node.mjs';
import { countFrame } from './frame-stats.mjs';

// Reads that use the machine (files, Git, transcripts) run at most this many at once; requests that
// only wait (sends, pushes, uploads) are not counted.
const MAX_CONCURRENT = 6;
// A request still running after PROGRESS_AFTER_MS tells the App every PROGRESS_MS that it is.
const PROGRESS_AFTER_MS = 5000;
const PROGRESS_MS = 15_000;
// A resend reuses its requestId: it gets the stored reply (or the reply still being computed).
const REPLY_TTL_MS = 30_000;
const MAX_REPLIES = 256;
const PING_MS = 5 * 60_000;
const RELAY_PING_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const RELAY_SILENT_MS = 75_000; // the account object's sweep (server/cloudflare/account.mjs)
const LEASE_MS = 150_000;
const RENEW_MS = 5 * 60_000;
const MAX_BUFFERED = 1024 * 1024;
const MAX_REQUEST_CHUNKS = 64; // about 1.2 MB of compressed params
// Pushes to one App within this window go out as one `batch` frame; the first after a quiet window at once.
const PUSH_BATCH_MS = 50;

// Which App connections watch which Session. Nothing tells the Bridge that an App socket closed,
// so a subscription is a lease the App renews; only these connections receive pushes.
// On relay (`leaseless`) the server reports closed Apps (`peer_left`) and subscriptions never expire.
export class SessionSubscribers {
  constructor() {
    this.sessions = new Map(); // sessionId → Map(connectionId → { expires, deflate })
    this.leaseless = false;
  }

  // `root`: the thread root the page shows, for pushes about the whole thread (titles, children).
  add(sessionId, connectionId, deflate, root) {
    if (!sessionId || !connectionId) return;
    let targets = this.sessions.get(sessionId);
    if (!targets) this.sessions.set(sessionId, targets = new Map());
    const previous = targets.get(connectionId);
    targets.set(connectionId, { expires: this.leaseless ? Infinity : Date.now() + LEASE_MS, deflate: deflate ?? previous?.deflate ?? false,
      root: root || previous?.root || sessionId });
  }

  has(sessionId, connectionId) {
    return (this.sessions.get(sessionId)?.get(connectionId)?.expires || 0) > Date.now();
  }

  remove(sessionId, connectionId) {
    const targets = this.sessions.get(sessionId);
    if (targets?.delete(connectionId) && !targets.size) this.sessions.delete(sessionId);
  }

  drop(connectionId) {
    for (const sessionId of [...this.sessions.keys()]) this.remove(sessionId, connectionId);
  }

  // `root`: also the connections watching a thread of that root.
  targets(sessionId, { root = false } = {}) {
    const now = Date.now();
    const found = new Map();
    for (const [id, targets] of this.sessions) {
      if (id !== sessionId && !root) continue;
      for (const [connectionId, entry] of targets) {
        if (entry.expires <= now) targets.delete(connectionId);
        else if (id === sessionId || entry.root === sessionId) found.set(connectionId, entry);
      }
      if (!targets.size) this.sessions.delete(id);
    }
    return [...found];
  }
}

export class DirectRpcBridge {
  // `limited(frame)`: whether the request counts against MAX_CONCURRENT (default: all do).
  // `streams[ch](frame)`: terminal / preview frames from Apps, their message already unpacked.
  // `controlSocket`: the socket `sendControl` writes to; on relay (announced with the credentials) it
  // carries the App frames too (`receiveFrame`), sent unsigned as `{ to, ...frame }`.
  // `accountKey` (K, 32 bytes): every frame but `account_key` is sealed (e2ee.mjs); `saveAccountKey(K)`
  // stores a K an App hands over (migration of existing users, docs/v2-accounts-e2ee-plan.md §9).
  // `device` / `label`: a hosted computer's ID and display name, sealed under K with every join.
  constructor({ key, accountKey, accountKeyAt, accounts = false, device = '', label = '', saveAccountKey, sendControl, controlSocket, handlers, subscribers, socketFactory, limited = () => true, streams = {} }) {
    this.key = key;
    this.accountKey = accountKey || null;
    this.accounts = accounts;
    this.device = device;
    this.label = label;
    this.keyAt = accountKeyAt;
    this.keys = accountKey ? this.newKeys() : null;
    this.saveAccountKey = saveAccountKey;
    this.peers = new Map(); // App connection → its session tag
    this.sendControl = sendControl;
    this.controlSocket = controlSocket;
    this.relay = false;
    this.maxFrameBytes = 0;
    this.handlers = handlers;
    this.streams = streams;
    this.limited = limited;
    this.subscribers = subscribers || new SessionSubscribers();
    this.socketFactory = socketFactory || ((url) => new WebSocket(url, { handshakeTimeout: 15000, perMessageDeflate: false }));
    this.auth = null;
    this.socket = null;
    this.pending = false;
    this.running = 0;
    this.queue = [];
    this.signers = new Map();
    this.replies = new Map(); // requestId → { replyTo, frames, at }
    this.outbox = new Map(); // App connection → { events, deflate, sentAt, timer }
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

  // The account's S3 transfer area with the same credentials (see transfer-store.mjs).
  async storageAccess() {
    const auth = await this.authorization();
    if (!auth?.storage) throw new Error('File storage is unavailable');
    return { ...auth.storage, credentials: auth.credentials };
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
    if (message?.action === 'peer_left') { this.dropPeer(message.id); return true; }
    if (message?.action === 'realtime_pong' && this.relay) { clearTimeout(this.pongTimer); this.lastPong = Date.now(); return true; }
    if (message?.action !== 'direct_rpc') return false;
    if (message.type === 'credentials') {
      if (message.transport === 'relay' && !this.relay) this.useRelay(message.maxFrameBytes);
      if (message.credentials) {
        this.auth = { endpoint: message.endpoint, region: message.region, credentials: message.credentials,
          storage: message.storage || null };
        this.signers.clear();
      }
      this.credentialsArrived?.();
      if (this.relay) { if (!this.joined && !this.pending) this.join(); } else if (!this.auth) this.retry();
      else if (!this.socket && !this.pending) this.requestToken();
      return true;
    }
    clearTimeout(this.tokenTimer);
    if (this.relay) {
      if (message.type !== 'joined') return this.retry(), true;
      this.joined = true;
      this.lastPong = Date.now();
      this.pending = false;
      // peer_left may have been missed while away; live Apps subscribe again on the new keys.
      this.subscribers.sessions.clear();
      console.log('[direct-rpc] joined');
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.ping(this.socket), RELAY_PING_MS);
      this.pingTimer.unref?.();
      return true;
    }
    if (message.type === 'token' && this.auth) this.open(message.token);
    else this.retry();
    return true;
  }

  // One socket for control and App frames; no second socket, no signing, no lease.
  useRelay(maxFrameBytes) {
    this.relay = true;
    this.maxFrameBytes = maxFrameBytes || 1024 * 1024;
    this.chunk = relayChunkChars(this.maxFrameBytes);
    this.socket = this.controlSocket;
    this.subscribers.leaseless = true;
  }

  join() {
    if (!this.active) return;
    this.pending = true;
    this.joined = false;
    clearTimeout(this.tokenTimer);
    this.tokenTimer = setTimeout(() => { if (this.pending) this.retry(); }, 10_000);
    this.tokenTimer.unref?.();
    if (!this.sendControl({ action: 'direct_rpc', op: 'bridge_join', ...this.joinFields() })) this.retry();
  }

  // The session key, and a hosted computer's display name sealed under K (both servers store it with the device row).
  joinFields() {
    const keys = this.keys ? { pub: this.keys.pub, fp: this.keys.fp } : {};
    return { ...keys, ...(this.accounts && this.accountKey && this.label ? sealDeviceName(this.accountKey, this.device, this.label) : {}) };
  }

  // A closed App connection (relay): nothing is kept for it.
  dropPeer(id) {
    if (!id) return;
    this.subscribers.drop(id);
    this.peers.delete(id);
    clearTimeout(this.outbox.get(id)?.timer);
    this.outbox.delete(id);
  }

  open(token) {
    const url = new URL(this.auth.endpoint);
    url.protocol = 'wss:';
    url.search = new URLSearchParams({ apiKey: this.key, role: 'bridge_data' }).toString();
    const socket = this.socket = this.socketFactory(url.href);
    socket.on('open', () => socket.send(JSON.stringify({ action: 'direct_rpc', op: 'bridge_join', token, ...this.joinFields() })));
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
    this.receiveFrame(frame, text.length);
  }

  // An App frame, parsed (relay: one the server relayed, i.e. with `to`, from the control socket).
  receiveFrame(frame, length) {
    countFrame('in', frame.ch ? 'stream:' + frame.ch : (frame.kind || frame.action || '?') + (frame.method ? ':' + frame.method : ''), length);
    if (isStreamFrame(frame)) {
      const session = this.keys && (frame.pk ? this.keys.session(frame.pk) : this.keys.byTag(frame.s));
      if (!session) return;
      openStreamMessage({ kind: 'stream', ch: frame.ch, id: frame.id }, frame.m, session.open)
        .then((opened) => {
          if (!opened) return null;
          this.notePeer(frame.from, session.tag); // only an opened frame may point replies at a connection
          return unpackStreamMessage(opened, inflateRawSync);
        })
        .then((opened) => opened && this.streams[frame.ch]?.({ ...frame, m: opened }), () => {});
      return;
    }
    if (!isRpcRequest(frame)) return;
    if (frame.chunk) return void this.receiveChunk(frame);
    if (frame.method !== 'account_key') return; // everything else is sealed, so it comes as chunks
    this.accept(frame);
  }

  // Chunks of a long request; the request is handled once all of them arrived.
  async receiveChunk(frame) {
    if (this.replies.has(frame.requestId)) return frame.chunk.index === 0 ? this.accept(frame) : undefined; // a resend: reply once
    if (!(frame.chunk.count <= MAX_REQUEST_CHUNKS)) return this.deliver([rpcErrorFrame(frame.requestId, 'too_large', frame.method)], frame.replyTo, { method: frame.method });
    const part = this.requestParts.add({ ...frame, kind: 'rpc_result' });
    if (!part?.payload) return;
    const { chunk, enc, data, ...head } = frame;
    const session = this.keys?.session(frame.pk || '');
    if (!session) return;
    let params;
    try { params = await decodeRpcPayload(part.payload, inflateRawSync, (_, text) => session.open(frame, text)); } catch { return; }
    this.notePeer(frame.replyTo, session.tag);
    this.accept({ ...head, params, session });
  }

  // Most recently heard from last (bridge/ws.mjs checkApps takes the newest).
  notePeer(id, tag) {
    this.peers.delete(id);
    this.peers.set(id, tag);
  }

  accept(frame) {
    if (frame.oneWay) return void Promise.resolve().then(() => this.handlers[frame.method]?.(frame.params || {}, { replyTo: frame.replyTo })).catch(() => {});
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
    if (!this.limited(frame)) void this.serve(frame, false);
    else if (this.running >= MAX_CONCURRENT) this.queue.push(frame);
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
    // Relay: the pong may queue behind this socket's own output; one still writing is given until the server's
    // own silence limit (75 s), when it would have been closed there anyway.
    const written = () => socket._socket?.bytesWritten ?? 0;
    let last = written();
    const check = () => {
      if (!this.relay || written() === last || Date.now() - this.lastPong > RELAY_SILENT_MS) return socket.terminate();
      last = written();
      (this.pongTimer = setTimeout(check, PONG_TIMEOUT_MS)).unref?.();
    };
    (this.pongTimer = setTimeout(check, PONG_TIMEOUT_MS)).unref?.();
  }

  async serve(frame, counted = true) {
    if (counted) this.running++;
    const label = { method: frame.method };
    const target = () => this.replies.get(frame.requestId)?.replyTo || frame.replyTo;
    // `progress(value)` lets a handler report what a page shows; silence is covered by the timer.
    let timer;
    const wait = (ms) => { clearTimeout(timer); timer = setTimeout(() => progress(), ms); timer.unref?.(); };
    const seal = frame.session?.seal;
    const progress = (value) => {
      wait(PROGRESS_MS);
      void this.deliver([rpcProgressFrame(frame.requestId, value, seal)], target(), label);
    };
    wait(PROGRESS_AFTER_MS);
    let frames;
    try {
      const handler = frame.method === 'account_key' ? (params) => this.accountKeyRequest(params) : this.handlers[frame.method];
      if (!handler) throw new Error('unknown method');
      const deflate = !!frame.accept?.includes('deflate');
      const params = frame.params || {};
      let result = await handler(params, { replyTo: frame.replyTo, deflate, progress });
      // With `known`, an unchanged result is answered by a marker (the App keeps its copy).
      if (params.known !== undefined && result && typeof result === 'object' && !Array.isArray(result)) {
        const fingerprint = createHash('sha256').update(JSON.stringify(result)).digest('hex').slice(0, 16);
        result = params.known === fingerprint ? { notModified: true, fingerprint } : { ...result, fingerprint };
      }
      frames = rpcResultFrames(frame.requestId, result, { deflate: deflate ? deflateRawSync : null, method: frame.method, seal, chunk: this.chunk });
    } catch (error) {
      frames = [rpcErrorFrame(frame.requestId, error.message, frame.method, seal)];
    } finally {
      clearTimeout(timer);
    }
    const reply = this.replies.get(frame.requestId);
    if (reply) Object.assign(reply, { frames, at: Date.now() });
    await this.deliver(frames, target(), label);
    if (!counted) return;
    this.running--;
    const next = this.queue.shift();
    if (next) void this.serve(next);
  }

  // Pushes are best effort: with no subscriber, no socket or a backlog the event is dropped, and
  // the App recovers from the turn's seq gap or its next history request.
  // `targets` (default: the Session's subscribers) is [[connectionId, { deflate }]].
  publish(event, targets = this.subscribers.targets(event.sessionId)) {
    if (!targets.length || this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_BUFFERED) return;
    const now = Date.now();
    for (const [connectionId, { deflate }] of targets) {
      let box = this.outbox.get(connectionId);
      if (!box) this.outbox.set(connectionId, box = { events: [], sentAt: 0, timer: null });
      box.events.push(event);
      box.deflate = deflate;
      if (box.timer) continue;
      const wait = box.sentAt + PUSH_BATCH_MS - now;
      if (wait <= 0) this.flushPushes(connectionId);
      else (box.timer = setTimeout(() => this.flushPushes(connectionId), wait)).unref?.();
    }
  }

  flushPushes(connectionId) {
    const box = this.outbox.get(connectionId);
    const { events, deflate } = box;
    Object.assign(box, { events: [], sentAt: Date.now(), timer: null });
    if (this.outbox.size > 512) for (const [id, other] of this.outbox) if (!other.timer && Date.now() - other.sentAt > PUSH_BATCH_MS) this.outbox.delete(id);
    const session = this.keys?.byTag(this.peers.get(connectionId));
    if (!session) return;
    const event = events.length === 1 ? events[0] : { action: 'batch', events };
    void this.deliver(pushFrames(randomUUID(), event, { deflate: deflate ? deflateRawSync : null, seal: session.seal, chunk: this.chunk }), connectionId, { event: event.action }, 'push');
  }

  // A terminal or preview message to an App connection. Best effort: both channels recover from
  // a sequence gap.
  // `deflate`: the page said it inflates.
  async sendStream(ch, id, target, message, deflate) {
    const session = this.keys?.byTag(this.peers.get(target));
    if (!session) return;
    // Relay: counted as buffered while it is sealed, so the preview pacing on the one socket sees it at once.
    const size = message.data?.length || 0;
    this.sealing = (this.sealing || 0) + size;
    try {
      const m = await sealStreamMessage({ kind: 'stream', ch, id }, await packStreamMessage(message, deflate ? deflateRawSync : null), session.seal);
      await this.deliver([streamFrame(ch, id, null, m)], target, { stream: ch }, 'push');
    } finally {
      this.sealing -= size;
    }
  }

  // Keys for this process; published by joining again (Apps then make new sessions).
  newKeys() {
    if (this.relay) setTimeout(() => this.join(), 300).unref?.();
    else if (this.socket) setTimeout(() => { const socket = this.socket; this.socket = null; socket?.close(); this.requestToken(); }, 300).unref?.();
    return bridgeKeys(this.accountKey, this.keyAt, () => { this.keys = this.newKeys(); });
  }

  // Clear on purpose: an App of this account hands K over or takes it (§9 migration). A new K is
  // published by joining again with new keys.
  accountKeyRequest({ k } = {}) {
    // A hosted account's K comes only by pairing: the relay must never see it in clear.
    if (this.accounts) return { fp: this.keys?.fp || '' };
    const raw = typeof k === 'string' ? Buffer.from(k, 'base64') : null;
    if (raw?.length === 32) this.setAccountKey(raw);
    return { fp: this.keys?.fp || '', ...(k ? {} : { k: this.accountKey?.toString('base64') || '' }) };
  }

  // A new K is published by joining again with new keys.
  setAccountKey(raw) {
    if (raw.equals(this.accountKey || Buffer.alloc(0))) return;
    this.accountKey = raw;
    this.keyAt = Date.now();
    this.keys = this.newKeys();
    this.saveAccountKey?.(raw);
  }

  get bufferedAmount() {
    return (this.socket?.bufferedAmount || 0) + (this.relay ? this.sealing || 0 : 0);
  }

  async deliver(frames, target, label, action = 'rpc') {
    if (this.relay) return this.relayDeliver(frames, target, label);
    try {
      if (!await this.authorization()) return;
      const sign = this.signer(target, action);
      for (const out of frames) {
        const signed = await sign(JSON.stringify(out), undefined, label);
        countFrame('out', out.kind + ':' + (label.method || label.event || label.stream || ''), signed.length);
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(signed);
      }
    } catch (error) {
      console.error(`[direct-rpc] ${action} failed: ${error.message}`);
    }
  }

  relayDeliver(frames, target, label) {
    for (const out of frames) {
      const text = JSON.stringify({ to: target, ...out });
      countFrame('out', out.kind + ':' + (label.method || label.event || label.stream || ''), text.length);
      if (Buffer.byteLength(text) > this.maxFrameBytes) { console.error(`[direct-rpc] dropped ${out.kind} over ${this.maxFrameBytes} bytes`); continue; }
      try { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text); } catch (error) { console.error(`[direct-rpc] send failed: ${error.message}`); }
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
      if (this.relay) { if (!this.joined) this.join(); return; }
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
    for (const box of this.outbox.values()) clearTimeout(box.timer);
    const socket = this.socket;
    this.socket = null;
    if (socket && !this.relay) { socket.removeAllListeners(); socket.on('error', () => {}); socket.terminate(); }
  }
}
