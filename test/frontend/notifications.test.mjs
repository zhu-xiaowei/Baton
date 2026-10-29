import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import {
  createForegroundNotifications, validNotificationTarget,
} from '../../web/js/notification-runtime.js';

const event = {
  eventId: 'notification-one', device: 'Mac', projectHash: 'project',
  sessionId: 'codex:session', kind: 'completed',
};

test('foreground notifications establish a baseline, deduplicate, and honor preferences', async () => {
  const shown = [], scheduled = [], cursors = [];
  const controller = createForegroundNotifications({
    fetchEvents: async cursor => {
      cursors.push(cursor);
      return { cursor: 'next', events: [
        event, { ...event, eventId: 'approval', kind: 'needs_input' },
      ] };
    },
    show: async notification => shown.push(notification),
    enabled: notification => notification.kind === 'completed',
    isVisible: () => true,
    schedule: callback => scheduled.push(callback),
    cancel: () => {},
  });
  controller.start();
  await flush();
  assert.deepEqual(shown, []);
  scheduled.shift()();
  await flush();
  assert.deepEqual(shown, [event]);
  scheduled.shift()();
  await flush();
  assert.deepEqual(shown, [event]);
  assert.deepEqual(cursors, ['', 'next', 'next']);
  controller.stop();
});

test('hiding cancels pending responses and resuming starts a fresh baseline', async () => {
  let visible = true, resolve;
  const cursors = [], scheduled = [], shown = [];
  const controller = createForegroundNotifications({
    fetchEvents: cursor => {
      cursors.push(cursor);
      return new Promise(done => { resolve = done; });
    },
    show: async notification => shown.push(notification),
    isVisible: () => visible,
    schedule: callback => scheduled.push(callback),
    cancel: () => {},
  });
  controller.start();
  resolve({ events: [], cursor: 'baseline' });
  await flush();
  scheduled.shift()();
  visible = false;
  controller.stop();
  resolve({ events: [event], cursor: 'hidden' });
  await flush();
  assert.deepEqual(shown, []);
  assert.deepEqual(scheduled, []);
  visible = true;
  controller.start();
  assert.deepEqual(cursors, ['', 'baseline', '']);
  resolve({ events: [event], cursor: 'resumed' });
  await flush();
  assert.deepEqual(shown, []);
  controller.stop();
});

test('notification navigation rejects missing or malformed session targets', () => {
  assert.equal(validNotificationTarget(event), true);
  for (const invalid of [null, {}, { ...event, device: '' }, { ...event, sessionId: {} }]) {
    assert.equal(validNotificationTarget(invalid), false);
  }
});
