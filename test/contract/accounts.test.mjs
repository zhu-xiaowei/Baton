import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { accountOf, openPair, openRotation, pairCode, sealPair } from '../../bridge/e2ee-node.mjs';
import { GONE, KEY, ORIGIN, api, approve, code, deleteAccount, devices, finish, joinComputer, newAccount, randomIp, rotation,
  skip, startComputer } from './client.mjs';

const appCode = async (token, k) => {
  const t = randomBytes(16), c = pairCode(t);
  assert.equal((await api('/api/pair/create', { code: c, sealed: sealPair(t, k, c) }, { token })).expiresIn, 600);
  return { c, t };
};
const recover = (joinSecret, status) => api('/api/account/recover', { joinSecret, deviceName: 'ct-recovered' }, { status });

test('two accounts pair, remove with rotation, recover and delete apart', { skip }, async () => {
  const a = await newAccount('ct-iphone'), b = await newAccount('ct-pixel');
  const exists = { detail: 'Account exists.' };
  assert.deepEqual(await api('/api/account/register', { ...accountOf(a.k), deviceName: 'ct-x' }, { status: 409 }), exists);
  const selfId = (await devices(KEY)).notifications.accountId;
  const squat = { accountId: selfId, joinSecret: code(), fp: '0'.repeat(16), deviceName: 'ct-squatter' };
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

  // Removing a computer replaces K in the same request.
  assert.deepEqual(await api('/api/bridge/delete-device', { deviceName: 'ct-mac' }, { token: a.token, status: 400 }),
    { detail: 'Removing a device needs a new account key.' });
  const r1 = await rotation(a.k);
  assert.deepEqual(await api('/api/bridge/delete-device', { deviceName: 'ct-mac', rotation: r1.body }, { token: a.token }), { ok: true });
  await devices(mac.token, 401);
  assert.deepEqual(await recover(a.joinSecret, 403), { detail: 'Recovery phrase does not match an account.' });
  const listed = await devices(a.token);
  assert.equal(listed.hosted, true);
  assert.deepEqual(listed.rotations, [{ fp: a.fp, sealed: r1.body.sealed }]);
  assert.deepEqual(openRotation(a.k, listed.rotations[0].sealed, a.fp), r1.next);
  assert.deepEqual((await devices(b.token)).rotations, []);

  // A lost App: a rotation from the replaced K is refused (no fork); one from the current K removes it.
  const phone = await recover(accountOf(r1.next).joinSecret);
  assert.equal(phone.accountId, a.accountId);
  const lost = (await devices(a.token)).apps.find((app) => app.deviceName === 'ct-recovered').id;
  const stale = (await rotation(a.k)).body; // a fresh K' sealed under the replaced K
  assert.deepEqual(await api('/api/tokens/revoke', { id: lost, rotation: stale }, { token: a.token, status: 409 }),
    { detail: 'The account key changed meanwhile; try again.' });
  const r2 = await rotation(r1.next);
  await api('/api/tokens/revoke', { id: lost, rotation: r2.body }, { token: a.token });
  await devices(phone.token, 401);

  // Deleting A leaves B alone.
  assert.deepEqual(await deleteAccount(a.token), { ok: true });
  for (const token of [a.token, pc.token, twin.token]) await devices(token, 401);
  await recover(accountOf(r2.next).joinSecret, 403);
  assert.equal((await devices(b.token)).apps[0].deviceName, 'ct-pixel');
  await deleteAccount(b.token);
});

// Each limit needs requests from one chosen address: only possible posing as CloudFront.
test('limits per caller and per account', { skip: skip || (!ORIGIN && 'BATON_ORIGIN_SECRET is unset') }, async () => {
  const ip = randomIp(), made = [];
  for (let n = 0; n < 5; n++) made.push(await newAccount('ct-limit', { ip }));
  assert.deepEqual(await api('/api/account/register', { ...accountOf(randomBytes(32)), deviceName: 'ct-limit' }, { ip, status: 429 }),
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
