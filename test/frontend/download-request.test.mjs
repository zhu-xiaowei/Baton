import assert from 'node:assert/strict';
import test from 'node:test';
import { state } from '../../web/js/state.js';
import { handleProjectFilesMessage } from '../../web/js/project/rpc.js';
import { captureDownloadScope, requestProjectDownload } from '../../web/js/project/download-request.js';

function setup() {
  const sent = [];
  globalThis.window = { wsSendReliable(payload, guard) { sent.push({ payload, guard }); } };
  state.SERVER = 'https://server-a.test';
  state.KEY = 'account-a';
  return {
    sent, target: { device: 'Mac', projectHash: 'project', path: 'file.txt' },
    reply(index, result) {
      const { payload } = sent[index];
      handleProjectFilesMessage({ ...payload, ok: true, ...result });
    },
  };
}

test('preparation cancellation waits for the matching device acknowledgement', async () => {
  const { sent, target, reply } = setup();
  const controller = new AbortController();
  let settled = false;
  const pending = requestProjectDownload(target, { signal: controller.signal })
    .catch(error => { settled = true; throw error; });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(new DOMException('Download cancelled', 'AbortError'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.operation, 'cancel_download');
  assert.equal(sent[0].payload.downloadToken, sent[1].payload.downloadToken);
  assert.notEqual(sent[0].payload.requestId, sent[1].payload.requestId);
  assert.equal(sent[1].payload.device, 'Mac');
  assert.equal(JSON.stringify(sent).includes('account-a'), false);
  reply(1, { status: 'cancelled' });
  await rejected;
});

test('missing or unsupported cancellation never reports confirmed cancellation', async () => {
  for (const response of [null, { ok: false, error: 'unsupported operation' }, { status: 'unknown' }]) {
    const { target, reply } = setup();
    const controller = new AbortController();
    const pending = requestProjectDownload(target, { signal: controller.signal, cancelTimeout: 10 });
    const rejected = assert.rejects(pending, { code: 'DOWNLOAD_CANCEL_UNCONFIRMED' });
    controller.abort();
    if (response) reply(1, response);
    await rejected;
  }
});

test('a completed preparation can acknowledge a concurrent cancel without starting a download', async () => {
  const { target, reply } = setup();
  const controller = new AbortController();
  const pending = requestProjectDownload(target, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  reply(1, { status: 'completed' });
  await rejected;
});

test('captured account/server scope rejects stale starts and stale results', async () => {
  for (const field of ['KEY', 'SERVER']) {
    const { target, sent, reply } = setup();
    const scope = captureDownloadScope();
    state[field] += '-different';
    await assert.rejects(requestProjectDownload(target, { scope }), /account or server changed/);
    assert.equal(sent.length, 0);
    state[field] = field === 'KEY' ? scope.accountKey : scope.server;
    let progress = false;
    const pending = requestProjectDownload(target, { scope, onProgress: () => { progress = true; } });
    const rejected = assert.rejects(pending, /account or server changed/);
    state[field] += '-different';
    reply(0, { progress: true });
    reply(0, { key: 'old-account-file' });
    await rejected;
    assert.equal(progress, false);
  }
});

test('account switch blocks cancellation from reaching the new account', async () => {
  const { target, sent } = setup();
  const controller = new AbortController();
  const pending = requestProjectDownload(target, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'DOWNLOAD_CANCEL_UNCONFIRMED' });
  state.KEY = 'other-account';
  controller.abort();
  await rejected;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].guard.shouldSend(), false);
});

test('pre-aborted tasks never send; settled requests cannot be replayed from an outbox', async () => {
  const { target, sent, reply } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(requestProjectDownload(target, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(sent.length, 0);
  const success = requestProjectDownload(target);
  reply(0, { key: 'file-key' });
  assert.equal((await success).key, 'file-key');
  assert.equal(sent[0].guard.shouldSend(), false);
});
