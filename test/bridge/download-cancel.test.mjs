import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { hashFile } from '../../bridge/content-hash.mjs';
import { handleProjectFilesMessage } from '../../bridge/project/files.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-download-cancel-'));
  fs.writeFileSync(path.join(root, 'file.txt'), 'original file');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sent = [];
  const token = crypto.randomUUID();
  const message = {
    action: 'project_files', operation: 'download', requestId: crypto.randomUUID(),
    projectHash: 'project', path: 'file.txt', downloadOwner: 'account-a', downloadToken: token,
    replyConnectionId: 'old-app',
  };
  const options = { resolveProjectRoot: () => root, send: frame => sent.push(frame), home: root };
  const cancel = overrides => handleProjectFilesMessage({
    ...message, ...overrides, operation: 'cancel_download', requestId: crypto.randomUUID(),
    replyConnectionId: 'reconnected-app',
  }, options);
  return { root, sent, message, options, cancel };
}

test('cancel stops preparation HTTP request and waits for its cleanup, including after reconnect', async t => {
  const { sent, message, options, cancel } = fixture(t);
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  let cleaned = false;
  const work = handleProjectFilesMessage(message, { ...options,
    postFn: async (_path, _body, { signal }) => {
      started();
      await new Promise(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      // Simulate network resource cleanup before returning.
      await new Promise(resolve => setTimeout(resolve, 10));
      cleaned = true;
      return null;
    },
    fetchFn: () => assert.fail('cancelled preparation must not upload'),
  });
  await ready;
  await cancel();
  await work;
  assert.equal(cleaned, true);
  assert.ok(sent.some(frame => frame.operation === 'download' && frame.ok === false && /cancelled/.test(frame.error)));
  assert.equal(sent.at(-1).status, 'cancelled');
  assert.equal(sent.at(-1).replyConnectionId, 'reconnected-app');
  release();
});

test('another account cannot cancel an active preparation with the same token', async t => {
  const { sent, message, options, cancel } = fixture(t);
  let started, release;
  const ready = new Promise(resolve => { started = resolve; });
  let signal;
  const work = handleProjectFilesMessage(message, { ...options,
    postFn: async (_path, _body, opts) => {
      signal = opts.signal;
      started();
      await new Promise(resolve => { release = resolve; });
      return Response.json({ key: 'account-a-key', exists: true });
    },
  });
  await ready;
  await cancel({ downloadOwner: 'account-b' });
  assert.equal(signal.aborted, false);
  release(); await work;
  assert.equal(sent.at(-1).key, 'account-a-key');
});

test('early cancellation prevents even stat/hash/upload and invalidates no unrelated request', async t => {
  const { sent, message, options, cancel } = fixture(t);
  await cancel();
  await handleProjectFilesMessage({ ...message, path: 'missing-file' }, { ...options,
    postFn: () => assert.fail('must not prepare'),
  });
  assert.match(sent.at(-1).error, /cancelled/);
  assert.doesNotMatch(sent.at(-1).error, /ENOENT/);
});

test('real upload fetch is aborted, its file stream closes, and fallback is not attempted', { timeout: 10_000 }, async t => {
  const { root, sent, message, options, cancel } = fixture(t);
  fs.truncateSync(path.join(root, 'file.txt'), 16 * 1024 * 1024);
  // Cancel only after real bytes arrive, with the receiver applying backpressure.
  const server = http.createServer((req, _res) => {
    req.once('data', () => { req.pause(); ready(); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  let body, attempts = 0;
  const work = handleProjectFilesMessage(message, { ...options,
    postFn: async () => Response.json({ key: 'uploaded', url, fallbackUrl: url + '-fallback', headers: {} }),
    fetchFn: async (target, init) => {
      attempts++;
      body = init.body;
      return fetch(target, init);
    },
  });
  await started;
  assert.equal(body.destroyed, false, 'the file is still streaming when cancel is requested');
  await cancel(); await work;
  assert.equal(attempts, 1);
  assert.equal(body.destroyed, true);
  assert.equal(body.closed, true);
  assert.equal(sent.at(-1).status, 'cancelled');
  assert.equal(sent.some(frame => frame.ok && frame.key), false);
  assert.equal(fs.statSync(path.join(root, 'file.txt')).size, 16 * 1024 * 1024);
  assert.equal(fs.readFileSync(path.join(root, 'file.txt')).subarray(0, 13).toString(), 'original file');
});

test('hashing accepts cancellation without producing or caching a partial hash', async t => {
  const { root } = fixture(t);
  const file = path.join(root, 'large.bin');
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, 64 * 1024 * 1024);
  fs.closeSync(fd);
  const controller = new AbortController();
  const pending = hashFile(file, { signal: controller.signal });
  controller.abort(new DOMException('Download cancelled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fs.existsSync(path.join(root, 'file-hashes.json')), false);
});

test('cached prepared keys are account scoped and changed files are re-prepared', async t => {
  const { root, sent, message, options } = fixture(t);
  fs.utimesSync(path.join(root, 'file.txt'), 1_600_000_000, 1_600_000_000);
  let uploads = 0;
  const postFn = async () => Response.json({ key: `prepared-${++uploads}`, exists: true });
  const run = owner => handleProjectFilesMessage({
    ...message, downloadOwner: owner, downloadToken: crypto.randomUUID(),
  }, { ...options, postFn });
  await run('a'); assert.equal(sent.at(-1).key, 'prepared-1');
  await run('b'); assert.equal(sent.at(-1).key, 'prepared-2');
  await run('a'); assert.equal(sent.at(-1).key, 'prepared-1');
  const original = fs.statSync(path.join(root, 'file.txt'));
  await new Promise(resolve => setTimeout(resolve, 5));
  fs.writeFileSync(path.join(root, 'file.txt'), 'changed bytes');
  fs.utimesSync(path.join(root, 'file.txt'), original.atime, original.mtime);
  const changed = fs.statSync(path.join(root, 'file.txt'));
  assert.equal(changed.size, original.size);
  assert.equal(changed.mtimeMs, original.mtimeMs);
  await run('a'); assert.equal(sent.at(-1).key, 'prepared-3');
});
