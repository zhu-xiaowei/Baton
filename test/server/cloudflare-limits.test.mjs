import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bridgesFull, leastActive, limits } from '../../server/cloudflare/ports.mjs';

test('the 21st App closes the least recently active; a 6th Bridge is refused, a same-device one is not', () => {
  const max = limits({});
  const apps = Array.from({ length: 20 }, (_, i) => [`ws${i}`, { connectedAt: i, ...(i === 0 && { activeAt: 99 }) }]);
  assert.deepEqual(leastActive(apps, max.apps - 1).map(([ws]) => ws), ['ws1']);
  const bridges = Array.from({ length: 5 }, (_, i) => [`b${i}`, { device: `pc${i}` }]);
  assert.equal(bridgesFull(bridges, 'pc5', max.bridges), true);
  assert.equal(bridgesFull(bridges, 'pc0', max.bridges), false);
});
