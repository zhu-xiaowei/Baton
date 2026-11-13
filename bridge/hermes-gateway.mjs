// A client of the user's Hermes gateway (protocol hermes-gateway-v1): one WebSocket, JSON-RPC requests
// and event fan-out. Attach tickets are single-use, so each connection asks the gateway's control
// socket (same-user peer) for a fresh one; tickets are never logged or kept.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import WebSocket from 'ws';
import { HERMES_HOME } from './hermes-catalog.mjs';
import { findRuntimeBin } from './runtime-bin.mjs';

const PROTOCOL = 'hermes-gateway-v1';
const TICKET_PREFIX = 'hermes-gateway-ticket.';
let hermesBin;

function controlSocket() {
  const direct = path.join(HERMES_HOME, 'gateway.sock');
  if (fs.existsSync(direct)) return direct;
  try { return fs.readFileSync(path.join(HERMES_HOME, 'gateway.sock.path'), 'utf8').trim() || null; } catch { return null; }
}

function controlQuery(request) {
  return new Promise((resolve, reject) => {
    const file = controlSocket();
    if (!file) return reject(new Error('Hermes gateway is not running'));
    const socket = net.createConnection(file);
    let data = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Hermes control socket timed out')));
    socket.on('connect', () => socket.write(`${JSON.stringify({ protocol: 1, id: 1, ...request })}\n`));
    socket.on('data', (chunk) => {
      data += chunk;
      if (!data.includes('\n')) return;
      socket.end();
      try {
        const reply = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (reply.ok === true) resolve(reply.result);
        else reject(new Error(`Hermes gateway refused: ${reply.error || 'invalid reply'}`));
      } catch (error) { reject(error); }
    });
    socket.on('error', reject);
  });
}

async function nativeTarget() {
  const identity = await controlQuery({ verb: 'identify' });
  const profileId = identity.served_profiles?.find((p) => p.home === HERMES_HOME)?.profile_id || identity.hermes_home;
  const grant = await controlQuery({ verb: 'session-ticket', params: { profile_id: profileId, instance_id: identity.instance_id, purpose: 'interactive' } });
  const origin = identity.api_origin || identity.endpoint?.api_origin;
  return { url: `${origin.replace(/^http/, 'ws')}/api/ws`, protocols: [PROTOCOL, TICKET_PREFIX + grant.ticket] };
}

// The hermes CLI, located on first use (its `--version` takes ~0.2 s).
export function hermesCli(args, timeout = 30_000) {
  hermesBin ||= findRuntimeBin('hermes', [path.join(HERMES_HOME, 'hermes-agent/.hermes/bin')])?.bin;
  if (!hermesBin) return Promise.reject(new Error('Hermes CLI not found'));
  return new Promise((resolve) => execFile(hermesBin, args, { timeout }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}

// Starts the gateway once (it exits by itself when idle); repeated starts make Hermes back off.
async function startTarget() {
  const { error, stdout } = await hermesCli(['gateway', 'attach', '--json', '--start'], 90_000);
  try { const { url, protocols } = JSON.parse(stdout); if (url) return { url, protocols }; } catch {}
  throw new Error(`Hermes gateway could not start${error?.code != null ? ` (exit ${error.code})` : ''}`);
}


export class HermesGateway {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.ws = null;
    this.connecting = null;
    this.nextId = 0;
    this.pending = new Map();
  }

  get open() { return this.ws?.readyState === WebSocket.OPEN; }

  // `start`: run the gateway when it is not running (sending); browsing never starts it.
  connect({ start = false } = {}) {
    if (this.open) return Promise.resolve();
    this.connecting ||= (async () => {
      const target = await nativeTarget().catch((error) => (start ? startTarget() : Promise.reject(error)));
      const ws = new WebSocket(target.url, target.protocols);
      const ready = new Promise((resolve, reject) => {
        ws.once('error', reject);
        ws.once('close', () => reject(new Error('Hermes gateway closed the connection')));
        ws.on('message', (raw) => {
          const message = JSON.parse(raw);
          if (message.params?.type === 'gateway.ready') resolve();
          this.onFrame(message);
        });
      });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        for (const { reject } of this.pending.values()) reject(new Error('Hermes gateway disconnected'));
        this.pending.clear();
        this.onEvent({ type: 'gateway.closed' });
      });
      ws.on('error', () => {});
      this.ws = ws;
      await ready;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  onFrame(message) {
    const call = message.id != null && !message.method && this.pending.get(message.id);
    if (call) {
      this.pending.delete(message.id);
      if (message.error) call.reject(Object.assign(new Error(message.error.message || 'Hermes request failed'), { code: message.error.code }));
      else call.resolve(message.result);
    } else if (message.method === 'event' && message.params) this.onEvent(message.params);
  }

  rpc(method, params = {}, timeout = 60_000) {
    if (!this.open) return Promise.reject(new Error('Hermes gateway is not connected'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Hermes ${method} timed out`)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close() { this.ws?.close(); }
}
