import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleProjectFilesMessage } from '../../bridge/project/files.mjs';

const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-project-files-'));
  const chunkedContent = 'const path = "C:\\\\workspace\\\\file"; // chunked\n'.repeat(3000);
  const escapedContent = '"\\\\\n'.repeat(40_000);
  const unicodeContent = '中文🙂 source line\n'.repeat(8000);
  const boundaryContent = 'b'.repeat(300 * 1024);
  const oversizedContent = 'x'.repeat((300 * 1024) + 1);
  fs.mkdirSync(path.join(root, 'folder'));
  fs.writeFileSync(path.join(root, 'folder', 'nested.txt'), 'nested');
  fs.writeFileSync(path.join(root, 'small.md'), '# Small\n');
  fs.writeFileSync(path.join(root, 'chunked.js'), chunkedContent);
  fs.writeFileSync(path.join(root, 'escaped.txt'), escapedContent);
  fs.writeFileSync(path.join(root, 'unicode.txt'), unicodeContent);
  fs.writeFileSync(path.join(root, 'boundary.txt'), boundaryContent);
  fs.writeFileSync(path.join(root, 'oversized.txt'), oversizedContent);
  return {
    root,
    contents: {
      'boundary.txt': boundaryContent,
      'chunked.js': chunkedContent,
      'escaped.txt': escapedContent,
      'unicode.txt': unicodeContent,
    },
  };
}

async function request(root, message, options = {}) {
  const sent = [];
  await handleProjectFilesMessage({
    action: 'project_files',
    requestId: REQUEST_ID,
    projectHash: 'project',
    ...message,
  }, {
    resolveProjectRoot: () => root,
    send: (payload) => sent.push(payload),
    postFn: options.postFn,
    fetchFn: options.fetchFn,
  });
  return sent;
}

test('download exports original binary files over 6 MB with accelerated upload fallback', async () => {
  const { root } = fixture();
  const content = Buffer.alloc(8 * 1024 * 1024, 0x84);
  const key = 'f'.repeat(32) + '.pptx';
  fs.writeFileSync(path.join(root, 'slides.pptx'), content);
  const uploads = [];
  let preparations = 0;
  const options = {
    postFn: async (endpoint, body) => {
      preparations++;
      assert.equal(endpoint, '/api/bridge/file-prepare');
      assert.equal(body.name, 'slides.pptx');
      assert.equal(body.size, content.length);
      assert.equal(body.data, undefined);
      return Response.json({ key, url: 'https://accelerated.test', fallbackUrl: 'https://standard.test', headers: { 'Content-Type': 'application/octet-stream' } });
    },
    fetchFn: async (url, init) => {
      assert.equal(init.headers['Content-Length'], String(content.length));
      const chunks = [];
      for await (const chunk of init.body) chunks.push(chunk);
      uploads.push({ url, bytes: Buffer.concat(chunks) });
      return new Response('', { status: url.includes('accelerated') ? 503 : 200 });
    },
  };
  try {
    const result = await request(root, { operation: 'download', path: 'slides.pptx' }, options);
    assert.equal(result.at(-1).key, key);
    assert.equal(result.at(-1).size, content.length);
    assert.equal(result[0].progress, true);
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[1].bytes, content);
    await request(root, { operation: 'download', path: 'slides.pptx' }, options);
    assert.equal(preparations, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('downloads reject traversal and oversized files before requesting S3 access', async () => {
  const { root } = fixture();
  const large = path.join(root, 'large.pptx');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, 512 * 1024 * 1024 + 1);
  const options = { postFn: async () => { assert.fail('must not request upload access'); } };
  try {
    for (const filePath of ['../secret.txt', 'large.pptx']) {
      const [result] = await request(root, { operation: 'download', path: filePath }, options);
      assert.equal(result.ok, false);
      assert.match(result.error, /outside the project|512 MB/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('failed exports are retried instead of caching an unusable download', async () => {
  const { root } = fixture();
  let attempts = 0;
  const options = {
    postFn: async () => { attempts++; return Response.json({ key: 'a'.repeat(32), url: 'https://s3.test', headers: {} }); },
    fetchFn: async () => { throw new Error('offline'); },
  };
  try {
    for (let index = 0; index < 2; index++) {
      const result = await request(root, { operation: 'download', path: 'small.md' }, options);
      assert.equal(result.at(-1).ok, false);
      assert.match(result.at(-1).error, /upload failed/);
    }
    assert.equal(attempts, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('project file listing returns folders before files', async () => {
  const { root } = fixture();
  try {
    const [response] = await request(root, {
      operation: 'list',
      path: '',
    });
    assert.equal(response.ok, true);
    assert.deepEqual(response.entries.map((entry) => entry.name), [
      'folder',
      'boundary.txt',
      'chunked.js',
      'escaped.txt',
      'oversized.txt',
      'small.md',
      'unicode.txt',
    ]);
    assert.equal(response.entries[0].type, 'directory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project file listing rejects paths outside the project', async () => {
  const { root } = fixture();
  try {
    const [response] = await request(root, {
      operation: 'list',
      path: '..',
    });
    assert.equal(response.ok, false);
    assert.match(response.error, /outside the project/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project-relative HTML preview reads reject symlinks outside the project', async () => {
  const { root } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-preview-outside-'));
  try {
    const external = path.join(outside, 'private.html');
    fs.writeFileSync(external, '<p>outside project</p>');
    fs.mkdirSync(path.join(root, 'output'));
    fs.symlinkSync(external, path.join(root, 'output', 'preview.html'));
    const [response] = await request(root, { operation: 'read', path: 'output/preview.html' });
    assert.equal(response.ok, false);
    assert.match(response.error, /outside the project/);
    assert.equal(response.content, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('text files up to 300 KB use one ordered WebSocket chunk stream', async () => {
  const { root, contents } = fixture();
  try {
    const smallMessages = await request(root, {
      operation: 'read',
      path: 'small.md',
    }, {
      postFn: async () => {
        throw new Error('small files must not upload');
      },
    });
    assert.equal(smallMessages.length, 1);
    const [small] = smallMessages;
    assert.equal(small.ok, true);
    assert.equal(small.sequence, 0);
    assert.equal(small.complete, true);
    assert.equal(small.content, '# Small\n');

    for (const [file, expected] of Object.entries(contents)) {
      const chunked = await request(root, {
        operation: 'read',
        path: file,
      }, {
        postFn: async () => {
          throw new Error('files up to 300 KB must not upload');
        },
      });
      assert.ok(chunked.length > 1, file);
      assert.deepEqual(
        chunked.map((message) => message.sequence),
        Array.from({ length: chunked.length }, (_, index) => index),
        file,
      );
      assert.equal(
        chunked.slice(0, -1).every((message) => message.complete === false),
        true,
        file,
      );
      assert.equal(chunked.at(-1).complete, true, file);
      assert.equal(chunked.map((message) => message.content).join(''), expected, file);
      assert.equal(
        chunked.every((message) => Buffer.byteLength(JSON.stringify(message)) <= 31_000),
        true,
        file,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('text files above 300 KB use the existing S3 upload path', async () => {
  const { root } = fixture();
  const uploads = [];
  try {
    const [response] = await request(root, {
      operation: 'read',
      path: 'oversized.txt',
    }, {
      postFn: async (endpoint, body) => {
        uploads.push({ endpoint, body });
        return { ok: true };
      },
    });
    assert.equal(response.ok, true);
    assert.equal(response.sequence, undefined);
    assert.equal(response.content, undefined);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].endpoint, '/api/bridge/upload-file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
