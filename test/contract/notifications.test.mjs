import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { KEY, api, deleteAccount, devices, newAccount, skip } from './client.mjs';

// Push devices live in an account that never posts an alert: alerts there would reach the shared APNs relay.
test('push devices register, validate and remove', { skip }, async () => {
  const phone = await newAccount('ct-push');
  const device = { token: randomBytes(32).toString('hex'), environment: 'development' };
  assert.deepEqual(await api('/api/notifications/devices', device, { token: phone.token }), { ok: true });
  await api('/api/notifications/devices', { ...device, token: 'not-hex' }, { token: phone.token, status: 422 });
  await api('/api/notifications/devices', { ...device, environment: 'staging' }, { token: phone.token, status: 422 });
  assert.deepEqual(await api('/api/notifications/devices/remove', device, { token: phone.token }), { ok: true });
  await deleteAccount(phone.token);
});

test('event feed and single events', { skip }, async (t) => {
  const app = await newAccount('ct-feed');
  if ((await devices(app.token)).notifications.feed === false) { // Cloudflare: alerts travel in the push only
    await deleteAccount(app.token);
    return t.skip('this server keeps no notification feed');
  }
  const feed = (cursor, status) => api(`/api/notifications/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    undefined, { token: app.token, status });
  const baseline = await feed();
  assert.equal(baseline.events.length, 0);
  assert.match(baseline.cursor, /^EVENT#\d{16}#~$/);
  assert.deepEqual(await feed('bogus', 400), { detail: 'Invalid notification cursor.' });

  const alert = { eventId: randomBytes(32).toString('hex'), device: 'ct-mac', sessionId: 's1', rootSessionId: 's1',
    title: 'ct · title', body: 'ct body' };
  assert.deepEqual(await api('/api/notifications/events', alert, { token: app.token }), { ok: true });
  const next = await feed(baseline.cursor);
  assert.equal(next.events.length, 1);
  assert.deepEqual({ ...next.events[0], ...alert, accountId: app.accountId }, next.events[0]);
  assert.match(next.cursor, new RegExp(`^EVENT#\\d{16}#${alert.eventId}$`));
  assert.deepEqual(await feed(next.cursor), { events: [], cursor: next.cursor });

  const one = (token, status, id = next.cursor) => api(`/api/notifications/event?id=${encodeURIComponent(id)}`, undefined, { token, status });
  assert.deepEqual(await one(app.token), next.events[0]);
  if (KEY) assert.deepEqual(await one(KEY, 404), { detail: 'Notification expired.' }); // another account
  assert.deepEqual(await one(app.token, 400, alert.eventId), { detail: 'Invalid notification ID.' });
  await deleteAccount(app.token);
});
