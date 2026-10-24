import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureDeviceCredential } from '../../bridge/config.mjs';

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('a master key is exchanged once for a device-bound credential', async () => {
  const config = { server: 'https://baton.test/v1', apiKey: 'master', deviceName: 'mac-mini', deviceDisplayName: 'Studio' };
  const requests = [];
  const saved = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return reply(200, { apiKey: 'bt_device' });
  };
  assert.equal(await ensureDeviceCredential(config, { fetchImpl, save: value => saved.push({ ...value }) }), true);
  assert.equal(requests[0].url, 'https://baton.test/v1/api/auth/bridge-credential');
  assert.equal(requests[0].init.headers['x-api-key'], 'master');
  assert.deepEqual(JSON.parse(requests[0].init.body), { device: 'mac-mini', name: 'Studio' });
  assert.equal(config.apiKey, 'bt_device');
  assert.equal(saved[0].apiKey, 'bt_device');

  assert.equal(await ensureDeviceCredential(config, { fetchImpl, save: () => assert.fail('saved twice') }), false);
  assert.equal(requests.length, 1);
});

test('an older server or a failed request keeps the existing key', async () => {
  for (const fetchImpl of [
    async () => reply(404, {}),
    async () => reply(200, { apiKey: 'unexpected' }),
    async () => { throw new Error('offline'); },
  ]) {
    const config = { server: 'https://baton.test/v1', apiKey: 'master', deviceName: 'mac' };
    assert.equal(await ensureDeviceCredential(config, { fetchImpl, save: () => assert.fail('saved') }), false);
    assert.equal(config.apiKey, 'master');
  }
});
