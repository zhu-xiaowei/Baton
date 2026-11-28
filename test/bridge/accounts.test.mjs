import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { join } from '../../bridge/accounts.mjs';
import * as browser from '../../bridge/e2ee.mjs';
import * as node from '../../bridge/e2ee-node.mjs';
import { fromPhrase, toPhrase } from '../../web/js/v2/recovery.js';

test('a computer joins with K sealed by an App under the QR code secret, and checks the account key', async () => {
  const k = randomBytes(32);
  assert.deepEqual(node.accountOf(k), await browser.accountOf(k));
  const head = node.fingerprint(k);
  for (const claimed of [head, 'f'.repeat(16)]) {
    const printed = [];
    let polls = 0;
    let code;
    const fetchImpl = async (url, { body }) => {
      // The link's one secret: the App derives the same code from it and seals K under it.
      const p = () => Buffer.from(new URLSearchParams(printed.find((line) => line.startsWith('Start URL: https://w/#j=')).split('#')[1]).get('j'), 'base64url');
      code ??= JSON.parse(body).code;
      const reply = url.endsWith('/start') ? { code, poll: 'poll-1', expiresIn: 600, web: 'https://w' }
        : ++polls === 1 ? { pending: true }
          : { token: 'bt_x', head: claimed, approvedBy: 'iPhone', sealed: await browser.sealPair(p(), k, await browser.pairCode(p())) };
      return { ok: true, json: async () => reply };
    };
    const joining = join({ server: 'https://s/v1', deviceName: 'Mac' }, { print: (line) => printed.push(line), sleep: async () => {}, fetchImpl });
    if (claimed !== head) { await assert.rejects(joining, /not joining/); continue; }
    const config = await joining;
    assert.equal(config.apiKey, 'bt_x');
    assert.ok(Buffer.from(config.accountKey, 'base64').equals(k) && config.accounts && printed.at(-1).includes('iPhone'));
  }
  assert.equal(node.openPair(randomBytes(16), node.sealPair(randomBytes(16), k, 'c'), 'c'), null);
});

test('recovery made on either side opens on the other; the recovery phrase is standard BIP-39', async () => {
  const k = randomBytes(32), r = randomBytes(32), { accountId } = node.accountOf(k);
  const made = await browser.recoveryOf(r, k);
  assert.ok(node.openRecovery(r, made.keySealed, accountId).equals(k));
  assert.equal(node.openRecovery(randomBytes(32), made.keySealed, accountId), null);
  const renewed = node.recoveryOf(r, k); // a computer's, after a removal
  assert.deepEqual(await browser.openPhrase(await browser.importAccountKey(k), renewed.phraseSealed), new Uint8Array(r));
  assert.equal(renewed.joinSecret, made.joinSecret);
  assert.equal(await toPhrase(new Uint8Array(32)), 'abandon '.repeat(23) + 'art');
  assert.deepEqual(await fromPhrase(await toPhrase(k)), new Uint8Array(k));
  assert.equal(await fromPhrase('abandon '.repeat(24)), null);
});
