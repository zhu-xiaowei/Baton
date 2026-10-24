import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const apiSource = readFileSync(new URL('../../web/js/api.js', import.meta.url), 'utf8');

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return source.slice(from, to);
}

function harness({ key = '', account = '', pathname = '/index.html', fetchImpl,
  userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', host = { __TAURI_INTERNALS__: {} } } = {}) {
  const storage = new Map();
  if (key) storage.set('_ak', Buffer.from(key).toString('base64'));
  if (account) storage.set('_aid', account);
  const context = {
    state: { KEY: key, SERVER: 'https://baton.test', ACCOUNT: account },
    cleared: 0,
    requests: [],
    localStorage: {
      getItem: name => (storage.has(name) ? storage.get(name) : null),
      setItem: (name, value) => storage.set(name, String(value)),
      removeItem: name => storage.delete(name),
    },
    location: { pathname },
    navigator: { userAgent },
    window: host,
    btoa: value => Buffer.from(value).toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString(),
    Date,
    Number,
    String,
    JSON,
    Error,
  };
  context.fetch = async (url, init) => {
    context.requests.push({ url, init });
    return fetchImpl(url, init);
  };
  vm.createContext(context);
  vm.runInContext(`
    function clearCachedAccountData() { cleared++; }
    ${slice(apiSource, 'var DEVICE_CREDENTIAL_PREFIX', 'function clearCachedAccountData')}
    ${slice(apiSource, '// Account data is kept', 'function logout')}
    this.api = { setCredentials, upgradeStoredCredential, credentialName };
  `, context);
  context.storage = storage;
  return context;
}

const json = (status, body) => ({ ok: status < 300, status, statusText: String(status), json: async () => body });

test('a stored master key is upgraded to an app credential without clearing account data', async () => {
  const context = harness({ key: 'master', fetchImpl: async () => json(200, { apiKey: 'bt_phone', accountId: 'acct' }) });
  context.api.upgradeStoredCredential();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(context.requests[0].url, 'https://baton.test/api/auth/app-credential');
  assert.equal(context.requests[0].init.headers['x-api-key'], 'master');
  assert.deepEqual(JSON.parse(context.requests[0].init.body), { name: 'Baton app · iOS' });
  assert.equal(context.state.KEY, 'bt_phone');
  assert.equal(context.state.ACCOUNT, 'acct');
  assert.equal(context.storage.get('_aid'), 'acct');
  assert.equal(context.cleared, 0);
  assert.equal(context.storage.has('_akm'), false);
});

test('device credentials, the landing page and older servers are left alone', async () => {
  for (const options of [{ key: 'bt_phone' }, { key: 'master', pathname: '/landing.html' }]) {
    const context = harness({ ...options, fetchImpl: async () => assert.fail('requested') });
    context.api.upgradeStoredCredential();
  }
  const old = harness({ key: 'master', fetchImpl: async () => json(404, {}) });
  old.api.upgradeStoredCredential();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(old.state.KEY, 'master');
});

test('switching accounts still clears cached data', () => {
  const context = harness({ key: 'bt_a', account: 'one', fetchImpl: async () => assert.fail('requested') });
  context.api.setCredentials('bt_b', null, 'one');
  assert.equal(context.cleared, 0);
  context.api.setCredentials('bt_c', null, 'two');
  assert.equal(context.cleared, 1);
  context.api.setCredentials('legacy', null, '');
  assert.equal(context.cleared, 2);
  assert.equal(context.storage.has('_aid'), false);
});

test('credential names tell the native shells from browsers', () => {
  const fetchImpl = async () => assert.fail('requested');
  const harmony = 'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 ArkWeb/4.1.6.1 Mobile';
  assert.equal(harness({ fetchImpl, userAgent: harmony, host: { harmonyBridge: {} } }).api.credentialName(),
    'Baton app · HarmonyOS');
  assert.equal(harness({ fetchImpl, userAgent: harmony, host: {} }).api.credentialName(), 'Browser · HarmonyOS');
  assert.equal(harness({ fetchImpl, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', host: {} })
    .api.credentialName(), 'Browser · macOS');
});
