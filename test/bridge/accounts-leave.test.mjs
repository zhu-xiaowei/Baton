import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

test('leave keeps config.json until another account approves, then keeps the device fields', async () => {
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'leave-'));
  const { leave } = await import('../../bridge/accounts.mjs');
  const { pairCode, sealPair } = await import('../../bridge/e2ee-node.mjs');
  const dir = path.join(process.env.HOME, '.baton-bridge');
  const old = { server: 'https://s/v1', apiKey: 'bt_old', accountKey: 'a', accounts: true, deviceName: 'mac', bridgeId: 'b' };
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(old));
  const k = randomBytes(32);
  let p, revoked;
  const fetchImpl = async (url, { headers, body }) => {
    if (url.endsWith('/api/tokens/revoke')) { revoked = [headers['x-api-key'], JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).apiKey]; return { ok: true, json: async () => ({ ok: true }) }; }
    assert.equal(headers['x-api-key'], undefined);
    if (url.endsWith('/start')) return { ok: true, json: async () => ({ code: JSON.parse(body).code, poll: 'x', expiresIn: 600 }) };
    return { ok: true, json: async () => ({ token: 'bt_new', approvedBy: 'phone', sealed: sealPair(p, k, pairCode(p)) }) };
  };
  const print = (line) => { if (line.includes('#j=')) p = Buffer.from(new URLSearchParams(line.split('#')[1]).get('j'), 'base64url'); };
  await assert.rejects(leave(old, { print, fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }));
  assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  await leave(old, { print, fetchImpl, sleep: async () => {} });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
  assert.deepEqual([saved.apiKey, saved.server, saved.deviceDisplayName, saved.bridgeId], ['bt_new', old.server, 'mac', 'b']);
  assert.match(saved.deviceName, /^pc-[0-9a-f]{8}$/); // a new account knows it by a new random ID
  assert.deepEqual(revoked, ['bt_old', 'bt_new']); // the old account forgets it once the new one is saved
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.includes('.bak-'))))), old);
});
