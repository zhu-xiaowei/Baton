import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { accountOf, openPair, openRecovery, pairCode, recoveryOf, sealPair } from '../../bridge/e2ee-node.mjs';
import { GONE, KEY, ORIGIN, api, approve, code, deleteAccount, devices, finish, joinComputer, newAccount, randomIp,
  skip, startComputer } from './client.mjs';

const appCode = async (token, k) => {
  const t = randomBytes(16), c = pairCode(t);
  assert.equal((await api('/api/pair/create', { code: c, sealed: sealPair(t, k, c) }, { token })).expiresIn, 900);
  return { c, t };
};
const recover = (joinSecret, status) => api('/api/account/recover', { joinSecret, deviceName: 'ct-recovered' }, { status });

test('two accounts pair, remove devices, recover and delete apart', { skip }, async () => {
  const a = await newAccount('ct-iphone'), b = await newAccount('ct-pixel');
  const exists = { detail: 'Account exists.' };
  assert.deepEqual(await api('/api/account/register', { ...accountOf(a.k), ...recoveryOf(randomBytes(32), a.k), deviceName: 'ct-x' }, { status: 409 }), exists);
  const selfId = (await devices(KEY)).notifications.accountId;
  const squat = { accountId: selfId, ...recoveryOf(randomBytes(32), randomBytes(32)), fp: '0'.repeat(16), deviceName: 'ct-squatter' };
  assert.deepEqual(await api('/api/account/register', squat, { status: 409 }), exists);

  // An App code works once and only for its account.
  const { c, t } = await appCode(a.token, a.k);
  assert.deepEqual(await api('/api/pair/create', { code: c, sealed: sealPair(t, b.k, c) }, { token: b.token, status: 409 }), { detail: 'Code in use.' });
  const ipad = await api('/api/pair/claim', { code: c, deviceName: 'ct-ipad' });
  assert.equal(ipad.accountId, a.accountId);
  assert.equal(ipad.head, a.fp);
  assert.deepEqual(openPair(t, ipad.sealed, c), a.k);
  assert.deepEqual(await api('/api/pair/claim', { code: c, deviceName: 'ct-ipad' }, { status: 404 }), { detail: GONE });

  // A computer: a wrong poll, a second approver, a reused name all fail; the token comes once.
  const start = await startComputer('ct-mac');
  await api('/api/pair/start', { deviceName: 'ct-mac', code: start.code }, { status: 409 });
  await api('/api/pair/wait', { code: start.code, poll: code() }, { status: 404 });
  assert.deepEqual(await api('/api/pair/wait', { code: start.code, poll: start.poll }), { pending: true });
  assert.deepEqual(await approve(a.token, a.k, start), { deviceName: 'ct-mac' });
  assert.deepEqual(await approve(b.token, b.k, start, 404), { detail: GONE });
  const mac = await finish(start);
  assert.equal(mac.accountId, a.accountId);
  assert.equal(mac.approvedBy, 'ct-iphone');
  assert.equal(mac.head, a.fp);
  assert.deepEqual(mac.k, a.k);
  assert.match(mac.token, /^bt_/);
  await finish(start, 404);
  assert.deepEqual(await approve(a.token, a.k, await startComputer('ct-mac'), 409),
    { detail: 'A computer named ct-mac is already in this account; reinstall with another name.' });
  const pc = await joinComputer(mac.token, a.k, 'ct-pc'); // a computer approves another one
  assert.equal(pc.approvedBy, 'ct-mac');

  // The same App install joining twice keeps one entry.
  const install = `ct-${code()}`;
  let twin;
  for (let i = 0; i < 2; i++) {
    const { c: twinCode } = await appCode(a.token, a.k);
    twin = await api('/api/pair/claim', { code: twinCode, deviceName: 'ct-mini', install });
  }
  const apps = (await devices(twin.token)).apps;
  assert.equal(apps.filter((app) => app.deviceName === 'ct-mini').length, 1);
  assert.deepEqual(new Set(apps.map((app) => app.kind)), new Set(['app', 'bridge']));
  assert.deepEqual((await devices(b.token)).apps.map((app) => app.deviceName), ['ct-pixel']);

  // Logout; a code made by a device that left is void.
  const { c: voidCode } = await appCode(ipad.token, a.k);
  assert.deepEqual(await api('/api/tokens/revoke', {}, { token: ipad.token }), { ok: true });
  await api('/api/pair/claim', { code: voidCode, deviceName: 'ct-thief' }, { status: 404 });
  assert.deepEqual(await devices(ipad.token, 401), { error: 'unauthorized' });

  // Removing a computer keeps K and voids the recovery phrase; the first computer to send a new one sets it.
  assert.deepEqual(await api('/api/bridge/delete-device', { deviceName: 'ct-mac' }, { token: a.token }), { ok: true });
  await devices(mac.token, 401);
  assert.deepEqual(await recover(a.joinSecret, 403), { detail: 'Recovery phrase does not match an account.' });
  assert.deepEqual([(await devices(a.token)).hosted, (await devices(a.token)).phraseSealed], [true, '']);
  const r1 = randomBytes(32), next = recoveryOf(r1, a.k);
  await api('/api/account/recovery', next, { token: a.token, status: 403 });
  assert.deepEqual(await api('/api/account/recovery', next, { token: pc.token }), { ok: true });
  assert.deepEqual(await api('/api/account/recovery', recoveryOf(randomBytes(32), a.k), { token: pc.token }), { ok: false });
  assert.equal((await devices(a.token)).phraseSealed, next.phraseSealed);

  // A lost App, recovered with the new phrase (K opens from it), and another App leave in one request.
  const phone = await recover(next.joinSecret);
  assert.deepEqual([phone.accountId, openRecovery(r1, phone.keySealed, a.accountId)], [a.accountId, a.k]);
  const ids = (await devices(a.token)).apps.filter((app) => ['ct-recovered', 'ct-mini'].includes(app.deviceName)).map((app) => app.id);
  await api('/api/tokens/revoke', { ids: ids.join(',') }, { token: a.token });
  for (const token of [phone.token, twin.token]) await devices(token, 401);
  await recover(next.joinSecret, 403);

  // Deleting A leaves B alone.
  assert.deepEqual(await deleteAccount(a.token), { ok: true });
  for (const token of [a.token, pc.token, twin.token]) await devices(token, 401);
  assert.equal((await devices(b.token)).apps[0].deviceName, 'ct-pixel');
  await deleteAccount(b.token);
});

// Each limit needs requests from one chosen address: only possible posing as CloudFront.
test('limits per caller and per account', { skip: skip || (!ORIGIN && 'BATON_ORIGIN_SECRET is unset') }, async () => {
  const ip = randomIp(), made = [];
  for (let n = 0; n < 5; n++) made.push(await newAccount('ct-limit', { ip }));
  const k = randomBytes(32);
  assert.deepEqual(await api('/api/account/register', { ...accountOf(k), ...recoveryOf(randomBytes(32), k), deviceName: 'ct-limit' }, { ip, status: 429 }),
    { detail: 'Too many requests, try again later.' });
  for (let n = 0; n < 6; n++) await api('/api/account/recover', { joinSecret: code(), deviceName: 'ct-r' }, { ip, status: n < 5 ? 403 : 429 });
  for (let n = 0; n < 6; n++) await api('/api/account/recover', { joinSecret: made[0].joinSecret, deviceName: 'ct-r' }, { status: n < 5 ? 200 : 429 });
  for (let n = 0; n < 11; n++) await api('/api/pair/start', { deviceName: 'ct-s' }, { ip, status: n < 10 ? 200 : 429 });

  const owner = made[0];
  for (let n = 0; n < 9; n++) await joinComputer(owner.token, owner.k, `ct-c${n}`);
  const last = [await startComputer('ct-c9'), await startComputer('ct-c10')]; // both approved before either joins
  for (const start of last) await approve(owner.token, owner.k, start);
  await finish(last[0]);
  const full = { detail: 'This account already has 10 computers.' };
  assert.deepEqual(await finish(last[1], 409), full);
  assert.deepEqual(await approve(owner.token, owner.k, await startComputer('ct-c11'), 409), full);
  for (const account of made) await deleteAccount(account.token);
});
