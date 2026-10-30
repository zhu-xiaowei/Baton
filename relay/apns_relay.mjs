// Stateless APNs relay shared by every Baton deployment, behind a Lambda Function URL.
// Only it holds the app's signing key (a free SSM SecureString); it stores nothing and
// logs no payloads. Device tokens are unguessable, so a caller can only reach devices
// that registered with its own server.
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
  const { token, environment, eventId, payload } = request;
  if (!/^[a-f0-9]{64,200}$/i.test(token || '') || !['development', 'production'].includes(environment)) {
    return 'Invalid APNs device destination.';
  }
  if (!/^[a-f0-9]{64}$/.test(eventId || '')) return 'Invalid notification event ID.';
  if (Buffer.byteLength(JSON.stringify(payload) || '') > 4096) return 'APNs payload exceeds 4096 bytes.';
  return '';
}

export function sendNotification(request, jwt, {
  connectSession = connect,
  now = Math.floor(Date.now() / 1000),
  topic = process.env.APNS_TOPIC || 'com.batonai.app',
} = {}) {
  const invalid = invalidRequest(request);
  if (invalid) throw new Error(invalid);
  const { token, environment, eventId, payload } = request;
  const body = JSON.stringify(payload);
  const origin = environment === 'development'
    ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  return new Promise((resolve, reject) => {
    const session = connectSession(origin);
    let request;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request?.close(constants.NGHTTP2_CANCEL);
      session.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error('APNs request timed out.')), 10000);
    session.once('error', error => finish(error));
    session.once('goaway', () => finish(new Error('APNs closed the HTTP/2 connection.')));
    request = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(now + 300),
      'apns-collapse-id': eventId,
      'content-type': 'application/json',
    });
    let status, responseBody = '';
    request.setEncoding('utf8');
    request.on('response', headers => { status = Number(headers[':status']); });
    request.on('data', chunk => { responseBody += chunk; });
    request.once('error', error => finish(error));
    request.once('end', () => {
      let response = {};
      try { response = JSON.parse(responseBody || '{}'); } catch {}
      finish(null, { status, reason: response.reason || '' });
    });
    request.end(body);
  });
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
  if (Buffer.byteLength(raw) > 6144) return reply(413, { error: 'Request too large' });
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
