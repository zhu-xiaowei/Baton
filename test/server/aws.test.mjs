// What the URL contract suite (test/contract) cannot reach: push relay signing and retries, and the
// deployment key check of the WebSocket and REST Lambdas, with AWS answered by a fake transport.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setRequest } from '../../server/aws/aws.mjs';
import { createNotifications } from '../../server/core/notifications.mjs';

const KEY = 'deployment-key';
Object.assign(process.env, { AWS_REGION: 'ap-northeast-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret',
  AWS_SESSION_TOKEN: 'token', API_KEY_NAME: 'Baton-api-key', SYSTEM_TABLE: 'system', CONNECTIONS_TABLE: 'connections' });
let apiGateway = () => ({ item: [{ name: 'Baton-api-key', enabled: true, value: KEY }] });
const sent = [];
const reply = (status, text = '{}') => ({ status, headers: {}, text });
setRequest(async (url, options) => {
  sent.push({ url, ...options });
  if (url.includes('apigateway')) return reply(200, JSON.stringify(apiGateway()));
  if (url.includes('lambda-url')) return sent.relay.shift()();
  return reply(200); // DynamoDB PutItem
});
const connect = async (apiKey) => (await import('../../server/aws/ws-handler.mjs')).handler({
  queryStringParameters: { apiKey, role: 'app' }, requestContext: { routeKey: '$connect', connectionId: 'c', domainName: 'control.test', stage: 'v1' } });

test('an unreadable deployment key is a 503, never a guess', async () => {
  apiGateway = () => { throw new Error('down'); };
  const random = Math.random;
  Math.random = () => 0; // botocore's backoff, without the waiting
  assert.deepEqual(await connect(KEY), { statusCode: 503 });
  const rest = await (await import('../../server/aws/http-handler.mjs')).createHandler('/nonexistent')({
    httpMethod: 'GET', path: '/api/bridge/devices', headers: { 'x-api-key': KEY } });
  assert.deepEqual([rest.statusCode, rest.body], [503, '{"error":"temporarily unavailable"}']);
  Math.random = random;
});

test('WebSocket connections accept only the current deployment key, pinned to its account', async () => {
  apiGateway = () => ({ item: [{ name: 'Baton-api-key', enabled: true, value: KEY }] });
  assert.deepEqual(await connect('guess'), { statusCode: 401 });
  assert.deepEqual(await connect(''), { statusCode: 401 });
  process.env.ACCOUNT_ID = 'pinned';
  assert.deepEqual(await connect(KEY), { statusCode: 200 });
  assert.equal(JSON.parse(sent.at(-1).body).Item.accountId.S, 'pinned');
  delete process.env.ACCOUNT_ID;
});

test('the push relay is signed, retries throttling with full jitter and a dropped connection at once', async () => {
  const { relayPost } = await import('../../server/aws/http-handler.mjs');
  const waits = [];
  const ok = () => reply(200, '{"status": 200}');
  const status = (code) => () => reply(code, '');
  const { relay } = createNotifications({ env: { PUSH_RELAY_URL: 'https://abc.lambda-url.us-west-2.on.aws/' }, relayPost,
    random: () => 1, sleep: async (sec) => { waits.push(sec); } });
  sent.relay = [status(429), status(503), status(502), ok, () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }, ok, status(400)];
  assert.deepEqual(await relay({ token: 'a' }), { status: 200 });
  assert.deepEqual(waits, [2, 4, 8]);
  const signed = sent.at(-1).headers;
  assert.match(signed.authorization, /us-west-2\/lambda\/aws4_request/);
  assert.equal(signed['x-amz-security-token'], 'token');
  assert.deepEqual(await relay({ token: 'a' }), { status: 200 }); // dropped while frozen: reconnect, no backoff
  assert.equal(waits.length, 3);
  await assert.rejects(relay({ token: 'a' }), /rejected the alert \(400\)/);
});

test('logging out closes every socket of that token, though the role index has no tokenHash', async () => {
  const { createAccounts } = await import('../../server/core/accounts.mjs');
  const closed = [];
  const sockets = { query: async (_, role) => [{ connectionId: role }], get: async (id) => ({ tokenHash: id === 'app_data' ? 'mine' : 'other' }),
    deleteConnection: async (_, id) => closed.push(id), handleDisconnect: async () => {}, post: async () => {} };
  const table = { query: async () => ({ Items: [] }), deleteItem: async () => {} };
  const accounts = createAccounts({ env: { WS_API_ENDPOINT: 'w', TERMINAL_DIRECT_ENDPOINT: 'd' }, table, sockets, log: () => {} });
  await accounts.routes.find((route) => route.path === '/api/tokens/revoke').handler({ body: {}, auth: { accountId: 'a', tokenHash: 'mine' } });
  assert.deepEqual(closed, ['app_data']);
});

test('a computer logging out (leave) leaves the device list too', async () => {
  const { createAccounts } = await import('../../server/core/accounts.mjs');
  const gone = [];
  const accounts = createAccounts({ env: {}, table: { query: async () => ({ Items: [] }), deleteItem: async () => {} },
    devices: { delete: async (account, name) => gone.push(`${account}/${name}`) }, sockets: {}, log: () => {} });
  await accounts.routes.find((route) => route.path === '/api/tokens/revoke').handler({ body: {},
    auth: { accountId: 'a', kind: 'bridge', deviceName: 'pc-1', tokenHash: 'mine' } });
  assert.deepEqual(gone, ['a/pc-1']);
});
