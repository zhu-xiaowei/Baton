import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../web/js/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function submitDelete()');
const end = source.indexOf('// New-session hero', start);

test('delete results show device errors and preserve the existing timeout message', async () => {
  for (const [files, expected] of [
    [{ ok: false, error: 'Permission denied deleting history' }, 'Permission denied deleting history'],
    [{ ok: false }, 'Some original files could not be deleted.'],
    [{ ok: false, timeout: true }, 'device did not confirm'],
    [{ ok: true }, null],
  ]) {
    const messages = [];
    const context = {
      state: {
        selected: new Set(['session']), selectType: 'session',
        appState: { device: 'test', project: { hash: 'project' } },
      },
      document: { getElementById: (id) => id === 'deleteFilesCb' ? { checked: true } : {} },
      _deleteCountdownTimer: null,
      setButtonLoading() {}, closeDeleteModal() {}, invalidatePagedList() {}, loadSessions() {},
      performDelete: async () => ({ ddb: true, files }),
      showStats: (message) => messages.push(message),
    };
    vm.runInNewContext(source.slice(start, end), context);
    await context.submitDelete();
    if (expected) assert.ok(messages[0]?.includes(expected));
    else assert.deepEqual(messages, []);
  }
});
