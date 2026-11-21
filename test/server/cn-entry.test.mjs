import assert from 'node:assert/strict';
import test from 'node:test';
import { pickEntry, viaEntry } from '../../bridge/entry.mjs';
import { locationHint } from '../../server/core/accounts.mjs';

test('callers in CN use a relay that answers, everyone else the API host', async () => {
  const replies = { 'https://api': { version: '1', country: 'CN', entries: ['https://dead', 'https://jp'] }, 'https://jp': { version: '1' } };
  const fetchImpl = async (url) => { const r = replies[url.replace('/api/version', '')]; if (!r) throw new Error('down'); return { json: async () => r }; };
  assert.equal(await pickEntry('https://api', fetchImpl), 'https://jp');
  replies['https://api'].country = 'JP';
  assert.equal(await pickEntry('https://api', fetchImpl), 'https://api');
  assert.equal(viaEntry('wss://api.x/ws?a=1', 'https://api.x', 'https://jp.x'), 'wss://jp.x/ws?a=1');
});

test('a new account goes near the entry of its first computer', () => {
  assert.deepEqual([{ relay: true, continent: 'EU' }, { continent: 'NA', lon: -122 }, { continent: 'NA', lon: -77 }, {}].map(locationHint),
    ['apac', 'wnam', 'enam', undefined]);
});
