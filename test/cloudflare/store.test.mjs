import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createItems, home } from '../../server/cloudflare/store.mjs';

const sqlite = await import('node:sqlite').catch(() => null); // Node ≥ 22.5
const db = sqlite && new sqlite.DatabaseSync(':memory:');
const items = sqlite && createItems({ exec: (q, ...args) => { const s = db.prepare(q); const rows = s.columns().length ? s.all(...args) : (s.run(...args), []); return Object.assign(rows, { toArray: () => rows }); } });

test('the DynamoDB subset core uses, over SQLite', { skip: !sqlite && 'node:sqlite is unavailable' }, () => {
  const rate = { Key: { pk: 'RATE#x', sk: '1' }, UpdateExpression: 'ADD n :one SET #ttl = :ttl', ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
    ExpressionAttributeNames: { '#ttl': 'ttl' }, ExpressionAttributeValues: { ':one': 1, ':limit': 2, ':ttl': 9 } };
  items.updateItem(rate);
  assert.deepEqual(items.updateItem({ ...rate, ReturnValues: 'ALL_NEW' }).Attributes, { pk: 'RATE#x', sk: '1', n: 2, ttl: 9 });
  assert.throws(() => items.updateItem(rate), { code: 'ConditionalCheckFailedException' });
  for (const sk of ['TOKEN#b', 'META', 'TOKEN#a']) items.putItem({ Item: { pk: 'ACCOUNT#1', sk } });
  const q = { KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)', ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
    ExpressionAttributeValues: { ':pk': 'ACCOUNT#1', ':sk': 'TOKEN#' } };
  assert.deepEqual(items.query(q).Items.map((i) => i.sk), ['TOKEN#a', 'TOKEN#b']);
  assert.deepEqual(items.deleteItem({ Key: { pk: 'ACCOUNT#1', sk: 'META' }, ReturnValues: 'ALL_OLD' }).Attributes, { pk: 'ACCOUNT#1', sk: 'META' });
  assert.throws(() => items.transact([{ Delete: { Key: { pk: 'ACCOUNT#1', sk: 'TOKEN#a' } } },
    { Update: { Key: { pk: 'ACCOUNT#1', sk: 'META' }, UpdateExpression: 'SET head = :h', ConditionExpression: 'head = :h', ExpressionAttributeValues: { ':h': 'x' } } }]),
  { code: 'TransactionCanceledException' });
  assert.equal(items.query(q).Items.length, 2); // nothing applied
  assert.deepEqual([home('DEVICE#0123456789abcdef'), home('PAIR#f0'), home('JOIN#undefined')[0]], [['account', '0123456789abcdef'], ['index', 'f'], 'index']);
});
