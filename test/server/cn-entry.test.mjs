import assert from 'node:assert/strict';
import test from 'node:test';
import { pickEntry, viaEntry } from '../../bridge/entry.mjs';
import { createAccounts, issueIpToken, locationHint, readIpToken } from '../../server/core/accounts.mjs';

test('callers in CN use a relay that answers, everyone else the API host', async () => {
  const replies = { 'https://api': { version: '1', country: 'CN', entries: ['https://dead', 'https://jp'] }, 'https://jp': { version: '1' } };
  const fetchImpl = async (url) => { const r = replies[url.replace('/api/version', '')]; if (!r) throw new Error('down'); return { json: async () => r }; };
  assert.equal(await pickEntry('https://api', fetchImpl), 'https://jp');
  replies['https://api'].country = 'JP';
  assert.equal(await pickEntry('https://api', fetchImpl), 'https://api');
  assert.equal(viaEntry('wss://api.x/ws?a=1', 'https://api.x', 'https://jp.x'), 'wss://jp.x/ws?a=1');
});

test('a new account goes near the entry of its first computer', () => {
  assert.deepEqual([{ relay: true, continent: 'EU' }, { continent: 'AS', lon: 54 }, { continent: 'NA', lon: -122 }, { continent: 'NA', lon: -77 }, {}]
    .map(locationHint), ['apac', 'me', 'wnam', 'enam', undefined]);
});

test('a relayed caller names its own address with a token only the server can sign', async () => {
  const token = await issueIpToken('k', { ip: '36.112.194.126', country: 'CN', asn: 4134 });
  assert.deepEqual(await readIpToken('k', token), { ip: '36.112.194.126', country: 'CN', asn: '4134' });
  assert.equal(await readIpToken('other', token), null);
  assert.equal(await readIpToken('k', token.replace('36.112', '1.2')), null);
  assert.equal(await readIpToken('', token), null);
});

test('a computer code in its last 30 s opens no account (its Bridge may have stopped waiting)', async () => {
  let left;
  const table = { updateItem: async () => ({}), putItem: async () => ({}), query: async () => ({ Items: [] }),
    getItem: async () => ({ Item: { kind: 'bridge', ttl: Math.floor(Date.now() / 1000) + left } }) };
  const { routes } = createAccounts({ env: { OPEN_REGISTRATION: 'true' }, table, devices: { list: async () => [] }, sockets: {}, log() {},
    auth: { accountId: async () => 'self', currentKey: async () => 'k' } });
  const register = routes.find((r) => r.path === '/api/account/register').handler;
  const body = { accountId: '0123456789abcdef', joinSecret: 'j'.repeat(22), fp: 'f'.repeat(16), deviceName: 'iPhone', code: 'c'.repeat(22) };
  const call = () => register({ body, headers: new Headers(), clientIp: '1.2.3.4' }).then(() => 'ok', (e) => e.status);
  left = 20; assert.equal(await call(), 404);
  left = 100; assert.equal(await call(), 'ok');
});
