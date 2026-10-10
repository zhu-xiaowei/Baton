import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createPreviewBridge } from '../../bridge/preview-bridge.mjs';

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for preview data');
}

test('Bridge streams a large HTTP response in bounded frames through a loopback port', async () => {
  const body = Buffer.alloc(1024 * 1024, 'x');
  const response = Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`),
    body,
  ]);
  const request = Buffer.from('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
  const server = net.createServer(socket => {
    let incoming = Buffer.alloc(0);
    let responded = false;
    socket.on('data', bytes => {
      incoming = Buffer.concat([incoming, bytes]);
      if (!responded && incoming.includes('\r\n\r\n')) {
        responded = true;
        assert.equal(Buffer.compare(incoming, request), 0);
        socket.end(response);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const tunnelId = randomUUID();
  const streamId = randomUUID();
  const received = [];
  let closed = false;
  let channel;

  class FakeChannel extends EventTarget {
    readyState = 1;
    send(message) {
      if (message.type === 'bytes') {
        received.push(Buffer.from(message.data, 'base64'));
        queueMicrotask(() => this.dispatchEvent(Object.assign(new Event('message'), {
          data: { type: 'ack', streamId, seq: message.seq },
        })));
      }
      if (message.type === 'fin') closed = true;
      return true;
    }
    authorize() {}
    close() { this.readyState = 3; }
    deliver(message) {
      this.dispatchEvent(Object.assign(new Event('message'), { data: message }));
    }
  }
  const manager = createPreviewBridge({
    key: 'test', device: 'test-ec2', sendControl: () => true,
    channelFactory: () => (channel = new FakeChannel()),
  });
  try {
    manager.handle({ action: 'preview_tunnel', v: 1, type: 'offer',
      tunnelId, device: 'test-ec2', side: 'bridge', port });
    channel.deliver({ type: 'open', streamId });
    await waitFor(() => manager && channel.readyState === 1);
    const midpoint = Math.floor(request.length / 2);
    channel.deliver({ type: 'bytes', streamId, seq: 2,
      data: request.subarray(midpoint).toString('base64') });
    channel.deliver({ type: 'bytes', streamId, seq: 1,
      data: request.subarray(0, midpoint).toString('base64') });
    await waitFor(() => closed);
    assert.equal(Buffer.compare(Buffer.concat(received), response), 0);
    assert.ok(received.length > 32);
    assert.ok(received.every(chunk => chunk.length <= 16 * 1024));
  } finally {
    manager.dispose();
    server.close();
  }
});

test('Bridge preserves duplex bytes after an HTTP WebSocket upgrade', async () => {
  const server = net.createServer(socket => {
    let upgraded = false;
    socket.on('data', bytes => {
      if (!upgraded) {
        assert.match(bytes.toString(), /Upgrade: websocket/i);
        upgraded = true;
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      } else {
        socket.write(bytes);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const received = [];
  const streamId = randomUUID();
  const tunnelId = randomUUID();
  let channel;
  class FakeChannel extends EventTarget {
    readyState = 1;
    send(message) {
      if (message.type === 'bytes') {
        received.push(Buffer.from(message.data, 'base64'));
        queueMicrotask(() => this.deliver({ type: 'ack', streamId, seq: message.seq }));
      }
      return true;
    }
    authorize() {}
    close() { this.readyState = 3; }
    deliver(data) {
      this.dispatchEvent(Object.assign(new Event('message'), { data }));
    }
  }
  const manager = createPreviewBridge({
    key: 'test', device: 'test-ec2', sendControl: () => true,
    channelFactory: () => (channel = new FakeChannel()),
  });
  try {
    manager.handle({ action: 'preview_tunnel', v: 1, type: 'offer',
      tunnelId, device: 'test-ec2', side: 'bridge', port: server.address().port });
    channel.deliver({ type: 'open', streamId });
    channel.deliver({ type: 'bytes', streamId, seq: 1,
      data: Buffer.from('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n').toString('base64') });
    await waitFor(() => Buffer.concat(received).includes('101 Switching Protocols'));
    const frame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
    channel.deliver({ type: 'bytes', streamId, seq: 2, data: frame.toString('base64') });
    await waitFor(() => Buffer.concat(received).subarray(-frame.length).equals(frame));
  } finally {
    manager.dispose();
    server.close();
  }
});
