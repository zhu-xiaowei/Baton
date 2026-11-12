import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { RpcAssembler, decodeRpcPayload, rpcResultFrames } from '../../bridge/direct-rpc-protocol.mjs';
import { appKeys, importAccountKey } from '../../bridge/e2ee.mjs';
import { bridgeKeys } from '../../bridge/e2ee-node.mjs';

test('App (WebCrypto) and Bridge (node:crypto) seal for each other; tamper, wrong K and replay fail', async () => {
  const k = randomBytes(32);
  const bridge = bridgeKeys(k);
  const app = await appKeys(await importAccountKey(k));
  assert.equal(app.fp, bridge.fp);
  const toApp = await app.session(bridge.pub);
  const frame = { kind: 'rpc', method: 'home', requestId: 'r1' };
  const sealed = await toApp.seal(frame, new TextEncoder().encode('hi'));
  assert.equal(new TextDecoder().decode(bridge.session(app.pub).open(frame, sealed).body), 'hi');
  assert.equal(bridge.session(app.pub).open(frame, sealed), null); // replay
  assert.equal(bridge.session(app.pub).open({ ...frame, method: 'x' }, await toApp.seal(frame, new Uint8Array(1))), null);
  const [reply] = rpcResultFrames('r1', { ok: 1 }, { deflate: deflateRawSync, method: 'home', seal: bridge.session(app.pub).seal });
  const part = new RpcAssembler().add(JSON.parse(JSON.stringify(reply)));
  assert.deepEqual(await decodeRpcPayload(part.payload, inflateRawSync, toApp.open), { ok: 1 });
  const stranger = await (await appKeys(await importAccountKey(randomBytes(32)))).session(bridge.pub);
  assert.equal(await stranger.open(part.payload.head, part.payload.data), null);
});
