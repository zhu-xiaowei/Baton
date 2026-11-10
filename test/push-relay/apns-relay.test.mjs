import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { connect, createServer } from 'node:http2';
import test from 'node:test';
import { closeSessions, handler, normalizePem, placeholder, providerToken, sendNotification } from '../../push-relay/apns_relay.mjs';

const ID = 'EVENT#' + '1'.repeat(16) + '#' + 'b'.repeat(64);

test('APNs provider JWT has Apple claims and a valid ES256 signature', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const token = providerToken({
    keyId: 'KEY123', teamId: 'TEAM123',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }, 123456);
  const [header, body, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY123' });
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), { iss: 'TEAM123', iat: 123456 });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(`${header}.${body}`), {
    key: createPublicKey(privateKey), dsaEncoding: 'ieee-p1363',
  }, Buffer.from(signature, 'base64url')));
  // Console pastes turn the .p8 line breaks into spaces.
  const pasted = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, ' ');
  assert.ok(providerToken({ keyId: 'K', teamId: 'T', privateKey: normalizePem(pasted) }, 1));
});

test('delivery carries only the event ID and a placeholder, with the APNs headers', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let headers, content = '', destination;
  server.on('stream', (stream, incoming) => {
    headers = incoming;
    stream.setEncoding('utf8');
    stream.on('data', chunk => { content += chunk; });
    stream.on('end', () => {
      stream.respond({ ':status': 410 });
      stream.end('{"reason":"Unregistered"}');
    });
  });
  try {
    const result = await sendNotification({
      token: 'a'.repeat(64), environment: 'development', id: ID,
    }, 'signed-provider-token', {
      now: 100,
      connectSession: origin => {
        destination = origin;
        return connect(`http://127.0.0.1:${server.address().port}`);
      },
    });
    assert.equal(destination, 'https://api.sandbox.push.apple.com');
    assert.equal(headers[':path'], '/3/device/' + 'a'.repeat(64));
    assert.equal(headers.authorization, 'bearer signed-provider-token');
    assert.equal(headers['apns-topic'], 'com.batonai.app');
    assert.equal(headers['apns-push-type'], 'alert');
    assert.equal(headers['apns-expiration'], '400');
    assert.equal(headers['apns-collapse-id'], 'b'.repeat(64));
    assert.deepEqual(JSON.parse(content), placeholder(ID));
    assert.equal(JSON.parse(content).aps['mutable-content'], 1);
    assert.deepEqual(result, { status: 410, reason: 'Unregistered' });
  } finally {
    closeSessions();
    await new Promise(resolve => server.close(resolve));
  }
});

test('the APNs connection is reused, and replaced once it is gone', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const live = [];
  server.on('session', session => live.push(session));
  server.on('stream', stream => {
    stream.on('data', () => {});
    stream.on('end', () => { stream.respond({ ':status': 200 }); stream.end(); });
  });
  let connects = 0;
  const options = { connectSession: () => { connects++; return connect(`http://127.0.0.1:${server.address().port}`); } };
  const event = { token: 'a'.repeat(64), environment: 'production', id: ID };
  try {
    assert.equal((await sendNotification(event, 'jwt', options)).status, 200);
    assert.equal((await sendNotification(event, 'jwt', options)).status, 200);
    assert.equal(connects, 1);
    live.forEach(session => session.destroy());  // Like a socket dropped while Lambda was frozen.
    assert.equal((await sendNotification(event, 'jwt', options)).status, 200);
    assert.equal(connects, 2);
  } finally {
    closeSessions();
    await new Promise(resolve => server.close(resolve));
  }
});

test('the public URL rejects bad requests before touching the key', async () => {
  const post = body => ({ requestContext: { http: { method: 'POST' } }, body });
  assert.equal((await handler({ requestContext: { http: { method: 'GET' } } })).statusCode, 405);
  assert.equal((await handler(post('x'.repeat(2000)))).statusCode, 413);
  assert.equal((await handler(post('{'))).statusCode, 400);
  for (const body of ['null', '[]', '7', '{"token":"bad"}']) {
    assert.equal((await handler(post(body))).statusCode, 400, body);
  }
});
