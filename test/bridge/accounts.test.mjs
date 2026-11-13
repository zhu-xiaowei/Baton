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
    const fetchImpl = async (url) => {
      const link = () => new URL(printed.find((line) => line.includes('#j=')).replace('#', '?')).searchParams;
      const reply = url.endsWith('/start') ? { code: 'code-1', poll: 'poll-1', expiresIn: 600 }
        : ++polls === 1 ? { pending: true }
          : { token: 'bt_x', head: claimed, approvedBy: 'iPhone',
            sealed: await browser.sealPair(Buffer.from(link().get('t'), 'base64url'), k, link().get('j')) };
      return { ok: true, json: async () => reply };
    };
    const joining = join({ server: 'https://s/v1', deviceName: 'Mac' }, { print: (line) => printed.push(line), sleep: async () => {}, fetchImpl });
    if (claimed !== head) { await assert.rejects(joining, /does not belong/); continue; }
    const config = await joining;
    assert.equal(config.apiKey, 'bt_x');
    assert.ok(Buffer.from(config.accountKey, 'base64').equals(k) && config.accounts && printed.at(-1).includes('iPhone'));
  }
  assert.equal(node.openPair(randomBytes(16), node.sealPair(randomBytes(16), k, 'c'), 'c'), null);
});

test('a rotation sealed by an App opens on a Bridge; the recovery phrase is standard BIP-39', async () => {
  const k = randomBytes(32), next = randomBytes(32);
  const fp = node.fingerprint(k);
  const sealed = await browser.sealRotation(await browser.importAccountKey(k), next, fp);
  assert.ok(node.openRotation(k, sealed, fp).equals(next));
  assert.equal(node.openRotation(k, sealed, 'f'.repeat(16)), null);
  assert.equal(await toPhrase(new Uint8Array(32)), 'abandon '.repeat(23) + 'art');
  assert.deepEqual(await fromPhrase(await toPhrase(k)), new Uint8Array(k));
  assert.equal(await fromPhrase('abandon '.repeat(24)), null);
});
