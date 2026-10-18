import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadAttachment, resolveBridgeAttachments } from '../../bridge/attachments.mjs';
import { attachmentRef, extractAttachments } from '../../web/js/components/attachment.js';

const key = 'a'.repeat(32) + '.pptx';
const config = { server: 'https://api.test', apiKey: 'private-key' };

async function fixture(context, body, options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'baton-attachment-'));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const requests = [];
  const fetchFn = async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/file-url/')) return Response.json({
      key, size: options.size ?? body.length, url: 'https://bucket.test/signed-file',
    });
    return new Response(body, { status: options.status || 200 });
  };
  return { home, fetchFn, requests };
}

test('files over 6 MB stream directly to disk with an unchanged extension', async context => {
  const body = Buffer.alloc(8 * 1024 * 1024, 0x87);
  const options = await fixture(context, body);
  const local = await downloadAttachment(key, config, options);
  assert.equal(path.extname(local), '.pptx');
  assert.deepEqual(await fs.readFile(local), body);
  assert.equal(options.requests[0].init.headers['x-api-key'], 'private-key');
  assert.equal(options.requests[1].init.headers, undefined);
  await downloadAttachment(key, config, options);
  assert.equal(options.requests.length, 3);
});

test('local and remote references retain the original filename in history', async context => {
  const options = await fixture(context, Buffer.from('slides'));
  const file = { key, name: '计划 [v2] (最终) "测试".pptx' };
  const text = 'Review ' + attachmentRef(file) + ' ' + attachmentRef(file);
  const resolved = await resolveBridgeAttachments(text, config, options);
  assert.ok(!resolved.includes('baton-file:'));
  assert.deepEqual(extractAttachments(resolved).files.map(entry => entry.name), [file.name, file.name]);
  assert.deepEqual(extractAttachments(text).files.map(entry => entry.key), [key, key]);
  assert.equal(options.requests.length, 2);
  assert.equal(await resolveBridgeAttachments('plain message', config, options), 'plain message');
});

test('invalid keys cannot write outside the attachment directory', async () => {
  for (const invalid of ['../secret', 'test.pdf', '/tmp/file', 'a'.repeat(32) + '/../file']) {
    await assert.rejects(downloadAttachment(invalid, config), /Invalid attachment key/);
  }
});

test('failed, truncated and oversized downloads leave no partial files', async context => {
  for (const settings of [{ size: 10 }, { size: 1 }, { status: 500 }]) {
    const options = await fixture(context, Buffer.from('hello'), settings);
    await assert.rejects(downloadAttachment(key, config, options));
    assert.deepEqual(await fs.readdir(path.join(options.home, '.baton-bridge', 'attachments')), []);
  }
});

test('missing or oversized remote files fail instead of sending unusable paths', async () => {
  await assert.rejects(downloadAttachment(key, config, {
    fetchFn: async () => new Response('', { status: 404 }),
  }), /unavailable/);
  await assert.rejects(downloadAttachment(key, config, {
    fetchFn: async () => Response.json({ size: 513 * 1024 * 1024 }),
  }), /Invalid attachment size/);
});
