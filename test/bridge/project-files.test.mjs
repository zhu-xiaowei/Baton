import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import crypto from 'node:crypto';
import { handleProjectFilesMessage } from '../../bridge/project/files.mjs';
import { hashFile } from '../../bridge/content-hash.mjs';

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
    home: options.home,
  });
  return sent;
}

test('small and large image previews use the same direct upload flow', async () => {
  const { root } = fixture();
  const key = 'd'.repeat(32) + '.png';
  try {
    for (const size of [32, 5 * 1024 * 1024]) {
      const content = Buffer.alloc(size, 0x84);
      const imagePath = `image-${size}.png`;
      fs.writeFileSync(path.join(root, imagePath), content);
      let uploaded;
      const result = await request(root, { operation: 'read', path: imagePath }, {
        postFn: async (endpoint, body) => {
          assert.equal(endpoint, '/api/bridge/file-prepare');
          assert.equal(body.data, undefined);
          assert.equal(body.size, content.length);
          return Response.json({ key, url: 'https://uploads.test/image', headers: {} });
        },
        fetchFn: async (_url, init) => {
          const chunks = [];
          for await (const chunk of init.body) chunks.push(chunk);
          uploaded = Buffer.concat(chunks);
          return new Response('');
        },
      });
      assert.deepEqual(uploaded, content);
      assert.equal(result.at(-1).image, true);
      assert.equal(result.at(-1).attachment, true);
      assert.equal(result.at(-1).truncated, false);
      assert.equal(result.at(-1).key, key);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('automatic relative image reads reject traversal and symlinks outside the project before uploading', async () => {
  const { root } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-private-image-'));
  fs.writeFileSync(path.join(outside, 'private.png'), 'private');
  try {
    fs.symlinkSync(path.join(outside, 'private.png'), path.join(root, 'linked.png'));
    for (const imagePath of ['../private.png', 'linked.png']) {
      const result = await request(root, { operation: 'read', path: imagePath }, {
        postFn: async () => assert.fail('must not upload files outside the project'),
      });
      assert.equal(result.at(-1).ok, false);
      assert.match(result.at(-1).error, /outside the project/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

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

// Must match the app's web/js/components/content-hash.js (same vectors in test/frontend/attachments.test.mjs).
test('content IDs are the SHA-256 that S3 verifies, shared with the app', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-hash-'));
  const data = Buffer.alloc(9 * 1024 * 1024 + 7);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + (i >> 12)) & 255;
  fs.writeFileSync(path.join(dir, 'vector.bin'), data);
  fs.writeFileSync(path.join(dir, 'empty.bin'), '');
  try {
    assert.equal(await hashFile(path.join(dir, 'vector.bin')), 'eff34fb403f905467ac2473ee02a191f11306cae280232a7c65482449c44ac61');
    assert.equal(await hashFile(path.join(dir, 'empty.bin')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stored content is reused without uploading, and bytes S3 rejects forget the remembered hash', async () => {
  const { root } = fixture();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-home-'));
  const file = path.join(root, 'report.pdf');
  fs.writeFileSync(file, 'same content');
  // Freshly written files are not remembered (Git's racy window).
  await new Promise(resolve => setTimeout(resolve, 2100));
  const hash = await hashFile(file);
  const remembered = () => Object.values(JSON.parse(fs.readFileSync(path.join(home, 'file-hashes.json'), 'utf8')));
  const puts = [];
  let stored = true;
  const options = {
    home,
    postFn: async (endpoint, body) => {
      assert.equal(body.contentHash, hash);
      return Response.json(!stored
        ? { key: hash.slice(0, 32) + '.pdf', url: 'https://accelerated.test', fallbackUrl: 'https://standard.test', headers: {} }
        : { key: hash.slice(0, 32) + '.pdf', exists: true });
    },
    fetchFn: async url => { puts.push(url); return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 }); },
  };
  try {
    let result = await request(root, { operation: 'download', path: 'report.pdf' }, options);
    assert.equal(result.at(-1).key, hash.slice(0, 32) + '.pdf');
    assert.equal(puts.length, 0);
    assert.deepEqual(remembered(), [hash]);
    // A second file with the same remembered hash whose bytes S3 rejects: no fallback retry, hash forgotten.
    stored = false;
    fs.copyFileSync(file, path.join(root, 'other.pdf'));
    await new Promise(resolve => setTimeout(resolve, 2100));
    result = await request(root, { operation: 'download', path: 'other.pdf' }, options);
    assert.equal(result.at(-1).ok, false);
    assert.match(result.at(-1).error, /changed/);
    assert.deepEqual(puts, ['https://accelerated.test']);
    assert.deepEqual(remembered(), [hash]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
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

test('text file versions detect same-size changes even when modification time is preserved', async () => {
  const { root } = fixture();
  const file = path.join(root, 'small.md');
  const fixedTime = new Date('2026-10-13T00:00:00Z');
  try {
    fs.utimesSync(file, fixedTime, fixedTime);
    const [before] = await request(root, { operation: 'read', path: 'small.md' });
    assert.equal(before.contentVersion, crypto.createHash('sha256').update('# Small\n').digest('hex'));
    fs.writeFileSync(file, '# Large\n');
    fs.utimesSync(file, fixedTime, fixedTime);
    const [after] = await request(root, { operation: 'read', path: 'small.md' });
    assert.equal(after.size, before.size);
    assert.notEqual(after.contentVersion, before.contentVersion);
    assert.notEqual(after.key, before.key);
    assert.equal(after.content, '# Large\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('large text uploads cannot reuse a stale file when content changes without a timestamp change', async () => {
  const { root } = fixture();
  const file = path.join(root, 'oversized.txt');
  const fixedTime = new Date('2026-10-13T00:00:00Z');
  const uploads = [];
  const options = { postFn: async (_endpoint, body) => { uploads.push(body.key); return { ok: true }; } };
  try {
    fs.utimesSync(file, fixedTime, fixedTime);
    const [before] = await request(root, { operation: 'read', path: 'oversized.txt' }, options);
    const bytes = fs.readFileSync(file);
    bytes[0] = 'y'.charCodeAt(0);
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, fixedTime, fixedTime);
    const [after] = await request(root, { operation: 'read', path: 'oversized.txt' }, options);
    assert.notEqual(after.contentVersion, before.contentVersion);
    assert.notEqual(after.key, before.key);
    await request(root, { operation: 'read', path: 'oversized.txt' }, options);
    assert.equal(uploads.length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
