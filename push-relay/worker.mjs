// The APNs relay on Cloudflare: apns_relay.mjs's request contract ({ token, environment, id, alert? } →
// { status, reason }), reached only through a service binding. Secrets/vars: APNS_KEY (the .p8 PEM, or the
// relay's SSM JSON { keyId, teamId, privateKey }), APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC.
const TOKEN_SEC = 40 * 60; // APNs answers TooManyProviderTokenUpdates to refreshes under 20 min apart
const MIN_TOKEN_SEC = 20 * 60;
const encoder = new TextEncoder();
const seconds = () => Math.floor(Date.now() / 1000);
let cached = null; // this isolate's { jwt, at }

export function invalidRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'Expected a JSON object.';
  const { token, environment, id, alert } = request;
  if (!/^[a-f0-9]{64,200}$/i.test(token || '') || !['development', 'production'].includes(environment)) {
    return 'Invalid APNs device destination.';
  }
  if (!/^EVENT#\d{16}#[a-f0-9]{64}$/.test(id || '')) return 'Invalid notification event ID.';
  if (alert !== undefined && (!alert || typeof alert !== 'object' || Array.isArray(alert))) return 'Invalid alert.';
  return '';
}

export function payload(id, alert) {
  const aps = { alert: { title: 'Baton', body: 'Session update' }, sound: 'default', 'mutable-content': 1 };
  return JSON.stringify({ aps, id, ...alert, aps, id });
}

function credentials(env) {
  const raw = String(env.APNS_KEY || '').trim();
  const c = raw.startsWith('{') ? JSON.parse(raw) : { privateKey: raw, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID };
  if (!c.privateKey || !c.keyId || !c.teamId) throw new Error('APNs key, key ID and team ID are required.');
  return c;
}

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const part = (value) => b64u(encoder.encode(JSON.stringify(value)));

export async function providerToken(c, now) {
  const der = Uint8Array.from(atob(c.privateKey.replace(/-----[A-Z ]+-----|\s/g, '')), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const message = `${part({ alg: 'ES256', kid: c.keyId })}.${part({ iss: c.teamId, iat: now })}`;
  return `${message}.${b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(message)))}`;
}

// One per relay (idFromName('apns')): the JWT every isolate shares, re-signed every TOKEN_SEC.
export class ApnsToken {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const rejected = Number(new URL(request.url).searchParams.get('rejected')) || 0;
    this.token ??= await this.state.storage.get('token');
    const c = credentials(this.env);
    const kid = `${c.keyId}.${c.teamId}`;
    const now = seconds();
    const t = this.token;
    if (!t || t.kid !== kid || now - t.at >= TOKEN_SEC || (rejected === t.at && now - t.at >= MIN_TOKEN_SEC)) {
      this.pending ||= providerToken(c, now).then(async (jwt) => {
        this.token = { jwt, at: now, kid };
        await this.state.storage.put('token', this.token);
      }).finally(() => { this.pending = null; });
    }
    if (this.pending) await this.pending;
    return Response.json({ jwt: this.token.jwt, at: this.token.at });
  }
}

async function providerJwt(env, rejected = 0) {
  if (!cached || rejected || seconds() - cached.at >= TOKEN_SEC) {
    const stub = env.APNS_TOKEN.get(env.APNS_TOKEN.idFromName('apns'));
    cached = await (await stub.fetch(`https://token/?rejected=${rejected}`)).json();
  }
  return cached;
}

async function send(env, request, jwt) {
  const host = request.environment === 'development' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const init = {
    method: 'POST',
    headers: {
      authorization: `bearer ${jwt}`,
      'apns-topic': env.APNS_TOPIC || 'com.batonai.app',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(seconds() + 300),
      'apns-collapse-id': request.id.slice(-64),
      'content-type': 'application/json',
    },
    body: payload(request.id, request.alert),
  };
  let response;
  try {
    response = await fetch(`https://${host}/3/device/${request.token}`, init);
  } catch {
    response = await fetch(`https://${host}/3/device/${request.token}`, init); // a duplicate is collapsed
  }
  let body = {};
  try { body = JSON.parse(await response.text() || '{}'); } catch {}
  return { status: response.status, reason: body.reason || '' };
}

const reply = (status, body) => Response.json(body, { status });

// As the Lambda's allow(): at most 60 alerts a minute per device token, per isolate.
const recent = new Map();
function allow(token, now = Date.now()) {
  if (recent.size > 10000) recent.clear();
  const [start, count] = recent.get(token) || [now, 0];
  recent.set(token, now - start >= 60000 ? [now, 1] : [start, count + 1]);
  return now - start >= 60000 || count < 60;
}

export default {
  async fetch(request, env) {
    // A public request (workers.dev or a route) carries the visitor's IP; a service binding's does not.
    if (request.method !== 'POST' || request.headers.has('cf-connecting-ip')) return new Response('Not found', { status: 404 });
    const raw = await request.text();
    if (encoder.encode(raw).length > 8192) return reply(413, { error: 'Request too large' });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return reply(400, { error: 'Invalid JSON' });
    }
    const invalid = invalidRequest(body);
    if (invalid) return reply(400, { error: invalid });
    if (!allow(body.token)) return reply(429, { error: 'Too many notifications for this device' });
    if (encoder.encode(payload(body.id, body.alert)).length > 4096) return reply(413, { error: 'Notification too large' });
    try {
      const token = await providerJwt(env);
      const result = await send(env, body, token.jwt);
      // As the Lambda: the next alert gets a fresh token (key rotation), if APNs allows one yet.
      if (['ExpiredProviderToken', 'InvalidProviderToken'].includes(result.reason)) await providerJwt(env, token.at).catch(() => {});
      return reply(200, result);
    } catch {
      return reply(502, { error: 'APNs unreachable' });
    }
  },
};
