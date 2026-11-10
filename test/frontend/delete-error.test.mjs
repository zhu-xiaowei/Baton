import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../web/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function performDelete(');
const end = source.indexOf('// New-session hero', start);

function harness() {
  const timers = new Map();
  const writes = [];
  let now = 0;
  let sequence = 0;
  let request;
  const context = {
    window: { loadViewerLibs: async () => {} },
    apiPost: async (...args) => { writes.push(args); },
    ensureWsAndSend: (message) => { request = message; },
    setTimeout: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    _deviceToDelete: null,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return {
    context, writes,
    reply: (result) => context.window._deleteFilesResolvers[request.requestId](result),
    get request() { return request; },
    advance(ms) {
      now += ms;
      for (const [id, timer] of timers) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    },
  };
}

for (const success of [false, true]) {
  test(`progress retains late ${success ? 'success' : 'errors'} and defers deleting list records`, async () => {
    const h = harness();
    const operation = h.context.performDelete('device', true, ['project'], true);
    await new Promise(setImmediate);
    assert.equal(h.request.progress, true);
    for (let i = 0; i < 6; i++) {
      h.advance(5000);
      h.reply({ pending: true });
    }
    assert.equal(h.writes.length, 0);
    h.reply({ ok: success, error: 'Native database deletion failed' });
    if (success) {
      assert.equal((await operation).ddb, true);
      assert.equal(h.writes.length, 1);
    } else {
      await assert.rejects(operation, /Native database deletion failed/);
      assert.equal(h.writes.length, 0);
    }
    assert.equal(Object.keys(h.context.window._deleteFilesResolvers).length, 0);
  });
}

test('a silent or disconnected bridge times out without deleting list records', async () => {
  const h = harness();
  const operation = h.context.performDelete('device', false, ['session'], true);
  await new Promise(setImmediate);
  h.advance(8000);
  await assert.rejects(operation, /device stopped confirming/);
  assert.equal(h.writes.length, 0);
  assert.equal(Object.keys(h.context.window._deleteFilesResolvers).length, 0);
});

test('list-only deletion does not require a bridge connection', async () => {
  const h = harness();
  await h.context.performDelete('device', false, ['session'], false);
  assert.equal(h.request, undefined);
  assert.equal(h.writes.length, 1);
});

test('failed file deletion stays visible in the modal', async () => {
  const h = harness();
  const error = { textContent: '' };
  let closed = false;
  Object.assign(h.context, {
    state: { selected: new Set(['session']), selectType: 'session', appState: { device: 'device' } },
    document: { getElementById: (id) => id === 'deleteFilesCb' ? { checked: true } : id === 'deleteError' ? error : {} },
    _deleteCountdownTimer: null,
    setButtonLoading() {},
    closeDeleteModal: () => { closed = true; },
  });
  const operation = h.context.submitDelete();
  await new Promise(setImmediate);
  h.reply({ ok: false, error: 'Session is active' });
  await operation;
  assert.match(error.textContent, /Session is active/);
  assert.equal(closed, false);
  assert.equal(h.writes.length, 0);
});
