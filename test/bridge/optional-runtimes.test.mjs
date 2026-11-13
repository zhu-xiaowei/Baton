import assert from 'node:assert/strict';
import test from 'node:test';
import { getRuntimeAdapter, registerInstalledRuntimes } from '../../bridge/runtime-registry.mjs';

test('optional runtimes load only when installed', async () => {
  const mod = 'data:text/javascript,export default { runtime: "fake", id: "fake", label: "Fake", features: {}, discover() { throw new Error("old schema"); } }';
  await registerInstalledRuntimes([[mod, () => false], ['./missing-runtime.mjs', () => true]]);
  assert.throws(() => getRuntimeAdapter('fake'));
  await registerInstalledRuntimes([[mod, () => true]]);
  assert.deepEqual(getRuntimeAdapter('fake').discover({}).sessions, []);
});
