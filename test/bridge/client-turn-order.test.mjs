import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ClientTurnOrder,
} from '../../bridge/client-turn-order.mjs';

test('reversed delivery is reordered before messages reach the runtime', async () => {
  const order = new ClientTurnOrder();
  const started = [];

  const third = order.run({
    turnId: 'turn-3',
    previousTurnId: 'turn-2',
  }, async () => {
    started.push('turn-3');
  });
  const second = order.run({
    turnId: 'turn-2',
    previousTurnId: 'turn-1',
  }, async () => {
    started.push('turn-2');
  });
  const first = order.run({
    turnId: 'turn-1',
  }, async () => {
    started.push('turn-1');
  });

  await Promise.all([first, second, third]);
  assert.deepEqual(started, ['turn-1', 'turn-2', 'turn-3']);
});

test('a missing predecessor times out and clears its waiter', async () => {
  const order = new ClientTurnOrder({ waitTimeoutMs: 10 });
  let submitted = false;

  await assert.rejects(
    order.run({
      turnId: 'turn-2',
      previousTurnId: 'missing-turn',
    }, async () => {
      submitted = true;
    }),
    (error) => error.code === 'previous_turn_missing'
      && error.previousTurnId === 'missing-turn',
  );

  assert.equal(submitted, false);
  assert.equal(order.waiters.size, 0);
});

test('a received predecessor can take longer than the arrival timeout to submit', async () => {
  const order = new ClientTurnOrder({ waitTimeoutMs: 10 });
  const started = [];
  let release;
  const preparing = new Promise(resolve => { release = resolve; });
  const first = order.run({ turnId: 'turn-1' }, async () => {
    started.push('turn-1');
    await preparing;
  });
  const second = order.run({
    turnId: 'turn-2',
    previousTurnId: 'turn-1',
  }, async () => { started.push('turn-2'); });
  const completion = Promise.all([first, second]);
  completion.catch(() => {});

  await delay(30);
  assert.deepEqual(started, ['turn-1']);
  release();
  await completion;
  assert.deepEqual(started, ['turn-1', 'turn-2']);
  assert.equal(order.waiters.size, 0);
});

test('a predecessor arriving out of order stops the arrival timeout', async () => {
  const order = new ClientTurnOrder({ waitTimeoutMs: 10 });
  const started = [];
  let release;
  const preparing = new Promise(resolve => { release = resolve; });
  const second = order.run({
    turnId: 'turn-2',
    previousTurnId: 'turn-1',
  }, async () => { started.push('turn-2'); });
  const first = order.run({ turnId: 'turn-1' }, async () => {
    started.push('turn-1');
    await preparing;
  });
  const completion = Promise.all([first, second]);
  completion.catch(() => {});

  await delay(30);
  assert.deepEqual(started, ['turn-1']);
  release();
  await completion;
  assert.deepEqual(started, ['turn-1', 'turn-2']);
  assert.equal(order.waiters.size, 0);
});

test('a missing ancestor fails its waiting chain and allows the same turns to retry', async () => {
  const order = new ClientTurnOrder({ waitTimeoutMs: 10 });
  const started = [];
  const second = order.run({
    turnId: 'turn-2',
    previousTurnId: 'turn-1',
  }, async () => { started.push('turn-2'); });
  const third = order.run({
    turnId: 'turn-3',
    previousTurnId: 'turn-2',
  }, async () => { started.push('turn-3'); });
  const results = await Promise.allSettled([second, third]);
  assert.ok(results.every(result =>
    result.status === 'rejected' && result.reason.code === 'previous_turn_missing'));
  assert.deepEqual(started, []);
  assert.equal(order.waiters.size, 0);
  assert.equal(order.submitted.size, 0);

  await order.run({ turnId: 'turn-1' }, async () => { started.push('turn-1'); });
  await order.run({ turnId: 'turn-2', previousTurnId: 'turn-1' }, async () => {
    started.push('turn-2');
  });
  await order.run({ turnId: 'turn-3', previousTurnId: 'turn-2' }, async () => {
    started.push('turn-3');
  });
  assert.deepEqual(started, ['turn-1', 'turn-2', 'turn-3']);
});
