import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { createPreviewBridge } from '../../bridge/preview-bridge.mjs';

// The stream channel ws.mjs gives a preview session; App frames arrive through `handle`.
function fakeChannel(onSend) {
  return { readyState: 1, bufferedAmount: 0, follow() {}, close() { this.readyState = 3; },
    send(message) { onSend(message); return true; } };
}

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
  let manager;
  const deliver = (m) => manager.handle({ id: tunnelId, m });
  const channel = fakeChannel((message) => {
    if (message.type === 'bytes') {
      received.push(Buffer.from(message.data, 'base64'));
      queueMicrotask(() => deliver({ type: 'ack', streamId, seq: message.seq }));
    }
    if (message.type === 'fin') closed = true;
  });
  manager = createPreviewBridge({ channel: () => channel });
  try {
    deliver({ type: 'start', port });
    deliver({ type: 'open', streamId });
        const midpoint = Math.floor(request.length / 2);
    deliver({ type: 'bytes', streamId, seq: 2,
      data: request.subarray(midpoint).toString('base64') });
    deliver({ type: 'bytes', streamId, seq: 1,
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
  let manager;
  const deliver = (m) => manager.handle({ id: tunnelId, m });
  const channel = fakeChannel((message) => {
    if (message.type === 'bytes') {
      received.push(Buffer.from(message.data, 'base64'));
      queueMicrotask(() => deliver({ type: 'ack', streamId, seq: message.seq }));
    }
  });
  manager = createPreviewBridge({ channel: () => channel });
  try {
    deliver({ type: 'start', port: server.address().port });
    deliver({ type: 'open', streamId });
    deliver({ type: 'bytes', streamId, seq: 1,
      data: Buffer.from('GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n').toString('base64') });
    await waitFor(() => Buffer.concat(received).includes('101 Switching Protocols'));
    const frame = Buffer.from([0x81, 0x02, 0x68, 0x69]);
    deliver({ type: 'bytes', streamId, seq: 2, data: frame.toString('base64') });
    await waitFor(() => Buffer.concat(received).subarray(-frame.length).equals(frame));
  } finally {
    manager.dispose();
    server.close();
  }
});
