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

test('a runtime installed later registers once; a failed import is not retried', async () => {
  const mod = 'data:text/javascript,import{defineRuntimeAdapter}from"' + new URL('../../bridge/runtime-adapter.mjs', import.meta.url)
    + '";export default defineRuntimeAdapter({runtime:"late",displayName:"Late",discover(){return{sessions:[]}},findSessionFile(){return null},baselineToEnd(){}})';
  let present = false;
  let checks = 0;
  const list = [[mod, () => present], ['./missing-late-runtime.mjs', () => ++checks]];
  assert.deepEqual(await registerInstalledRuntimes(list), []);
  present = true;
  const [first, second] = await Promise.all([registerInstalledRuntimes(list), registerInstalledRuntimes(list)]);
  assert.deepEqual([...first, ...second].map((adapter) => adapter.runtime), ['late']);
  assert.equal(getRuntimeAdapter('late').runtime, 'late');
  assert.equal(checks, 1);
});
