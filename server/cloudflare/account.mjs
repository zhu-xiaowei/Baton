// One Durable Object per account: its rows (SQLite), REST through server/core, and the relay between its
// own sockets (WebSocket Hibernation API), so frames can never cross accounts (docs/v2-cloudflare-design.md).
import { DurableObject } from 'cloudflare:workers';
import { validateAlert } from '../core/notifications.mjs';
import { nowInt, randomHex } from '../core/py.mjs';
import { MAX_FRAME_BYTES, refuse, server, toResponse } from './ports.mjs';
import { createCredentials, storageInfo } from './r2.mjs';
import { createItems, createTable, serve } from './store.mjs';

const SILENT_MS = 75_000; // three missed 25 s text pings
const SWEEP_MS = 60_000;
const encoder = new TextEncoder();
const send = (ws, data) => { try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); return true; } catch { return false; } };
const PUB = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;

export class AccountObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = serve(createItems(ctx.storage.sql), (fn) => ctx.storage.transactionSync(fn));
    this.credentials = createCredentials(env, ctx.storage);
    this.swept = 0;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"action":"realtime_ping"}', '{"action":"realtime_pong"}'));
  }

  op(name, params) {
    return this.store(name, params);
  }

  core(account) {
    if (this.server?.account === account) return this.server;
    const table = createTable(this.env, { kind: 'account', name: account, call: this.store });
    this.server = server(this.env, { table, sockets: this.socketsPort(), rpcInfo: (_, bridges) => this.rpcInfo(account, bridges) });
    this.server.account = account;
    return this.server;
  }

  async fetch(request) {
    const account = request.headers.get('x-baton-account');
    await this.sweep();
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.connect(request, account);
    const out = await this.core(account).handle(request, { path: new URL(request.url).pathname,
      clientIp: request.headers.get('cf-connecting-ip') ?? '', scheme: 'https' });
    return toResponse(out, request.method);
  }

  // ---- Sockets ----

  live(tag) {
    return this.ctx.getWebSockets(tag).map((ws) => [ws, ws.deserializeAttachment()]).filter(([, a]) => a && !a.closing);
  }

  // The same rules as the AWS $connect (server/aws/ws-handler.mjs), answered by close codes.
  async connect(request, account) {
    const query = new URL(request.url).searchParams;
    const role = query.get('role') ?? 'app';
    const device = query.get('device') ?? '';
    const core = this.core(account);
    const resolved = await core.auth.resolve(query.get('apiKey') ?? '');
    if (!resolved || resolved.accountId !== account) return refuse(4401, 'unauthorized');
    if (!['app', 'bridge'].includes(role) || (resolved.kind !== 'key' && (resolved.kind === 'bridge') !== (role === 'bridge'))
      || (resolved.kind === 'bridge' && device && device !== resolved.deviceName) || device.length > 200) return refuse(4403, 'forbidden');
    const [client, socket] = Object.values(new WebSocketPair());
    const id = randomHex(12);
    this.ctx.acceptWebSocket(socket, [role, `id:${id}`, ...(role === 'bridge' && device ? [`dev:${device}`] : [])]);
    socket.serializeAttachment({ role, id, account, device, tokenHash: resolved.tokenHash ?? '', connectedAt: Date.now() });
    if (role === 'bridge' && device) {
      for (const [old] of this.live(`dev:${device}`)) {
        if (old === socket) continue;
        send(old, { action: 'bridge_replaced' });
        await this.retire(old, 1000, 'replaced');
      }
      try { // display only
        await core.devices.put(account, device, query.get('name') ?? '', query.get('os') ?? '');
      } catch (error) {
        console.log(`device row not written: ${error.message}`);
      }
    }
    if (role === 'app' && await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.sweep();
    const me = ws.deserializeAttachment();
    if (!me || me.closing) return;
    const size = typeof message === 'string' ? (message.length * 3 <= MAX_FRAME_BYTES ? 0 : encoder.encode(message).length) : message.byteLength;
    if (size > MAX_FRAME_BYTES) return this.retire(ws, 1009, 'frame too large');
    if (typeof message !== 'string') return;
    // {"to":"<id>",…}: forwarded unchanged to that socket of this account, between an App and a Bridge.
    if (message.startsWith('{"to":"')) {
      const end = message.indexOf('"', 7);
      const [target] = message[end + 1] === ',' ? this.live(`id:${message.slice(7, end)}`) : [];
      if (target && target[1].role !== me.role) send(target[0], message);
      return;
    }
    let body;
    try {
      body = JSON.parse(message);
    } catch {
      return;
    }
    const action = body?.action;
    if (action === 'whoami') send(ws, { action: 'whoami', connectionId: me.id });
    else if (action === 'heartbeat') {
      send(ws, { action: 'heartbeat', ts: nowInt(),
        ...(me.role === 'bridge' ? { bridgeVersion: this.env.BRIDGE_VERSION ?? this.env.APP_VERSION ?? 'dev' } : {}) });
    } else if (me.role === 'bridge' && action === 'direct_rpc') await this.directRpc(ws, me, body);
    else if (me.role === 'bridge' && action === 'alert') await this.alert(me.account, body);
  }

  async directRpc(ws, me, body) {
    if (body.op === 'credentials') {
      send(ws, { action: 'direct_rpc', type: 'credentials', transport: 'relay', maxFrameBytes: MAX_FRAME_BYTES,
        credentials: await this.credentials(me.account).catch(() => null), storage: storageInfo(this.env, me.account) });
    } else if (body.op === 'bridge_join') {
      const valid = typeof body.pub === 'string' && PUB.test(body.pub) && typeof body.fp === 'string' && /^[0-9a-f]{16}$/.test(body.fp);
      ws.serializeAttachment({ ...me, joined: true, pub: valid ? body.pub : '', fp: valid ? body.fp : '' });
      send(ws, { action: 'direct_rpc', type: 'joined', id: me.id });
      await this.notifyApps(me.account);
    }
  }

  // A Bridge's alert, checked like the REST body, pushed to the account's iOS devices; nothing is stored.
  async alert(account, { action, ...body }) {
    const alert = validateAlert(body);
    if (!alert) return;
    try {
      await this.core(account).notifications.deliver(account, alert);
    } catch (error) {
      console.log(`alert not delivered: ${error.message}`);
    }
  }

  async webSocketClose(ws) {
    try { ws.close(1000, 'closed'); } catch {}
    await this.leave(ws);
  }

  async webSocketError(ws) {
    await this.leave(ws);
  }

  async alarm() {
    this.swept = 0;
    await this.sweep();
    if (this.live('app').length) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  // Dead sockets stay OPEN for minutes: one silent past SILENT_MS (no auto-answered ping) is closed.
  async sweep() {
    const now = Date.now();
    if (now - this.swept < 10_000) return;
    this.swept = now;
    for (const [ws, a] of this.live()) {
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? a.connectedAt;
      if (now - last > SILENT_MS) await this.retire(ws, 4000, 'silent');
    }
  }

  async retire(ws, code, reason) {
    await this.leave(ws); // marked `closing` first: a dead socket stays listed for minutes
    try { ws.close(code, reason); } catch {}
  }

  // Once per socket (marked `closing`, which routing skips): Apps → peer_left to Bridges, joined Bridges → Apps.
  async leave(ws) {
    const a = ws.deserializeAttachment();
    if (!a || a.closing) return;
    a.closing = Date.now();
    try { ws.serializeAttachment(a); } catch {}
    if (a.role === 'app') {
      for (const [bridge] of this.live('bridge')) send(bridge, { action: 'peer_left', id: a.id });
      if (!this.live('app').length) await this.ctx.storage.deleteAlarm();
    } else if (a.joined) await this.notifyApps(a.account);
  }

  record(a) {
    return { connectionId: a.id, deviceName: a.device, tokenHash: a.tokenHash,
      ...(a.joined ? { rpcDataId: a.id, rpcPub: a.pub, rpcFp: a.fp } : {}) };
  }

  async rpcInfo(account, bridges) {
    return { transport: 'relay', url: `${this.env.API_URL.replace('https://', 'wss://')}/ws`, maxFrameBytes: MAX_FRAME_BYTES,
      bridges: bridges.filter((b) => b.rpcDataId).map((b) => ({ device: b.deviceName ?? '', dataId: b.rpcDataId,
        ...(b.rpcPub ? { pub: b.rpcPub } : {}), ...(b.rpcFp ? { fp: b.rpcFp } : {}) })),
      credentials: await this.credentials(account).catch((error) => { console.log(error.message); return null; }),
      storage: storageInfo(this.env, account) };
  }

  async notifyApps(account) {
    const apps = this.live('app');
    if (!apps.length) return;
    const message = JSON.stringify({ action: 'direct_rpc', type: 'bridges',
      rpc: await this.rpcInfo(account, this.live('bridge').map(([, a]) => this.record(a))) });
    for (const [app] of apps) send(app, message);
  }

  // The sockets port for core running in the Worker (public routes that replace a token).
  sockets(method, args) {
    return this.socketsPort()[method](...args);
  }

  // core's sockets port (server/aws/sockets.mjs); closing for a revoked credential is 4401, which stops reconnects.
  socketsPort() {
    const byId = (id) => this.live(`id:${id}`)[0]?.[0];
    return {
      query: async (_, role, device = '') => this.live(role).filter(([, a]) => !device || a.device === device).map(([, a]) => this.record(a)),
      post: async (_, id, data) => { const ws = byId(id); return !!ws && send(ws, data); },
      deleteConnection: async (_, id) => { const ws = byId(id); if (ws) await this.retire(ws, 4401, 'revoked'); },
      handleDisconnect: async () => ({ statusCode: 200 }),
      disconnectRemovedBridge: async (_, __, device) => {
        for (const [ws, a] of this.live('bridge')) {
          if (a.device !== device) continue;
          send(ws, { action: 'device_removed' });
          await this.retire(ws, 4401, 'removed');
        }
      },
    };
  }
}

// Pairing codes, recovery index, token index, start tokens and rate counters; 16 shards by key.
export class IndexObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = serve(createItems(ctx.storage.sql), (fn) => ctx.storage.transactionSync(fn));
  }

  op(name, params) {
    return this.store(name, params);
  }
}
