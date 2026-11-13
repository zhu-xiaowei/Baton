import assert from 'node:assert/strict';
import test from 'node:test';
import { getRuntimeAdapter, registerInstalledRuntimes } from '../../bridge/runtime-registry.mjs';

test('optional runtimes load only when installed and never break discovery', async () => {
  const mod = 'data:text/javascript,import{defineRuntimeAdapter}from"' + new URL('../../bridge/runtime-adapter.mjs', import.meta.url)
    + '";export default defineRuntimeAdapter({runtime:"fake",displayName:"Fake",discover(){throw new Error("old schema")},findSessionFile(){return null},baselineToEnd(){}})';
  await registerInstalledRuntimes([[mod, () => false], ['./missing-runtime.mjs', () => true]]);
  assert.throws(() => getRuntimeAdapter('fake'));
  await registerInstalledRuntimes([[mod, () => true]]);
  assert.deepEqual(getRuntimeAdapter('fake').discover({}).sessions, []);
});
