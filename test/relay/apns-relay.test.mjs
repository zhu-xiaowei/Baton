import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { connect, createServer } from 'node:http2';
import test from 'node:test';
import { allow, handler, normalizePem, providerToken, sendNotification } from '../../relay/apns_relay.mjs';

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
});

test('direct HTTP/2 delivery selects sandbox and preserves the payload and APNs headers', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const payload = { aps: { alert: { title: 'Project · Session', body: 'Approval needed: npm test' } } };
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
      token: 'a'.repeat(64), environment: 'development', eventId: 'b'.repeat(64), payload,
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
    assert.deepEqual(JSON.parse(content), payload);
    assert.deepEqual(result, { status: 410, reason: 'Unregistered' });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('oversize payloads and malformed destinations fail before opening a connection', () => {
  const event = { token: 'a'.repeat(64), environment: 'production', eventId: 'b'.repeat(64) };
  const options = { connectSession: () => assert.fail('must not open a connection') };
  assert.throws(() => sendNotification({ ...event, payload: { text: 'x'.repeat(4097) } }, 'jwt', options), /4096/);
  assert.throws(() => sendNotification({ ...event, token: 'invalid', payload: {} }, 'jwt', options), /destination/);
});

test('a PEM whose line breaks were pasted as spaces still signs', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pasted = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, ' ');
  assert.ok(providerToken({ keyId: 'K', teamId: 'T', privateKey: normalizePem(pasted) }, 1));
});

test('the public URL rejects bad requests before touching the key', async () => {
  const post = body => ({ requestContext: { http: { method: 'POST' } }, body });
  assert.equal((await handler({ requestContext: { http: { method: 'GET' } } })).statusCode, 405);
  assert.equal((await handler(post('x'.repeat(7000)))).statusCode, 413);
  assert.equal((await handler(post('{'))).statusCode, 400);
  for (const body of ['null', '[]', '7', '{"token":"bad"}']) {
    assert.equal((await handler(post(body))).statusCode, 400, body);
  }
});

test('each token gets at most 60 alerts a minute per instance', () => {
  for (let i = 0; i < 60; i++) assert.equal(allow('t', 0), true);
  assert.equal(allow('t', 1000), false);
  assert.equal(allow('t', 60000), true);
});
