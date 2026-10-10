import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PreviewTunnel } from '../../web/js/preview-transport.js';

test('native TCP connection opens a preview stream with its UUID', () => {
  const sent = [];
  const tunnel = new PreviewTunnel({
    device: 'test-ec2', target: { port: 5173 },
    wsUrl: 'wss://example.test/ws', key: 'test',
  });
  tunnel.channel = { send(message) { sent.push(message); return true; } };
  const streamId = crypto.randomUUID();

  tunnel.nativeOpen({ tunnelId: tunnel.localId, streamId });

  assert.equal(tunnel.streams.size, 1);
  assert.deepEqual(sent, [{ type: 'open', streamId }]);
});
