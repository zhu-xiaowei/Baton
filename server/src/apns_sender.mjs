// Direct APNs HTTP/2 transport (Python Lambdas have no HTTP/2 client). The key is a
// free SSM SecureString read with the SDK bundled in the Lambda runtime.
import { connect, constants } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

let cachedCredentials;
let cachedJwt;
let cachedJwtAt = 0;

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
  }
  return cachedCredentials;
}

export function sendNotification({ token, environment, eventId, payload }, jwt, {
  connectSession = connect,
  now = Math.floor(Date.now() / 1000),
  topic = process.env.APNS_TOPIC || 'com.batonai.app',
} = {}) {
  if (!/^[a-f0-9]{64,200}$/i.test(token || '') || !['development', 'production'].includes(environment)) {
    throw new Error('Invalid APNs device destination.');
  }
  if (!/^[a-f0-9]{64}$/.test(eventId || '')) throw new Error('Invalid notification event ID.');
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 4096) throw new Error('APNs payload exceeds 4096 bytes.');
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

export async function handler(event) {
  const config = await credentials();
  const now = Math.floor(Date.now() / 1000);
  if (!cachedJwt || now - cachedJwtAt >= 45 * 60) {
    cachedJwt = providerToken(config, now);
    cachedJwtAt = now;
  }
  const result = await sendNotification(event, cachedJwt);
  // Pick up key rotation on the next retry without exposing key material.
  if (['ExpiredProviderToken', 'InvalidProviderToken'].includes(result.reason)) {
    cachedJwt = null;
    cachedCredentials = null;
  }
  return result;
}
