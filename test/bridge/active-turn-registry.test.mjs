import assert from 'node:assert/strict';
import test from 'node:test';

import { ActiveTurnRegistry } from '../../bridge/active-turn-registry.mjs';

test('registry tracks and discards active turns', () => {
  const registry = new ActiveTurnRegistry();
  const first = { name: 'first' };
  const second = { name: 'second' };

  assert.equal(registry.register('session-1', 'turn-1', first), true);
  assert.equal(registry.register('session-1', 'turn-2', second), true);
  assert.equal(registry.get('session-1', 'turn-1'), first);
  assert.equal(registry.get('session-1', 'turn-2'), second);

  assert.equal(registry.discard('session-1', 'turn-1'), true);
  assert.equal(registry.get('session-1', 'turn-1'), null);
  assert.equal(registry.get('session-1', 'turn-2'), second);
});

test('invalid registrations do not create state', () => {
  const registry = new ActiveTurnRegistry();
  assert.equal(registry.register('', 'turn-1', {}), false);
  assert.equal(registry.register('session-1', '', {}), false);
  assert.equal(registry.register('session-1', 'turn-1', null), false);
  assert.equal(registry.get('session-1', 'turn-1'), null);
});
