import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../web/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function performDelete(');
const end = source.indexOf('// New-session hero', start);

function harness(answer) {
  const writes = [];
  const requests = [];
  const context = {
    window: {
      loadViewerLibs: async () => {},
      bridgeRequest: async (...args) => { requests.push(args); return answer(); },
    },
    apiPost: async (...args) => { writes.push(args); },
    _deviceToDelete: null,
  };
  vm.runInNewContext(source.slice(start, end), context);
  return { context, writes, requests };
}

// List records go only after the Bridge confirms the files are gone.
for (const [name, answer, failure] of [
  ['success', async () => ({ frames: [{ pending: true }, { ok: true }] }), null],
  ['failure', async () => ({ frames: [{ ok: false, error: 'Native database deletion failed' }] }), /Native database deletion failed/],
  ['timeout', async () => { throw new Error('timeout'); }, /device stopped confirming/],
]) {
  test(`delete ${name} decides whether list records are deleted`, async () => {
    const h = harness(answer);
    const operation = h.context.performDelete('device', true, ['project']);
    if (failure) {
      await assert.rejects(operation, failure);
      assert.equal(h.writes.length, 0);
    } else {
      assert.equal((await operation).ddb, true);
      assert.equal(JSON.stringify(h.writes), JSON.stringify([['/api/bridge/delete', { deviceName: 'device', projectHashes: ['project'] }]]));
    }
    assert.equal(JSON.stringify(h.requests[0].slice(0, 2)), JSON.stringify(['delete_files', { projectHashes: ['project'] }]));
  });
}

test('failed file deletion stays visible in the modal', async () => {
  const h = harness(async () => ({ frames: [{ ok: false, error: 'Session is active' }] }));
  const error = { textContent: '' };
  let closed = false;
  Object.assign(h.context, {
    state: { selected: new Set(['session']), selectType: 'session', appState: { device: 'device' } },
    document: { getElementById: (id) => id === 'deleteError' ? error : {} },
    _deleteCountdownTimer: null,
    setButtonLoading() {},
    closeDeleteModal: () => { closed = true; },
  });
  await h.context.submitDelete();
  assert.match(error.textContent, /Session is active/);
  assert.equal(closed, false);
  assert.equal(h.writes.length, 0);
});
