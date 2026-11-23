// Mobile notifications: device registration, the event feed and delivery.
//
// The Bridge decides and words each alert (bridge/notify.mjs) and posts it here. Android polls
// the feed; an iOS push carries the event ID and the (sealed) alert, and the notification extension
// fetches by ID only when the alert is missing. Alerts carry no transcript or credential.
import { HTTPError, pattern, validate } from './util.mjs';

// API Gateway answers at 29 s; past this the feed row (already written) is enough for Android.
const RELAY_BUDGET_SEC = 20;
const required = { required: true };
const max = (maxLength, extra = { default: '' }) => ({ maxLength, ...extra });

const PushDevice = [
  ['token', pattern('^[a-fA-F0-9]{64,200}$', required)],
  ['environment', pattern('^(development|production)$', required)],
];
const Alert = [
  ['eventId', pattern('^[a-f0-9]{64}$', required)],
  ['device', max(200, required)],
  ['projectHash', max(400)],
  ['projectName', max(80)],
  ['sessionId', max(200, required)],
  ['sessionTitle', max(120)],
  ['rootSessionId', max(200, required)],
  ['title', max(210)],
  ['body', max(300)],
  // The fields above, sealed by the Bridge (bridge/notify.mjs); only the phone can open them.
  ['e', max(8000)],
];
const EVENT_ID = /^EVENT#\d{16}#[a-f0-9]{64}$/;
const CURSOR = /^EVENT#\d{16}#([a-f0-9]{64}|~)$/;
const eventKey = (ms) => `EVENT#${String(Math.floor(ms)).padStart(16, '0')}`;
// Fits the relay's 4096 B APNs payload with its placeholder and ID.
const ALERT_PUSH_BYTES = 3800;

// A socket alert ({action:'alert', ...}) checked like the REST body; null when invalid.
export function validateAlert(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return validate(Alert, body, ['body']).value ?? null;
}

// relayPost(url, body, timeoutSec) → { status, data } POSTs once to the push relay (throws when unreachable).
export function createNotifications({ env, table, relayPost, log, random = Math.random,
  sleep = (sec) => new Promise((resolve) => setTimeout(resolve, sec * 1000)) }) {
  const relayConfigured = () => !!env.PUSH_RELAY_URL;
  // Cloudflare keeps no feed: each push carries its sealed alert.
  const feed = env.NOTIFICATION_FEED !== 'off';
  const noFeed = () => { if (!feed) throw new HTTPError(404, 'Notifications are not stored on this server.'); };
  const pushKey = (body, account) => ({ pk: `PUSH_DEVICE#${account}`, sk: `${body.environment}:${body.token.toLowerCase()}` });

  // POST one alert to the shared APNs relay (push-relay/); it returns APNs' status and reason.
  async function relay(request, deadline = null, attempts = 4) {
    const body = JSON.stringify(request);
    deadline = deadline || Date.now() / 1000 + RELAY_BUDGET_SEC;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) {
        // The relay rejects (429) rather than queues past its concurrency; full jitter
        // (0-2, 0-4, 0-8 s) spreads stacks retrying at the same moment.
        await sleep(Math.min(random() * 2 ** attempt, Math.max(0, deadline - Date.now() / 1000)));
      }
      const left = deadline - Date.now() / 1000;
      if (left <= 0) break;
      let result;
      try {
        result = await relayPost(env.PUSH_RELAY_URL, body, left / 2);
      } catch {
        continue;
      }
      if (result.status === 200) return JSON.parse(result.data);
      if (result.status !== 429 && result.status < 500) throw Object.assign(new Error(`Push relay rejected the alert (${result.status})`), { rejected: true });
    }
    throw new Error('Push relay unavailable');
  }

  async function sendApns(eventId, device, deadline = null, alert = undefined) {
    const split = device.sk.indexOf(':');
    if (split < 0) throw new Error(`not a push device key: ${device.sk}`);
    const result = await relay({ token: device.sk.slice(split + 1), environment: device.sk.slice(0, split), id: eventId, alert }, deadline);
    if (result.status === 200) return;
    if (['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic', 'TopicDisallowed'].includes(result.reason)) {
      await table.deleteItem({ Key: { pk: device.pk, sk: device.sk } });
      return;
    }
    log(`APNs rejected an alert: ${result.reason ?? 'unknown'}`);
  }

  async function registerDevice({ body, auth }) {
    if (!relayConfigured()) throw new HTTPError(503, 'iOS push is not configured on this server.');
    // The token, so removing the device also removes its alerts. Apps register on every launch: rewritten once a day at most.
    const key = pushKey(body, auth.accountId), now = Math.floor(Date.now() / 1000);
    const row = (await table.getItem({ Key: key })).Item;
    if (row?.tokenHash === (auth.tokenHash ?? '') && Math.trunc(row.ttl ?? 0) > now + 29 * 86400) return { ok: true };
    await table.putItem({ Item: { ...key, tokenHash: auth.tokenHash ?? '', ttl: now + 30 * 86400 } });
    return { ok: true };
  }

  async function removeDevice({ body, auth }) {
    await table.deleteItem({ Key: pushKey(body, auth.accountId) });
    return { ok: true };
  }

  // One alert's text for the iOS notification extension; the push carried only this ID.
  async function event({ query, auth }) {
    noFeed();
    if (!EVENT_ID.test(query.id)) throw new HTTPError(400, 'Invalid notification ID.');
    const row = (await table.getItem({ Key: { pk: `NOTIFICATIONS#${auth.accountId}`, sk: query.id } })).Item;
    if (!row || Math.trunc(row.ttl) <= Date.now() / 1000) throw new HTTPError(404, 'Notification expired.');
    return row.event;
  }

  async function events({ query, auth }) {
    noFeed();
    // Each launch/resume starts a fresh baseline: Android never replays background events.
    if (!query.cursor) return { events: [], cursor: `${eventKey(Date.now())}#~` };
    if (!CURSOR.test(query.cursor)) throw new HTTPError(400, 'Invalid notification cursor.');
    const rows = (await table.query({ KeyConditionExpression: '#pk = :pk AND #sk > :cursor', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': `NOTIFICATIONS#${auth.accountId}`, ':cursor': query.cursor }, ConsistentRead: true, Limit: 100 })).Items;
    return { events: rows.filter((row) => Math.trunc(row.ttl) > Date.now() / 1000).map((row) => row.event),
      cursor: rows.length ? rows.at(-1).sk : query.cursor };
  }

  // A Bridge's validated alert: stored for Android and the iOS extension, then pushed to iOS.
  async function deliver(account, alert, nowMs = Date.now()) {
    // Keyed at receipt: Android's cursor only moves forward, so a queued alert must not keep its time.
    // The key is also the iOS push ID.
    const eventId = `${eventKey(nowMs)}#${alert.eventId}`;
    const event = { ...alert, accountId: account };
    if (feed) {
      await table.putItem({ Item: { pk: `NOTIFICATIONS#${account}`, sk: eventId, event,
        ttl: Math.floor(nowMs / 1000) + 7 * 86400 } });
    }
    if (!relayConfigured()) return;
    // The relay and Apple see only sealed alerts; others are fetched by ID (none on a server without a feed).
    let pushed = event.e && new TextEncoder().encode(JSON.stringify(event)).length <= ALERT_PUSH_BYTES ? event : undefined;
    const deadline = nowMs / 1000 + RELAY_BUDGET_SEC;
    const devices = await table.query({ KeyConditionExpression: '#pk = :pk', ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': `PUSH_DEVICE#${account}` }, ConsistentRead: true });
    for (const device of devices.Items) {
      if (Math.trunc(device.ttl ?? 0) > nowMs / 1000) {
        try {
          // A relay that predates `alert` refuses it (413): the ID alone, as before.
          await sendApns(eventId, device, deadline, pushed).catch((error) => {
            if (!pushed || !error.rejected) throw error;
            pushed = undefined;
            return sendApns(eventId, device, deadline);
          });
        } catch (error) {
          // The feed row is written: Android still gets it. The relay is down, so skip the rest.
          log(`Push relay unavailable; iOS alert dropped: ${error.message}`);
          break;
        }
      }
    }
  }

  async function postEvent({ body, auth }) {
    await deliver(auth.accountId, body);
    return { ok: true };
  }

  return {
    relay,
    deliver,
    info: (accountId) => ({ accountId, ios: relayConfigured(), ...(feed ? {} : { feed: false }) }), // what the App needs to set up alerts; returned with /devices
    routes: [
      { method: 'POST', path: '/api/notifications/devices', body: PushDevice, handler: registerDevice },
      { method: 'POST', path: '/api/notifications/devices/remove', body: PushDevice, handler: removeDevice },
      { method: 'GET', path: '/api/notifications/event', query: [['id', required]], handler: event },
      { method: 'GET', path: '/api/notifications/events', query: [['cursor', { default: '' }]], handler: events },
      { method: 'POST', path: '/api/notifications/events', body: Alert, handler: postEvent },
    ],
  };
}
