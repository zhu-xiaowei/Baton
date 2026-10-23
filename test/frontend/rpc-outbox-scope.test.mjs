import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { requestProjectDownload } from '../../web/js/project/download-request.js';
import { handleProjectFilesMessage } from '../../web/js/project/rpc.js';

test('real WS outbox drops stale-account and aborted RPCs but sends current work', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: '__new__', mode: 'new' });
  h.state.SERVER = 'https://server.test';
  h.state.KEY = 'old-account';
  h.state.WS_URL = 'wss://socket.test/ws';
  h.state.ws = null;
  globalThis.localStorage = h.window.localStorage;
  globalThis.showWsBanner = h.window.showWsBanner = () => {};
  const sockets = [];
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = h.window.WebSocket = Socket;
  const fields = { device: 'Mac', projectHash: 'project', path: 'file.txt' };
  try {
    const stale = requestProjectDownload(fields);
    const rejected = assert.rejects(stale, /account or server changed/);
    h.state.KEY = 'new-account';
    const controller = new AbortController();
    const aborted = requestProjectDownload(fields, { signal: controller.signal });
    const abortedCheck = assert.rejects(aborted, { name: 'AbortError' });
    controller.abort();
    const current = requestProjectDownload(fields);
    assert.equal(sockets.length, 1);
    sockets[0].readyState = Socket.OPEN;
    sockets[0].onopen();
    await rejected;
    const downloads = sockets[0].sent.filter(message => message.action === 'project_files');
    assert.deepEqual(downloads.map(message => message.operation), ['cancel_download', 'download']);
    for (const message of downloads) {
      handleProjectFilesMessage({ ...message, ok: true,
        ...(message.operation === 'cancel_download' ? { status: 'cancelled' } : { key: 'current-file' }) });
    }
    await abortedCheck;
    assert.equal((await current).key, 'current-file');
  } finally {
    h.window.disconnectWs();
    h.window.close();
  }
});
