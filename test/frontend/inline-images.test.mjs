import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://baton.test/' });
for (const name of ['window', 'document', 'localStorage', 'sessionStorage', 'location']) {
  globalThis[name] = name === 'window' ? dom.window : dom.window[name];
}

let observer;
globalThis.IntersectionObserver = class {
  targets = new Set();
  constructor(callback) { this.callback = callback; observer = this; }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  emit(target, isIntersecting) { this.callback([{ target, isIntersecting }]); }
};
globalThis.Image = class {
  set src(value) { queueMicrotask(() => this.onload()); }
};

const { state } = await import('../../web/js/state.js');
const { handleProjectFilesMessage } = await import('../../web/js/project/rpc.js');
await import('../../web/js/api.js');

const projectHash = '-home-ec2-user-workspace-github-agentpeek';
const requests = [];
const downloads = [];
let failNextRead = false;
let nextImage = 0;
window.wsSendReliable = request => {
  requests.push(request);
  const failed = failNextRead;
  failNextRead = false;
  const key = 'preview-' + ++nextImage + '.png';
  queueMicrotask(() => handleProjectFilesMessage({
    action: 'project_files',
    requestId: request.requestId,
    ok: !failed,
    ...(failed ? { error: 'Device is offline' }
      : { image: true, key, attachment: true }),
  }));
};
globalThis.fetch = async url => {
  downloads.push(String(url));
  return String(url).startsWith('https://storage.test/')
    ? { ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }
    : { ok: true, json: async () => ({ url: 'https://storage.test/' + downloads.length }) };
};

test.beforeEach(() => {
  document.body.replaceChildren();
  observer.targets.clear();
  requests.length = 0;
  downloads.length = 0;
  failNextRead = false;
  state.appState.device = 'test-ec2';
  state.appState.project = { hash: projectHash };
  state.wsAllMessages = [];
});
test.after(() => dom.window.close());

const settle = () => new Promise(resolve => setImmediate(resolve));
function placeholder(path) {
  const el = document.createElement('span');
  el.className = 'img-placeholder markdown-image';
  el.dataset.path = path;
  el.dataset.alt = 'Screenshot';
  document.body.append(el);
  return el;
}

for (const [description, path, expectedPath] of [
  ['project image', '/home/ec2-user/workspace/github/agentpeek/docs/screen.png', 'docs/screen.png'],
  ['sibling worktree image', '/home/ec2-user/workspace/github/agentpeek-theme/.test-runs/compare/home.png',
    '/home/ec2-user/workspace/github/agentpeek-theme/.test-runs/compare/home.png'],
  ['temporary image', '/tmp/baton-screen.png', '/tmp/baton-screen.png'],
]) {
  test(description + ' loads automatically only when it approaches the viewport', async () => {
    const el = placeholder(path);
    window.loadImages(document.body);
    window.loadImages(document.body);
    assert.equal(observer.targets.size, 1);
    assert.equal(el.querySelector('button'), null);
    observer.emit(el, false);
    await settle();
    assert.equal(requests.length, 0);
    assert.equal(downloads.length, 0);

    observer.emit(el, true);
    await settle();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, expectedPath);
    assert.equal(requests[0].device, 'test-ec2');
    assert.equal(requests[0].projectHash, projectHash);
    assert.equal(observer.targets.size, 0);
    assert.equal(downloads.length, 2);
    assert.equal(el.classList.contains('loaded'), true);
    assert.equal(el.querySelector('img').alt, 'Screenshot');
  });
}

test('a deferred image retains its original device and project after navigation', async () => {
  const el = placeholder('/tmp/original-session.png');
  window.loadImages(document.body);
  state.appState.device = 'another-device';
  state.appState.project = { hash: 'another-project' };
  observer.emit(el, true);
  await settle();
  assert.equal(requests[0].device, 'test-ec2');
  assert.equal(requests[0].projectHash, projectHash);
  assert.equal(el.classList.contains('loaded'), true);
});

test('a failed automatic load can be retried with the same path', async () => {
  const el = placeholder('/tmp/retry-preview.png');
  failNextRead = true;
  window.loadImages(document.body);
  observer.emit(el, true);
  await settle();
  assert.equal(el.dataset.failed, '1');
  const retry = el.querySelector('button');
  assert.equal(retry.textContent, 'Retry');
  assert.equal(retry.title, 'Device is offline');

  retry.click();
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, requests[0].path);
  assert.equal(el.hasAttribute('data-failed'), false);
  assert.equal(el.classList.contains('loaded'), true);
});
