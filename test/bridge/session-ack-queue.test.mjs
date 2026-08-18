import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionAckQueue } from '../../bridge/session-ack-queue.mjs';

test('serializes acknowledged sends within one session', async () => {
  const sent = [];
  var nextId = 0;
  const queue = new SessionAckQueue({
    send: (message) => {
      sent.push(message);
      return true;
    },
    createDeliveryId: () => `delivery-${++nextId}`,
  });

  const first = queue.enqueue({ sessionId: 's1', id: 'first' });
  const second = queue.enqueue({ sessionId: 's1', id: 'second' });

  assert.deepEqual(sent.map((message) => message.id), ['first']);
  assert.equal(queue.acknowledge('s1', 'delivery-1'), true);
  assert.equal(await first, true);
  assert.deepEqual(sent.map((message) => message.id), ['first', 'second']);
  assert.equal(queue.acknowledge('s1', 'delivery-2'), true);
  assert.equal(await second, true);
});

test('allows different sessions to send in parallel', async () => {
  const sent = [];
  var nextId = 0;
  const queue = new SessionAckQueue({
    send: (message) => {
      sent.push(message);
      return true;
    },
    createDeliveryId: () => `delivery-${++nextId}`,
  });

  const first = queue.enqueue({ sessionId: 's1', id: 'one' });
  const second = queue.enqueue({ sessionId: 's2', id: 'two' });

  assert.deepEqual(sent.map((message) => message.id), ['one', 'two']);
  queue.acknowledge('s2', 'delivery-2');
  queue.acknowledge('s1', 'delivery-1');
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('advances after timeout without dropping the next send', async () => {
  const sent = [];
  const timers = [];
  var nextId = 0;
  const queue = new SessionAckQueue({
    send: (message) => {
      sent.push(message);
      return true;
    },
    createDeliveryId: () => `delivery-${++nextId}`,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimer: () => {},
  });

  const first = queue.enqueue({ sessionId: 's1', id: 'first' });
  const second = queue.enqueue({ sessionId: 's1', id: 'second' });

  timers[0]();
  assert.equal(await first, false);
  assert.deepEqual(sent.map((message) => message.id), ['first', 'second']);
  queue.acknowledge('s1', 'delivery-2');
  assert.equal(await second, true);
});

test('a late ack cannot confirm the next request after timeout', async () => {
  const timers = [];
  var nextId = 0;
  const queue = new SessionAckQueue({
    send: () => true,
    createDeliveryId: () => `delivery-${++nextId}`,
    setTimer: (callback) => {
      timers.push(callback);
      return timers.length - 1;
    },
    clearTimer: () => {},
  });

  const first = queue.enqueue({ sessionId: 's1', id: 'first' });
  const second = queue.enqueue({ sessionId: 's1', id: 'second' });

  timers[0]();
  assert.equal(await first, false);
  assert.equal(queue.acknowledge('s1', 'delivery-1'), false);
  assert.equal(queue.acknowledge('s1', 'delivery-2'), true);
  assert.equal(await second, true);
});

test('advances when the transport cannot send', async () => {
  const sent = [];
  var nextId = 0;
  const queue = new SessionAckQueue({
    send: (message) => {
      sent.push(message.id);
      return message.id !== 'first';
    },
    createDeliveryId: () => `delivery-${++nextId}`,
  });

  const first = queue.enqueue({ sessionId: 's1', id: 'first' });
  const second = queue.enqueue({ sessionId: 's1', id: 'second' });

  assert.equal(await first, false);
  assert.deepEqual(sent, ['first', 'second']);
  queue.acknowledge('s1', 'delivery-2');
  assert.equal(await second, true);
});

test('clear resolves active and pending sends as failed', async () => {
  const queue = new SessionAckQueue({ send: () => true });
  const first = queue.enqueue({ sessionId: 's1', id: 'first' });
  const second = queue.enqueue({ sessionId: 's1', id: 'second' });

  queue.clear();

  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(queue.acknowledge('s1', 'delivery-1'), false);
});
