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
