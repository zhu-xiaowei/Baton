// One Durable Object per account: its rows (SQLite), REST through server/core, and the relay between its
// own sockets (WebSocket Hibernation API), so frames can never cross accounts (docs/v2-cloudflare-design.md).
import { DurableObject } from 'cloudflare:workers';
import { validateAlert } from '../core/notifications.mjs';
import { nowInt, randomHex } from '../core/util.mjs';
import { MAX_FRAME_BYTES, bridgesFull, leastActive, limits, refuse, server, toResponse } from './ports.mjs';
import { createCredentials, storageInfo } from './r2.mjs';
import { createItems, createTable, serve } from './store.mjs';
import { Usage } from './usage.mjs';

const SILENT_MS = 75_000; // three missed 25 s text pings
const SWEEP_MS = 60_000;
const ACTIVE_MS = 60_000; // an App's last activity is written at most this often
const encoder = new TextEncoder();
const send = (ws, data) => { try { ws.send(typeof data === 'string' ? data : JSON.stringify(data)); return true; } catch { return false; } };
const PUB = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;
// Android's notification service socket (`role=notify`) gets the sealed alerts no App acknowledged; a reconnect
// with `after=<eventId>` gets the newer of the last REPLAY_COUNT, kept REPLAY_MS.
const REPLAY_COUNT = 20;
const REPLAY_MS = 3600_000;

export class AccountObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = serve(createItems(ctx.storage.sql), (fn) => ctx.storage.transactionSync(fn));
    this.credentials = createCredentials(env, ctx.storage);
    this.swept = 0;
    this.usage = new Usage(ctx, env);
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
    if (!resolved || resolved.accountId !== account) return this.usage.refuse(account, 4401, 'unauthorized');
    if (!['app', 'bridge', 'notify'].includes(role) || (resolved.kind !== 'key' && (resolved.kind === 'bridge') !== (role === 'bridge'))
      || (resolved.kind === 'bridge' && device && device !== resolved.deviceName) || device.length > 200) return this.usage.refuse(account, 4403, 'forbidden');
    if (await this.usage.blocked()) return refuse(4429, 'monthly_limit');
    const max = limits(this.env);
    if (role === 'bridge' && bridgesFull(this.live('bridge'), device, max.bridges)) return refuse(4429, 'too_many_bridges');
    const [client, socket] = Object.values(new WebSocketPair());
    const id = randomHex(12);
    const tok = role === 'notify' && resolved.tokenHash ? [`tok:${resolved.tokenHash}`] : []; // one notify socket per App token
    this.ctx.acceptWebSocket(socket, [role, `id:${id}`, ...(role === 'bridge' && device ? [`dev:${device}`] : []), ...tok]);
    const me = { role, id, account, device, tokenHash: resolved.tokenHash ?? '', connectedAt: Date.now() };
    socket.serializeAttachment(me);
    // `hello=1`: the App's address at once, saving the round trip of asking (older Apps ask, and would count a second answer as a reconnect).
    if (role === 'app' && query.get('hello') === '1') send(socket, { action: 'whoami', connectionId: id });
    if (role !== 'notify') await this.usage.joined(request, me, () => this.store('getItem', { Key: { pk: `ACCOUNT#${account}`, sk: 'META' } })
      .result?.Item?.createdAt >= Date.parse(new Date().toISOString().slice(0, 10)) / 1000).catch((error) => console.log(`usage: ${error.message}`));
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
    if (role === 'app') {
      for (const [old] of leastActive(this.live('app').filter(([ws]) => ws !== socket), max.apps - 1)) await this.retire(old, 4429, 'too_many_apps');
    }
    for (const [old] of tok.length ? this.live(tok[0]) : []) if (old !== socket) await this.retire(old, 4409, 'replaced');
    if (role === 'notify' && query.get('after')) {
      const list = this.replay(account);
      const at = list.findIndex((entry) => entry.alert.eventId === query.get('after'));
      for (const { alert } of list.slice(at + 1)) send(socket, { action: 'alert', ...alert, accountId: account });
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
    // Any frame but the auto-answered ping is activity: the least recently active App goes first at the limit.
    if (me.role === 'app' && Date.now() - (me.activeAt ?? me.connectedAt) > ACTIVE_MS) ws.serializeAttachment({ ...me, activeAt: Date.now() });
    if (typeof message !== 'string' || me.role === 'notify') return; // a notify socket only pings
    // {"to":"<id>",…}: forwarded unchanged to that socket of this account, between an App and a Bridge.
    if (message.startsWith('{"to":"')) {
      const end = message.indexOf('"', 7);
      const id = message.slice(7, end);
      if (id === 'apps' && me.role === 'bridge') { for (const [app] of this.live('app')) send(app, message); return; } // notify_check
      const [target] = message[end + 1] === ',' ? this.live(`id:${id}`) : [];
      if (target && target[1].role !== me.role && target[1].role !== 'notify') send(target[0], message);
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
    else if (me.role === 'bridge' && action === 'alert') await this.alert(ws, me.account, body);
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

  // A Bridge's alert, checked like the REST body, pushed to the account's iOS devices and notify sockets; only sealed ones are kept (replay).
  // Acknowledged (`alert_ok`) once taken; a resend of an alert already taken is only acknowledged again.
  async alert(ws, account, { action, ...body }) {
    const alert = validateAlert(body);
    if (!alert) return;
    const seen = this.store('putItem', { Item: { pk: `ALERTED#${account}`, sk: alert.eventId, ttl: nowInt() + 86400 },
      ConditionExpression: 'attribute_not_exists(pk)' });
    send(ws, { action: 'alert_ok', eventId: alert.eventId });
    if (seen.error) return;
    const list = [...this.replay(account), ...(alert.e ? [{ at: Date.now(), alert }] : [])].slice(-REPLAY_COUNT); // sealed ones only
    this.store('putItem', { Item: { pk: `NOTIFYQ#${account}`, sk: '-', list, ttl: nowInt() + REPLAY_MS / 1000 } });
    for (const [socket] of this.live('notify')) send(socket, { action: 'alert', ...alert, accountId: account }); // a tap checks the account
    try {
      await this.core(account).notifications.deliver(account, alert);
    } catch (error) {
      console.log(`alert not delivered: ${error.message}`);
    }
  }

  replay(account) {
    const list = this.store('getItem', { Key: { pk: `NOTIFYQ#${account}`, sk: '-' } }).result?.Item?.list ?? [];
    return list.filter((entry) => Date.now() - entry.at < REPLAY_MS);
  }

  async webSocketClose(ws, code) {
    try { ws.close(1000, 'closed'); } catch {}
    await this.leave(ws, code);
  }

  async webSocketError(ws) {
    await this.leave(ws, 1006);
  }

  // The monitor Worker's cost cap, through its binding to this namespace (no route of the public Worker calls it); 0 lifts it.
  async monthlyLimit(until) {
    await this.usage.block(until);
    if (until > Date.now()) for (const role of ['app', 'bridge', 'notify']) for (const [ws] of this.live(role)) await this.retire(ws, 4429, 'monthly_limit');
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
      if (a.role === 'notify') continue; // Android may ping late while dozing; these never hold the alarm
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? a.connectedAt;
      if (now - last > SILENT_MS) await this.retire(ws, 4000, 'silent');
    }
  }

  async retire(ws, code, reason) {
    await this.leave(ws, code); // marked `closing` first: a dead socket stays listed for minutes
    try { ws.close(code, reason); } catch {}
  }

  // Once per socket (marked `closing`, which routing skips): Apps → peer_left to Bridges, joined Bridges → Apps.
  async leave(ws, code) {
    const a = ws.deserializeAttachment();
    if (!a || a.closing) return;
    a.closing = Date.now();
    try { ws.serializeAttachment(a); } catch {}
    if (a.role === 'app') {
      for (const [bridge] of this.live('bridge')) send(bridge, { action: 'peer_left', id: a.id });
      if (!this.live('app').length) await this.ctx.storage.deleteAlarm();
    } else if (a.joined) await this.notifyApps(a.account);
    if (a.role !== 'notify') await this.usage.left(a, code, this.live('app').length).catch((error) => console.log(`usage: ${error.message}`));
  }

  record(a) {
    return { connectionId: a.id, deviceName: a.device, tokenHash: a.tokenHash,
      ...(a.joined ? { rpcDataId: a.id, rpcPub: a.pub, rpcFp: a.fp } : {}) };
  }

  // Where this object runs (register checks a new account's placement).
  async colo() {
    return (await (await fetch('https://cloudflare.com/cdn-cgi/trace')).text()).match(/colo=(\w+)/)?.[1] ?? '';
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
      get: async (id) => { const ws = byId(id); return ws && this.record(ws.deserializeAttachment()); },
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
