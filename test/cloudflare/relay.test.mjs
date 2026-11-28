// The relay of a Cloudflare deployment, by URL like test/contract (BATON_URL, BATON_WS; BATON_ORIGIN_SECRET if limits apply).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';
import { KEY, WS, api, deleteAccount, devices, joinComputer, newAccount, skip } from '../contract/client.mjs';

const off = skip || (!WS && 'BATON_WS is unset');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A socket that records frames and its close code; `ping` sends the 25 s text ping.
function open(apiKey, role, { device, ping = true } = {}) {
  const ws = new WebSocket(`${WS}?${new URLSearchParams({ apiKey, role, ...(device && { device }) })}`);
  const s = { ws, frames: [], closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))) };
  ws.on('message', (data) => s.frames.push(JSON.parse(data)));
  const timer = ping && setInterval(() => ws.readyState === 1 && ws.send('{"action":"realtime_ping"}'), 25_000);
  ws.on('close', () => clearInterval(timer));
  s.send = (frame) => ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
  s.next = async (match, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      const i = s.frames.findIndex(match);
      if (i >= 0) return s.frames.splice(i, 1)[0];
    }
    return null;
  };
  s.ready = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  s.ready.catch(() => {}); // a socket closed while connecting
  s.id = async () => { await s.ready; s.send({ action: 'whoami' }); return (await s.next((f) => f.action === 'whoami')).connectionId; };
  return s;
}
const closeAll = (...sockets) => sockets.forEach((s) => s.ws.terminate());

async function account(name) {
  const app = await newAccount(`ct-${name}`);
  const computer = await joinComputer(app.token, app.k, `ct-${name}-pc`);
  return { ...app, computer, bridge: () => open(computer.token, 'bridge', { device: `ct-${name}-pc` }) };
}

test('frames stay inside an account; join and credentials', { skip: off }, async () => {
  const a = await account('iso-a'), b = await account('iso-b');
  const [bridgeA, appA, appB] = [a.bridge(), open(a.token, 'app'), open(b.token, 'app')];
  const [idA, idB, idBridge] = [await appA.id(), await appB.id(), await bridgeA.id()];
  bridgeA.send({ action: 'direct_rpc', op: 'credentials' });
  const creds = await bridgeA.next((f) => f.type === 'credentials');
  assert.equal(creds.transport, 'relay');
  assert.equal(creds.maxFrameBytes, 1048576);
  assert.ok(creds.credentials?.sessionToken && creds.storage.endpoint.endsWith('.r2.cloudflarestorage.com'));
  bridgeA.send({ action: 'direct_rpc', op: 'bridge_join', pub: 'A'.repeat(88), fp: '0'.repeat(16) });
  assert.equal((await bridgeA.next((f) => f.type === 'joined')).id, idBridge);
  assert.equal((await appA.next((f) => f.type === 'bridges')).rpc.bridges[0].dataId, idBridge);
  assert.deepEqual((await devices(a.token)).rpc.bridges.map((x) => x.dataId), [idBridge]);
  for (const to of [idB, idBridge, idB.toUpperCase(), `${idB} `]) bridgeA.send(`{"to":"${to}","n":1}`);
  const head = `{"to":"${idA}","n":2,"big":"`;
  bridgeA.send(`${head}${'x'.repeat(1048576 - head.length - 2)}"}`); // exactly the limit
  assert.equal((await appA.next((f) => f.n === 2, 10_000))?.to, idA);
  appB.send(`{"to":"${idBridge}","n":3}`);
  await sleep(1500);
  assert.deepEqual([appB.frames, bridgeA.frames.filter((f) => f.n)], [[], []]);
  closeAll(bridgeA, appA, appB);
  await deleteAccount(a.token);
  await deleteAccount(b.token);
});

test('refused after the upgrade: 4401 / 4403 (role cases: contract suite); revocation closes with 4401', { skip: off }, async () => {
  const a = await account('auth');
  const status = (key, role, device) => new Promise((resolve) => {
    const ws = new WebSocket(`${WS}?${new URLSearchParams({ apiKey: key, role, ...(device && { device }) })}`);
    ws.on('unexpected-response', (_r, res) => { resolve(res.statusCode); res.destroy(); });
    ws.on('close', resolve);
    ws.on('error', () => {});
  });
  assert.equal(await status('bt_0123456789abcdef_short', 'app'), 401);
  assert.equal(await status(`${KEY}x`, 'app'), 4401);
  assert.equal(await status(`bt_${a.accountId}_${randomBytes(32).toString('base64url')}`, 'app'), 4401);
  assert.equal(await status(a.computer.token, 'bridge', 'ct-other-pc'), 4403);
  const bridge = a.bridge();
  await bridge.id();
  await api('/api/tokens/revoke', {}, { token: a.computer.token });
  assert.equal(await bridge.closed, 4401);
  await deleteAccount(a.token);
});

test('a frame over 1 MiB closes the socket with 1009', { skip: off }, async () => {
  const app = open(KEY, 'app');
  await app.ready;
  app.send(`{"action":"x","pad":"${'x'.repeat(1048576)}"}`);
  assert.equal(await app.closed, 1009);
});

test('alerts are pushed, never stored', { skip: off }, async () => {
  const a = await account('alert');
  await api('/api/notifications/devices', { token: randomBytes(32).toString('hex'), environment: 'development' }, { token: a.token });
  const bridge = a.bridge();
  await bridge.ready;
  const alert = { action: 'alert', eventId: randomBytes(32).toString('hex'), device: 'ct-alert-pc', sessionId: 's', rootSessionId: 's',
    title: 'ct', body: 'ct body', e: randomBytes(600).toString('base64') };
  for (let i = 0; i < 2; i++) { // a resend is acknowledged again
    bridge.send(alert);
    assert.ok(await bridge.next((f) => f.action === 'alert_ok' && f.eventId === alert.eventId));
  }
  assert.equal((await devices(a.token)).notifications.feed, false);
  await api('/api/notifications/events', undefined, { token: a.token, status: 404 });
  closeAll(bridge);
  await deleteAccount(a.token);
});

test('notify_check reaches every App; alerts reach notify sockets', { skip: off }, async () => {
  const a = await account('notify');
  const [bridge, app, notify] = [a.bridge(), open(a.token, 'app'), open(a.token, 'notify')];
  await Promise.all([bridge.ready, app.ready, notify.ready]);
  bridge.send('{"to":"apps","kind":"notify","n":1}');
  assert.equal((await app.next((f) => f.kind === 'notify'))?.n, 1);
  const alert = (n) => ({ action: 'alert', eventId: String(n).repeat(64), device: 'ct-notify-pc', sessionId: 's', rootSessionId: 's', e: 'x' });
  for (const n of [1, 2, 3]) { bridge.send(alert(n)); await bridge.next((f) => f.action === 'alert_ok'); }
  await sleep(500);
  assert.deepEqual([notify.frames.map((f) => f.eventId[0]), app.frames.filter((f) => f.action === 'alert')], [['1', '2', '3'], []]);
  closeAll(bridge, app, notify);
  await deleteAccount(a.token);
});

test('a silent App is swept at the next frame after 75 s and its Bridges get peer_left', { skip: off, timeout: 200_000 }, async () => {
  const a = await account('sweep');
  const bridge = a.bridge();
  const app = open(a.token, 'app', { ping: false });
  const [id, start] = [await app.id(), Date.now()];
  await bridge.ready;
  await sleep(80_000);
  bridge.send('{"action":"heartbeat"}');
  assert.ok(await bridge.next((f) => f.action === 'peer_left' && f.id === id));
  assert.equal(await app.closed, 4000);
  console.log(`swept after ${Math.round((Date.now() - start) / 1000)} s`);
  closeAll(bridge);
  await deleteAccount(a.token);
});
