import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { authenticateFrame, createHeaderSigner, verifyFrame } from '../../bridge/terminal-direct-protocol.mjs';
import { PreviewDataChannel, validatePreviewMessage } from '../../bridge/preview-protocol.mjs';

test('a full 16 KiB preview chunk fits inside the signed API Gateway frame', async () => {
  const message = validatePreviewMessage({
    type: 'bytes', streamId: randomUUID(), seq: 1,
    data: Buffer.alloc(16 * 1024, 0xff).toString('base64'),
  }, 'bridge');
  assert.throws(() => validatePreviewMessage({
    ...message, data: Buffer.alloc(16 * 1024 + 1).toString('base64'),
  }, 'bridge'), /Invalid preview data/);
  const payload = JSON.stringify({
    action: 'preview_frame', v: 1, tunnelId: randomUUID(),
    device: 'test-ec2', message,
  });
  const frameKey = 'a'.repeat(64);
  const body = JSON.stringify(await authenticateFrame(payload, frameKey));
  const sign = createHeaderSigner({
    endpoint: 'https://example.execute-api.ap-northeast-1.amazonaws.com/v1',
    region: 'ap-northeast-1', target: 'connection123',
    action: 'preview_data',
    credentials: {
      accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret',
      sessionToken: 't'.repeat(1500),
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    },
  });
  const signed = JSON.parse(await sign(body));
  assert.ok(Buffer.byteLength(JSON.stringify(signed)) <= 28 * 1024);
  assert.equal(signed.action, 'preview_data');
  assert.equal(signed.target, 'connection123');
  assert.ok(await verifyFrame(JSON.parse(signed.body), frameKey));
  assert.equal(JSON.parse(JSON.parse(signed.body).payload).message.data, message.data);
});

test('paired preview channels verify signed data and reject a forged frame', async () => {
  class FakeSocket extends EventTarget {
    readyState = 0;
    sent = [];
    send(value) {
      const frame = JSON.parse(value);
      this.sent.push(frame);
      if (frame.action === 'preview_data') {
        queueMicrotask(() => this.peer.dispatchEvent(Object.assign(new Event('message'), {
          data: frame.body,
        })));
      }
    }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  const appSocket = new FakeSocket();
  const bridgeSocket = new FakeSocket();
  appSocket.peer = bridgeSocket;
  bridgeSocket.peer = appSocket;
  const tunnelId = randomUUID();
  const common = {
    tunnelId, device: 'test-ec2', port: 5173,
    dataEndpoint: 'https://example.execute-api.ap-northeast-1.amazonaws.com/v1',
  };
  const app = new PreviewDataChannel({
    key: 'test', offer: { ...common, side: 'app', joinToken: 'a'.repeat(64) },
    socketFactory: () => appSocket,
  });
  const bridge = new PreviewDataChannel({
    key: 'test', offer: { ...common, side: 'bridge', joinToken: 'b'.repeat(64) },
    socketFactory: () => bridgeSocket,
  });
  try {
    appSocket.open();
    bridgeSocket.open();
    assert.equal(appSocket.sent[0].op, 'join');
    assert.equal(bridgeSocket.sent[0].op, 'join');
    const credentials = {
      accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 'secret',
      sessionToken: 't'.repeat(1000),
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    };
    for (const [channel, side, connectionId, peerConnectionId] of [
      [app, 'app', 'app123', 'bridge123'],
      [bridge, 'bridge', 'bridge123', 'app123'],
    ]) {
      channel.authorize({
        ...common, side, connectionId, peerConnectionId,
        endpoint: common.dataEndpoint, region: 'ap-northeast-1',
        credentials, frameKey: 'f'.repeat(64),
      });
    }
    const streamId = randomUUID();
    const received = new Promise(resolve => bridge.addEventListener('message', event => resolve(event.data), { once: true }));
    assert.equal(app.send({ type: 'open', streamId }), true);
    assert.deepEqual(await received, { type: 'open', streamId });
    assert.equal(appSocket.sent[1].action, 'preview_data');
    assert.equal(appSocket.sent[1].target, 'bridge123');
    const failed = new Promise(resolve => bridge.addEventListener('error', event => resolve(event.data), { once: true }));
    bridgeSocket.dispatchEvent(Object.assign(new Event('message'), {
      data: JSON.stringify({ payload: '{}', mac: '0'.repeat(64) }),
    }));
    assert.match(await failed, /Invalid preview frame/);
  } finally {
    app.close();
    bridge.close();
  }
});
