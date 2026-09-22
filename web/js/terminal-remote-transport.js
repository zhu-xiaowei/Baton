import { DirectAppSocket } from '../../bridge/terminal-direct-protocol.mjs';
import { state } from './state.js';

let configuration = null;

function terminalConfiguration(server, key) {
  if (state.SERVER === server && state.KEY === key && state.ws?.readyState === WebSocket.OPEN && state.WS_URL) {
    return Promise.resolve({ wsUrl: state.WS_URL });
  }
  if (configuration?.server === server && configuration.key === key) return configuration.promise;
  const current = configuration = { server, key };
  current.promise = fetch(`${server}/api/bridge/config`, {
    headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15000),
  }).then(response => {
    if (!response.ok) throw new Error(`Remote config failed: HTTP ${response.status}`);
    return response.json();
  }).catch(error => {
    if (configuration === current) configuration = null;
    throw error;
  });
  return current.promise;
}

export class RemoteTerminalSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  socket = null;
  clientSeq = 0;
  eventSeq = 1;
  outputSeq = 0;
  pending = new Map();
  pendingBytes = 0;
  unacked = new Map();
  terminalId = crypto.randomUUID();

  constructor(device, { profile = false, direct = false, projectHash = null, initialOpen } = {}) {
    super();
    this.device = device;
    this.profile = profile;
    this.direct = direct;
    this.projectHash = projectHash;
    this.initialOpen = initialOpen;
    Promise.resolve().then(() => this.connect()).catch(() => this.fail('Check your network.'));
  }

  get bufferedAmount() {
    return (this.socket?.bufferedAmount || 0) + [...this.unacked.values()].reduce((sum, size) => sum + size, 0);
  }

  get initialOpenAccepted() {
    return this.socket?.initialOpenAccepted === true;
  }

  async connect() {
    const key = atob(localStorage.getItem('_ak') || '');
    if (!key || !this.device) return this.fail('Sign in on the main page and select an online device.');
    const server = (localStorage.getItem('_as') || location.origin).replace(/\/$/, '');
    const { wsUrl } = await terminalConfiguration(server, key);
    if (key !== atob(localStorage.getItem('_ak') || '')
      || server !== (localStorage.getItem('_as') || location.origin).replace(/\/$/, '')) return this.close();
    if (!wsUrl?.startsWith('wss://')) return this.fail('Server returned an invalid WSS URL.');
    const endpoint = new URL(wsUrl);
    endpoint.search = new URLSearchParams({ apiKey: key, role: 'app' });
    if (this.readyState !== WebSocket.CONNECTING) return;
    this.socket = this.direct
      ? new DirectAppSocket({ endpoint: wsUrl, key, terminalId: this.terminalId, device: this.device, projectHash: this.projectHash,
        initialOpen: this.initialOpen, controlSocket: state.SERVER === server && state.KEY === key ? state.ws : null })
      : new WebSocket(endpoint);
    this.socket.addEventListener('open', () => {
      this.readyState = WebSocket.OPEN;
      this.readyTimeout = setTimeout(() => this.fail('Remote terminal timed out. Check that Bridge is online and updated.'), 15000);
      this.dispatchEvent(new Event('open'));
    });
    this.socket.addEventListener('message', event => this.receive(event.data));
    this.socket.addEventListener('error', event => this.fail(event.data || 'Check your network.'));
    this.socket.addEventListener('close', event => {
      this.cleanup();
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent('close', { code: event.code, reason: event.reason }));
    });
  }

  send(payload) {
    if (this.readyState !== WebSocket.OPEN) return;
    const message = JSON.parse(payload);
    const clientSeq = message.type === 'open' ? 0 : ++this.clientSeq;
    const frame = JSON.stringify({
      ...message, action: this.projectHash ? 'terminal_shared' : 'terminal_poc', v: 1, device: this.device,
      terminalId: this.terminalId, clientSeq,
      ...(this.projectHash ? { projectHash: this.projectHash } : {}),
      ...(this.profile ? { profile: true } : {}),
    });
    if (new TextEncoder().encode(frame).length > 28 * 1024 || this.bufferedAmount + frame.length > 256 * 1024) {
      return this.fail('Input queue full. Session stopped; input will not be replayed.');
    }
    if (clientSeq) this.unacked.set(clientSeq, frame.length);
    this.socket.send(frame);
  }

  receive(payload) {
    try {
      if (typeof payload !== 'string' || new TextEncoder().encode(payload).length > 28 * 1024) throw new Error('Remote message too large');
      const message = JSON.parse(payload);
      if (message.action !== (this.projectHash ? 'terminal_shared' : 'terminal_poc')) return;
      if (this.projectHash && message.projectHash !== this.projectHash) return;
      if (message.terminalId !== this.terminalId || message.device !== this.device) return;
      if (message.v !== 1) throw new Error('Remote protocol version mismatch');
      if (message.type === 'ack' && message.eventSeq === 0) {
        if (!Number.isSafeInteger(message.clientSeq) || message.clientSeq < 1) throw new Error('Invalid input acknowledgment');
        return this.deliver(message);
      }
      if (message.type === 'error' && message.eventSeq === 0) return this.deliver(message);
      if (!Number.isSafeInteger(message.eventSeq) || message.eventSeq < 1) throw new Error('Invalid output sequence');
      if (message.eventSeq < this.eventSeq || this.pending.has(message.eventSeq)) return;
      this.pending.set(message.eventSeq, message);
      this.pendingBytes += JSON.stringify(message).length;
      if (message.eventSeq - this.eventSeq > 256 || this.pendingBytes > 1024 * 1024) throw new Error('Output reorder queue full');
      while (this.pending.has(this.eventSeq)) {
        const next = this.pending.get(this.eventSeq);
        this.pending.delete(this.eventSeq++);
        this.pendingBytes -= JSON.stringify(next).length;
        this.deliver(next);
      }
      if (!this.pending.size) { clearTimeout(this.gapTimeout); this.gapTimeout = null; }
      else if (!this.gapTimeout) this.gapTimeout = setTimeout(() => this.fail('Output missing. Session stopped; refresh to start a new one.'), 10000);
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
        if (Date.now() - this.lastAckAt > 30000) return this.fail('Bridge is not responding. Session stopped.');
        this.send(JSON.stringify({ type: 'heartbeat' }));
      }, 10000);
    }
    if (message.type === 'output') message = { ...message, seq: ++this.outputSeq };
    if (message.type === 'closed') return this.close();
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  cleanup() {
    clearTimeout(this.readyTimeout);
    clearTimeout(this.gapTimeout);
    clearInterval(this.heartbeat);
    this.pending.clear();
    this.unacked.clear();
  }

  fail(message) {
    if (this.readyState >= WebSocket.CLOSING) return;
    configuration = null;
    this.dispatchEvent(new MessageEvent('error', { data: message }));
    this.close();
  }

  close() {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 256 * 1024) {
      this.socket.send(JSON.stringify({
        action: this.projectHash ? 'terminal_shared' : 'terminal_poc', v: 1,
        type: this.projectHash ? 'detach' : 'close', terminalId: this.terminalId,
        device: this.device, clientSeq: ++this.clientSeq,
        ...(this.projectHash ? { projectHash: this.projectHash } : {}),
      }));
    }
    this.cleanup();
    if (this.socket) this.socket.close(1000, 'POC page closed');
    else this.readyState = WebSocket.CLOSED;
  }
}
