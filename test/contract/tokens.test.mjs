import assert from 'node:assert/strict';
import { test } from 'node:test';
import WebSocket from 'ws';
import { KEY, WS, api, deleteAccount, headers, joinComputer, newAccount, skip } from './client.mjs';

// Resolves with the HTTP status of the WebSocket upgrade (101 once a heartbeat is answered), closing the socket.
// Cloudflare accepts first and closes with 4401/4403, read as 401/403.
const connect = (apiKey, role) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${WS}?${new URLSearchParams({ apiKey, role })}`);
  socket.on('open', () => socket.send(JSON.stringify({ action: 'heartbeat' })));
  socket.on('message', () => { socket.close(); resolve(101); });
  socket.on('close', (code) => resolve({ 4401: 401, 4403: 403 }[code] ?? code));
  socket.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.destroy(); });
  socket.on('error', reject);
});

const open = (apiKey, query) => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${WS}?${new URLSearchParams({ apiKey, ...query })}`);
  const frames = [];
  socket.on('message', (data) => frames.push(JSON.parse(data)));
  socket.on('open', () => resolve(Object.assign(socket, { frames })));
  socket.on('error', reject);
});

test('credential kinds', { skip }, async () => {
  const app = await newAccount('ct-kinds');
  assert.deepEqual(await api('/api/auth/start-token', {}, { token: app.token, status: 403 }), { error: 'forbidden' });
  await api('/api/install', undefined, { token: app.token, status: 403 });
  assert.deepEqual(await api('/api/bridge/devices', undefined, { status: 401 }), { error: 'unauthorized' });
  await api('/api/bridge/devices', undefined, { token: 'bt_not-a-token', status: 401 });
  const computer = await joinComputer(app.token, app.k, 'ct-kinds-pc');
  assert.ok((await api('/api/install', undefined, { token: computer.token })).includes(`BATON_API_KEY='${computer.token}'`));
  await api('/api/auth/start-token', {}, { token: computer.token, status: 403 });
  if (WS) {
    assert.equal(await connect(app.token, 'bridge'), 403);
    assert.equal(await connect(computer.token, 'app'), 403);
    assert.equal(await connect(app.token, 'app'), 101);
    assert.equal(await connect(`${KEY}x`, 'app'), 401);
    assert.equal(await connect(KEY, 'app'), 101);
    // One socket per computer: a newer Bridge connection replaces the older one.
    const bridge = { role: 'bridge', device: 'ct-kinds-pc' };
    const first = await open(computer.token, bridge);
    const closed = new Promise((resolve) => first.on('close', resolve));
    const second = await open(computer.token, bridge);
    await closed;
    assert.deepEqual(first.frames, [{ action: 'bridge_replaced' }]);
    second.close();
  }
  await deleteAccount(app.token);
});

// Expiry and API-key rotation cannot be reached by URL.
test('start tokens are reusable sign-in and install credentials', { skip: skip || (!KEY && 'BATON_KEY is unset') }, async () => {
  const issued = await api('/api/auth/start-token', {}, { token: KEY });
  assert.equal(issued.expiresIn, 900);
  assert.match(issued.token, /^[0-9a-f]{32}$/);
  for (let i = 0; i < 2; i++) assert.deepEqual(await api('/auth/exchange-token', { token: issued.token }), { apiKey: KEY });
  assert.deepEqual(await api('/auth/exchange-token', { token: 'f'.repeat(32) }, { status: 401 }), { error: 'invalid or expired' });
  const script = await api(`/auth/install?t=${issued.token}`);
  assert.equal(headers.get('cache-control'), 'no-store');
  assert.ok(script.startsWith('#!/bin/bash') && script.includes(`BATON_API_KEY='${KEY}'`));
  assert.ok((await api(`/auth/install?t=${issued.token}&platform=windows`)).includes(`apiKey = '${KEY}'`));
  assert.equal(await api('/auth/install?t=nope', undefined, { status: 403 }),
    "echo 'Install command expired. Copy a new one from Baton Setup.' >&2\nexit 1\n");
});
