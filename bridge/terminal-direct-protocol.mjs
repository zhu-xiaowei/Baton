const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_FRAME = 28 * 1024;
const CONNECTION = /^[A-Za-z0-9_+=.-]{1,256}$/;
const INPUT_TYPES = new Set(['open', 'input', 'resize', 'heartbeat', 'close']);
const OUTPUT_TYPES = new Set(['ready', 'output', 'ack', 'error', 'resized', 'exit', 'closed']);
const SHARED_INPUT_TYPES = new Set(['open', 'input', 'resize', 'heartbeat', 'detach', 'render_ack', 'create_session', 'select_session', 'close_session']);
const SHARED_OUTPUT_TYPES = new Set(['ready', 'snapshot', 'synced', 'output', 'ack', 'error', 'resized', 'exit', 'peers', 'sessions', 'session_result']);

function emit(target, type, fields = {}) {
  target.dispatchEvent(Object.assign(new Event(type), fields));
}

function hex(bytes) {
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmac(key, value) {
  const imported = await crypto.subtle.importKey('raw', typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', imported, encoder.encode(value));
}

export async function authenticateFrame(payload, key) {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Invalid session frame key');
  return { payload, mac: hex(await hmac(key, payload)) };
}

export async function verifyFrame(frame, key) {
  if (typeof frame?.payload !== 'string' || !/^[0-9a-f]{64}$/.test(frame.mac || '')) return false;
  const imported = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(frame.mac.match(/../g), value => parseInt(value, 16));
  return crypto.subtle.verify('HMAC', imported, signature, encoder.encode(frame.payload));
}

function encodePath(path) {
  return path.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g,
    value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

export function createHeaderSigner({ endpoint, region, target, credentials, action = 'terminal_direct_data' }) {
  const base = new URL(endpoint);
  if (base.protocol !== 'https:' || base.search || base.hash || base.username || base.password
    || !CONNECTION.test(target) || !/^[a-z0-9-]+$/.test(region)
    || !credentials?.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken
    || !Number.isSafeInteger(credentials.expiresAt)) throw new Error('Invalid signing authorization');
  let cachedDate;
  let cachedKey;
  return async (body, now = new Date()) => {
    if (now.getTime() >= credentials.expiresAt * 1000 - 2000) throw new Error('Signing authorization expired');
    const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = stamp.slice(0, 8);
    if (cachedDate !== date) {
      cachedDate = date;
      cachedKey = hmac(`AWS4${credentials.secretAccessKey}`, date)
        .then(key => hmac(key, region)).then(key => hmac(key, 'execute-api')).then(key => hmac(key, 'aws4_request'));
    }
    const signedHeaders = 'host;x-amz-date;x-amz-security-token';
    const headers = `host:${base.host}\nx-amz-date:${stamp}\nx-amz-security-token:${credentials.sessionToken}\n`;
    const path = `${base.pathname.replace(/\/$/, '')}/@connections/${target}`;
    const canonical = ['POST', encodePath(path), '', headers, signedHeaders, await digest(body)].join('\n');
    const scope = `${date}/${region}/execute-api/aws4_request`;
    const signature = hex(await hmac(await cachedKey, `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${await digest(canonical)}`));
    const frame = JSON.stringify({ action, target, body, date: stamp,
      token: credentials.sessionToken,
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` });
    if (encoder.encode(frame).length > MAX_FRAME) throw new Error('Signed frame exceeds 28 KiB');
    return frame;
  };
}

export class DirectDataChannel extends EventTarget {
  readyState = 0;
  pendingBytes = 0;
  incoming = [];
  incomingBytes = 0;
  queue = Promise.resolve();
  receiveQueue = Promise.resolve();
  receiveBytes = 0;
  signer = null;

  constructor({ endpoint, key, offer, socketFactory = url => new WebSocket(url) }) {
    super();
    this.offer = offer;
    this.expectedEndpoint = new URL(offer.dataEndpoint);
    if (this.expectedEndpoint.protocol !== 'https:' || this.expectedEndpoint.search || this.expectedEndpoint.hash) throw new Error('Invalid data endpoint');
    this.expectedEndpoint.protocol = 'https:';
    this.expectedEndpoint.search = '';
    this.expectedEndpoint.hash = '';
    const url = new URL(this.expectedEndpoint);
    url.protocol = 'wss:';
    url.search = new URLSearchParams({ apiKey: key, role: 'terminal_data', version: 'xterm-direct-1' });
    this.socket = socketFactory(url);
    this.timeout = setTimeout(() => this.fail('Direct connection authorization timed out.'), 30000);
    this.socket.addEventListener('open', () => {
      if (this.readyState !== 0) return;
      this.socket.send(JSON.stringify({ action: 'terminal_direct', v: 1, op: 'join', terminalId: offer.terminalId,
        side: offer.side, joinToken: offer.joinToken }));
    });
    this.socket.addEventListener('message', event => this.receive(event.data));
    this.socket.addEventListener('error', () => this.fail('Terminal data connection failed.'));
    this.socket.addEventListener('close', () => this.finish('Terminal data connection closed.'));
  }

  get bufferedAmount() {
    return this.pendingBytes + (this.socket?.bufferedAmount || 0);
  }

  authorize(message) {
    if (this.readyState > 1) return;
    if (message.terminalId !== this.offer.terminalId || message.device !== this.offer.device || message.side !== this.offer.side
      || message.endpoint !== this.expectedEndpoint.href.replace(/\/$/, '') || !CONNECTION.test(message.connectionId)
      || !CONNECTION.test(message.peerConnectionId) || message.connectionId === message.peerConnectionId
      || this.socket.readyState !== 1) return this.fail('Terminal authorization does not match this connection.');
    if (this.binding && (this.binding.connectionId !== message.connectionId || this.binding.peerConnectionId !== message.peerConnectionId)) {
      return this.fail('Terminal connection changed. Previous session cannot be reused.');
    }
    try {
      if (!/^[0-9a-f]{64}$/.test(message.frameKey) || (this.frameKey && this.frameKey !== message.frameKey)) throw new Error('Invalid session frame key');
      this.frameKey = message.frameKey;
      this.signer = createHeaderSigner({ endpoint: message.endpoint, region: message.region,
        target: message.peerConnectionId, credentials: message.credentials });
      const remaining = message.credentials.expiresAt * 1000 - Date.now() - 3000;
      if (remaining <= 0) throw new Error('Expired');
      this.binding = { connectionId: message.connectionId, peerConnectionId: message.peerConnectionId };
      clearTimeout(this.expiry);
      this.expiry = setTimeout(() => this.fail('Terminal authorization expired. Refresh to start a new session.'), remaining);
      clearTimeout(this.timeout);
      const opening = this.readyState === 0;
      this.readyState = 1;
      if (opening) emit(this, 'open');
      const pending = this.incoming;
      this.incoming = [];
      this.incomingBytes = 0;
      for (const payload of pending) this.receive(payload);
    } catch {
      this.fail('Invalid terminal signing authorization.');
    }
  }

  send(payload) {
    if (this.readyState !== 1) return false;
    try {
      const message = typeof payload === 'string' ? JSON.parse(payload) : payload;
      this.validate(message, this.offer.side === 'app' ? INPUT_TYPES : OUTPUT_TYPES);
      const framePayload = JSON.stringify({ action: 'terminal_direct_frame', v: 1, terminalId: this.offer.terminalId,
        device: this.offer.device, message });
      const bytes = encoder.encode(JSON.stringify(framePayload)).length + 4096;
      if (this.bufferedAmount + bytes > 1024 * 1024) throw new Error('Send backlog');
      this.pendingBytes += bytes;
      this.queue = this.queue.then(async () => {
        try {
          if (this.readyState !== 1) return;
          const body = JSON.stringify(await authenticateFrame(framePayload, this.frameKey));
          const frame = await this.signer(body);
          if (this.readyState !== 1 || this.socket.readyState !== 1) return;
          this.socket.send(frame);
        } finally {
          this.pendingBytes -= bytes;
        }
      }).catch(() => this.fail('Signing or sending failed. Input will not be replayed.'));
      return true;
    } catch {
      this.fail('Terminal send queue full or message too large.');
      return false;
    }
  }

  validate(message, types) {
    const shared = typeof this.offer.projectHash === 'string';
    const allowed = shared ? (types === INPUT_TYPES ? SHARED_INPUT_TYPES : SHARED_OUTPUT_TYPES) : types;
    if (!message || message.action !== (shared ? 'terminal_shared' : 'terminal_poc') || message.v !== 1 || message.terminalId !== this.offer.terminalId
      || (shared && message.projectHash !== this.offer.projectHash)
      || message.device !== this.offer.device || !allowed.has(message.type)) throw new Error('Invalid terminal frame');
  }

  receive(data) {
    if (this.readyState > 1) return;
    try {
      const payload = typeof data === 'string' ? data : decoder.decode(data);
      const bytes = encoder.encode(payload).length;
      if (bytes > MAX_FRAME) return;
      if (this.readyState === 0) {
        if (this.incomingBytes + bytes > 256 * 1024) return;
        this.incomingBytes += bytes;
        this.incoming.push(payload);
        return;
      }
      if (this.receiveBytes + bytes > 1024 * 1024) return;
      this.receiveBytes += bytes;
      this.receiveQueue = this.receiveQueue.then(async () => {
        try {
          if (this.readyState !== 1) return;
          const envelope = JSON.parse(payload);
          if (!await verifyFrame(envelope, this.frameKey)) return;
          const frame = JSON.parse(envelope.payload);
          if (frame.action !== 'terminal_direct_frame' || frame.v !== 1 || frame.terminalId !== this.offer.terminalId
            || frame.device !== this.offer.device) return;
          this.validate(frame.message, this.offer.side === 'bridge' ? INPUT_TYPES : OUTPUT_TYPES);
          this.deliver(frame);
        } catch {
          return;
        } finally {
          this.receiveBytes -= bytes;
        }
      });
    } catch {
      return;
    }
  }

  deliver(frame) {
    if (this.readyState !== 1) return;
    const message = { ...frame.message };
    delete message.replyConnectionId;
    if (this.offer.side === 'bridge') message.replyConnectionId = this.binding.peerConnectionId;
    emit(this, 'message', { data: JSON.stringify(message) });
  }

  fail(message) {
    if (this.readyState > 1) return;
    emit(this, 'error', { data: message });
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
    clearTimeout(this.expiry);
    clearTimeout(this.timeout);
    emit(this, 'close', { code: 1000, reason });
  }

  close() {
    if (this.readyState > 1) return;
    this.readyState = 2;
    this.socket.close(1000, 'Terminal session closed');
    this.finish();
  }
}

const borrowedControls = new WeakSet();

export class DirectAppSocket extends EventTarget {
  readyState = 0;

  constructor({ endpoint, key, terminalId, device, projectHash, initialOpen, controlSocket, socketFactory = url => new WebSocket(url) }) {
    super();
    this.options = { endpoint, key, terminalId, device, projectHash, initialOpen, socketFactory };
    const url = new URL(endpoint);
    url.search = new URLSearchParams({ apiKey: key, role: 'app' });
    this.borrowed = controlSocket?.readyState === 1 && controlSocket.url === url.href && !borrowedControls.has(controlSocket);
    this.control = this.borrowed ? controlSocket : socketFactory(url);
    if (this.borrowed) borrowedControls.add(this.control);
    this.timeout = setTimeout(() => this.fail('Direct Bridge connection timed out.'), 30000);
    this.controlListeners = {
      open: () => this.controlSend('open'),
      message: event => this.receive(event.data),
      error: () => this.fail('Terminal authorization connection failed.'),
      close: () => { this.close(); this.detachControl(); },
    };
    for (const [type, listener] of Object.entries(this.controlListeners)) this.control.addEventListener(type, listener);
    if (this.borrowed) queueMicrotask(() => this.controlSend('open'));
  }

  get bufferedAmount() {
    return this.channel?.bufferedAmount || 0;
  }

  controlSend(op) {
    if (op !== 'close' && this.readyState > 1) return;
    if (this.control.readyState === 1) this.control.send(JSON.stringify({ action: 'terminal_direct', v: 1,
      op, terminalId: this.options.terminalId, device: this.options.device,
      ...(op === 'open' && this.options.initialOpen ? { initialOpen: this.options.initialOpen } : {}),
      ...(this.options.projectHash ? { projectHash: this.options.projectHash } : {}) }));
  }

  receive(data) {
    try {
      const message = JSON.parse(typeof data === 'string' ? data : decoder.decode(data));
      if (message.action !== 'terminal_direct' || message.terminalId !== this.options.terminalId) return;
      if (message.type === 'closed') {
        this.fail(message.message || 'Terminal session ended.');
        this.detachControl();
        return;
      }
      if (this.readyState > 1) return;
      if (message.type === 'error') return this.fail(message.message || 'Terminal session ended.');
      if (message.v !== 1 || message.device !== this.options.device || message.side !== 'app') throw new Error('Invalid control frame');
      if (this.options.projectHash && message.projectHash !== this.options.projectHash) throw new Error('Project mismatch');
      if (message.type === 'offer') {
        if (this.channel) throw new Error('Duplicate terminal offer');
        this.initialOpenAccepted = !!message.initialOpen && !!this.options.initialOpen;
        this.channel = new DirectDataChannel({ ...this.options, offer: message });
        this.channel.addEventListener('open', () => {
          clearTimeout(this.timeout);
          this.readyState = 1;
          emit(this, 'open');
        });
        this.channel.addEventListener('message', event => emit(this, 'message', { data: event.data }));
        this.channel.addEventListener('error', event => this.fail(event.data));
        this.channel.addEventListener('close', () => this.close());
      } else if (message.type === 'ready') {
        if (!this.channel) throw new Error('Missing data connection');
        this.channel.authorize(message);
        clearTimeout(this.renewal);
        if (this.readyState === 1) this.renewal = setTimeout(() => this.controlSend('renew'),
          Math.max(1000, Math.min(300000, message.credentials.expiresAt * 1000 - Date.now() - 120000)));
      }
    } catch {
      this.fail('Invalid terminal authorization message.');
    }
  }

  send(payload) {
    return this.readyState === 1 && this.channel.send(payload);
  }

  fail(message) {
    if (this.readyState > 1) return;
    emit(this, 'error', { data: message });
    this.close();
  }

  detachControl(reusable = true) {
    clearTimeout(this.releaseTimeout);
    for (const [type, listener] of Object.entries(this.controlListeners)) this.control.removeEventListener(type, listener);
    if (this.borrowed && reusable) borrowedControls.delete(this.control);
  }

  close() {
    if (this.readyState > 1) return;
    this.readyState = 2;
    clearTimeout(this.timeout);
    clearTimeout(this.renewal);
    this.controlSend('close');
    this.channel?.close();
    if (this.borrowed && this.control.readyState === 1) {
      this.releaseTimeout = setTimeout(() => this.detachControl(false), 5000);
    } else {
      this.detachControl();
      if (!this.borrowed) this.control.close(1000, 'Terminal control closed');
    }
    this.readyState = 3;
    emit(this, 'close', { code: 1000, reason: 'Terminal closed' });
  }
}
