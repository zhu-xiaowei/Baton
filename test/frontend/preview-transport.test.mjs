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

test('first start after load waits for one native reset before starting listeners', async () => {
  const calls = [];
  let finishReset;
  globalThis.window = { __TAURI_INTERNALS__: {
    transformCallback: () => 1,
    invoke(cmd, args) {
      calls.push(cmd);
      if (cmd === 'preview_reset') return new Promise(resolve => { finishReset = resolve; });
      if (cmd === 'preview_start') return Promise.resolve(`http://127.0.0.1:${args.preferredPort}`);
      return Promise.resolve(0);
    },
  } };
  const tunnels = [5173, 5174].map(port => {
    const tunnel = new PreviewTunnel({
      device: 'test-ec2', target: { port, pathname: '/', search: '', hash: '', displayUrl: '' },
      wsUrl: 'wss://example.test/ws', key: 'test',
    });
    tunnel.pair = async () => {};
    tunnel.checkPort = async () => {};
    return tunnel;
  });

  const starts = tunnels.map(tunnel => tunnel.start());
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.filter(cmd => cmd.startsWith('preview_')), ['preview_reset']);
  finishReset();
  await Promise.all(starts);
  assert.deepEqual(calls.filter(cmd => cmd.startsWith('preview_')),
    ['preview_reset', 'preview_start', 'preview_start']);
  for (const tunnel of tunnels) clearInterval(tunnel.retransmitTimer);
  delete globalThis.window;
});
