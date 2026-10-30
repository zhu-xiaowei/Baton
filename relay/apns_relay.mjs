// Stateless APNs relay shared by every Baton deployment, behind a Lambda Function URL.
// Only it holds the app's signing key (a free SSM SecureString). It never sees alert
// content: each push carries just an event ID, and the app's notification extension
// fetches the text from the user's own server. Device tokens are unguessable, so a
// caller can only reach devices that registered with its own server.
import { connect, constants } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

let cachedCredentials;
let cachedJwt;
let cachedJwtAt = 0;

// Console pastes often turn the .p8 line breaks into spaces; rebuild the PEM.
export function normalizePem(pem) {
  const body = pem.replace(/-----[A-Z ]+-----|\s/g, '');
  return `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
}

export function providerToken(credentials, now = Math.floor(Date.now() / 1000)) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const message = `${encode({ alg: 'ES256', kid: credentials.keyId })}.${encode({
    iss: credentials.teamId, iat: now,
  })}`;
  const key = createPrivateKey(credentials.privateKey);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('APNs requires an EC P-256 signing key.');
  }
  return `${message}.${sign('sha256', Buffer.from(message), {
    key, dsaEncoding: 'ieee-p1363',
  }).toString('base64url')}`;
}

async function credentials() {
  if (!cachedCredentials) {
    const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
    const { Parameter } = await new SSMClient({}).send(new GetParameterCommand({
      Name: process.env.APNS_KEY_PARAMETER, WithDecryption: true,
    }));
    cachedCredentials = JSON.parse(Parameter.Value);
    if (!cachedCredentials.keyId || !cachedCredentials.teamId || !cachedCredentials.privateKey) {
      throw new Error('APNs key parameter must contain keyId, teamId and privateKey.');
    }
    cachedCredentials.privateKey = normalizePem(cachedCredentials.privateKey);
  }
  return cachedCredentials;
}

export function invalidRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return 'Expected a JSON object.';
  const { token, environment, id } = request;
  if (!/^[a-f0-9]{64,200}$/i.test(token || '') || !['development', 'production'].includes(environment)) {
    return 'Invalid APNs device destination.';
  }
  if (!/^EVENT#\d{16}#[a-f0-9]{64}$/.test(id || '')) return 'Invalid notification event ID.';
  return '';
}

// Shown as is only if the extension cannot reach the user's server in time.
export function placeholder(id) {
  return { aps: { alert: { title: 'Baton', body: 'Session update' }, sound: 'default', 'mutable-content': 1 }, id };
}

// One HTTP/2 connection per APNs origin, kept across warm invocations (Apple asks
// providers to reuse connections): later alerts skip the TLS handshake.
const sessions = new Map();

function apnsSession(origin, connectSession) {
  let session = sessions.get(origin);
  if (!session || session.closed || session.destroyed) {
    session = connectSession(origin);
    const forget = () => { if (sessions.get(origin) === session) sessions.delete(origin); };
    session.on('error', forget);
    session.on('goaway', forget);
    session.on('close', forget);
    sessions.set(origin, session);
  }
  return session;
}

export function closeSessions() {
  for (const session of sessions.values()) session.destroy();
  sessions.clear();
}

function sendOnce(session, headers, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        request.close(constants.NGHTTP2_CANCEL);
        session.destroy();
        reject(error);
      } else {
        resolve(result);
      }
    };
    const timeout = setTimeout(() => finish(new Error('APNs request timed out.')), 10000);
    const request = session.request(headers);
    let status, responseBody = '';
    request.setEncoding('utf8');
    request.on('response', response => { status = Number(response[':status']); });
    request.on('data', chunk => { responseBody += chunk; });
    request.once('error', error => finish(error));
    request.once('close', () => { if (status === undefined) finish(new Error('APNs closed the stream.')); });
    request.once('end', () => {
      let response = {};
      try { response = JSON.parse(responseBody || '{}'); } catch {}
      finish(null, { status, reason: response.reason || '' });
    });
    request.end(body);
  });
}

export async function sendNotification(request, jwt, {
  connectSession = connect,
  now = Math.floor(Date.now() / 1000),
  topic = process.env.APNS_TOPIC || 'com.batonai.app',
} = {}) {
  const invalid = invalidRequest(request);
  if (invalid) throw new Error(invalid);
  const { token, environment, id } = request;
  const origin = environment === 'development'
    ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const headers = {
    ':method': 'POST',
    ':path': `/3/device/${token}`,
    authorization: `bearer ${jwt}`,
    'apns-topic': topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-expiration': String(now + 300),
    'apns-collapse-id': id.slice(-64),
    'content-type': 'application/json',
  };
  const body = JSON.stringify(placeholder(id));
  try {
    return await sendOnce(apnsSession(origin, connectSession), headers, body);
  } catch {
    // A connection left idle while Lambda was frozen may be gone: reconnect once.
    // A duplicate is harmless, apns-collapse-id replaces the earlier alert.
    return sendOnce(apnsSession(origin, connectSession), headers, body);
  }
}

const recent = new Map();

// Best-effort per-token limit inside one warm instance; the function's concurrency
// cap bounds the total.
export function allow(token, now = Date.now()) {
  if (recent.size > 10000) recent.clear();
  const [start, count] = recent.get(token) || [now, 0];
  if (now - start >= 60000) {
    recent.set(token, [now, 1]);
    return true;
  }
  recent.set(token, [start, count + 1]);
  return count < 60;
}

const reply = (statusCode, body) => ({
  statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export async function handler(event) {
  if (event.requestContext?.http?.method !== 'POST') return reply(405, { error: 'POST only' });
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : event.body || '';
  if (Buffer.byteLength(raw) > 1024) return reply(413, { error: 'Request too large' });
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'Invalid JSON' });
  }
  // Validate first, so malformed requests never count against a device.
  const invalid = invalidRequest(request);
  if (invalid) return reply(400, { error: invalid });
  if (!allow(request.token)) return reply(429, { error: 'Too many notifications for this device' });
  const config = await credentials();
  const now = Math.floor(Date.now() / 1000);
  if (!cachedJwt || now - cachedJwtAt >= 45 * 60) {
    cachedJwt = providerToken(config, now);
    cachedJwtAt = now;
  }
  let result;
  try {
    result = await sendNotification(request, cachedJwt);
  } catch {
    return reply(502, { error: 'APNs unreachable' });
  }
  // Pick up key rotation on the next request without exposing key material.
  if (['ExpiredProviderToken', 'InvalidProviderToken'].includes(result.reason)) {
    cachedJwt = null;
    cachedCredentials = null;
  }
  return reply(200, result);
}
