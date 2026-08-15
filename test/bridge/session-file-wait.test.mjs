import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForSessionFile } from '../../bridge/ws.mjs';

test('new Claude status waits for the session file to become displayable', async () => {
  const filePath = '/tmp/new-session.jsonl';
  let displayable = false;
  const adapter = {
    findSessionFile() {
      return filePath;
    },
  };

  setTimeout(() => {
    displayable = true;
  }, 15);

  const result = await waitForSessionFile(adapter, 'new-session', {
    timeoutMs: 100,
    pollMs: 2,
    ready: () => displayable,
  });

  assert.equal(result, '/tmp/new-session.jsonl');
});

test('new Claude status gives up when the session file never appears', async () => {
  const result = await waitForSessionFile({
    findSessionFile() {
      return null;
    },
  }, 'missing-session', {
    timeoutMs: 10,
    pollMs: 2,
  });

  assert.equal(result, null);
});
