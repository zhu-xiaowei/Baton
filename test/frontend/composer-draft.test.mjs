import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composerDraftKey,
  createComposerDraftController,
  createComposerDraftStore,
} from '../../web/js/drafts/composer-draft-core.js';

function fields(sessionId, projectHash = 'project-a') {
  return {
    server: 'https://server.test',
    device: 'Mac',
    projectHash,
    sessionId,
  };
}

function memoryBackend() {
  const records = new Map();
  return {
    records,
    async get(key) { return records.get(key) || null; },
    async put(record) { records.set(record.key, { ...record }); },
    async delete(key) { records.delete(key); },
  };
}

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('draft keys isolate the same session id across project scopes', () => {
  assert.notEqual(
    composerDraftKey(fields('session-1', 'project-a')),
    composerDraftKey(fields('session-1', 'project-b')),
  );
});

test('switching sessions saves and restores each draft independently', async () => {
  const backend = memoryBackend();
  const store = createComposerDraftStore(backend, { now: () => 42 });
  let input = '';
  const controller = createComposerDraftController(store, {
    readInput: () => input,
    applyInput: (text) => { input = text; },
    debounceMs: 5,
  });

  await controller.activate(fields('session-a'));
  input = 'draft for A';
  controller.sync();
  await tick(10);

  await controller.activate(fields('session-b'));
  assert.equal(input, '');
  input = 'draft for B';
  controller.sync();
  await tick(10);

  await controller.activate(fields('session-a'));
  assert.equal(input, 'draft for A');
  assert.equal((await store.get(fields('session-b'))).text, 'draft for B');
});

test('a late restore never overwrites text typed after session entry', async () => {
  let resolveRead;
  let input = '';
  const store = {
    get: () => new Promise((resolve) => { resolveRead = resolve; }),
    put: async () => {},
    delete: async () => {},
  };
  const controller = createComposerDraftController(store, {
    readInput: () => input,
    applyInput: (text) => { input = text; },
    debounceMs: 5,
  });

  const activation = controller.activate(fields('session-a'));
  await tick();
  input = 'new typing';
  controller.sync();
  resolveRead({ text: 'older stored draft' });
  await activation;

  assert.equal(input, 'new typing');
});

test('clearing removes a sent draft and rekey moves an unsent draft', async () => {
  const backend = memoryBackend();
  const store = createComposerDraftStore(backend);
  let input = '';
  const controller = createComposerDraftController(store, {
    readInput: () => input,
    applyInput: (text) => { input = text; },
    debounceMs: 5,
  });

  await controller.activate(fields('__new__'));
  input = 'second message';
  controller.sync();
  await controller.rekey(fields('session-real'));
  assert.equal(await store.get(fields('__new__')), null);
  assert.equal((await store.get(fields('session-real'))).text, 'second message');

  input = '';
  await controller.clear();
  assert.equal(await store.get(fields('session-real')), null);
});

test('uploaded attachments are saved, restored and moved with the draft', async () => {
  const backend = memoryBackend();
  const store = createComposerDraftStore(backend);
  const file = { kind: 'file', name: 'spec.pdf', key: 'f.pdf' };
  const image = { name: 'shot.png', key: 'i.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' };
  let input = { text: '', attachments: [] };
  const controller = createComposerDraftController(store, {
    readInput: () => input,
    applyInput: (text, attachments) => { input = { text, attachments }; },
    debounceMs: 5,
  });

  await controller.activate(fields('__new__'));
  input = { text: '', attachments: [file] };
  controller.sync();
  await tick(10);
  assert.deepEqual((await store.get(fields('__new__'))).attachments, [file]);

  input = { text: 'look', attachments: [file, image] };
  await controller.rekey(fields('session-a'));

  await controller.activate(fields('session-b'));
  assert.deepEqual(input, { text: '', attachments: [] });

  await controller.activate(fields('session-a'));
  assert.deepEqual(input, { text: 'look', attachments: [file, image] });
});

test('a late restore never replaces an attachment still uploading', async () => {
  let resolveRead;
  let input = { text: '', attachments: [] };
  const store = {
    get: () => new Promise((resolve) => { resolveRead = resolve; }),
    put: async () => {},
    delete: async () => {},
  };
  const controller = createComposerDraftController(store, {
    readInput: () => input,
    applyInput: (text, attachments) => { input = { text, attachments }; },
    debounceMs: 5,
  });

  const activation = controller.activate(fields('session-a'));
  await tick();
  input = { text: '', attachments: [], pending: true };
  resolveRead({ text: 'older' });
  await activation;

  assert.equal(input.pending, true);
});
