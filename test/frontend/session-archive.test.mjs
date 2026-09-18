import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { state } from '../../web/js/state.js';
import {
  archiveReadOnly, archiveSelectionReason, mergeArchiveObservation,
  archiveInfo, rememberArchiveMetadata, currentArchiveReadOnly, handleArchiveMessage,
  applyArchiveMetadata, initSessionArchive, openArchiveDialog, submitArchive, closeArchiveDialog,
} from '../../web/js/session-archive.js';

test('a restored root does not make an archived child writable', () => {
  assert.equal(archiveReadOnly({ archiveState: 'archived' }, { archiveState: 'unarchived' }), true);
  assert.equal(archiveReadOnly({ archiveState: 'unarchived' }, { archiveState: 'archived' }), true);
  assert.equal(archiveReadOnly({ archiveState: 'unknown' }, { archiveState: 'unarchived' }), false);
});

test('selection refuses mixed runtimes, offline devices and active sessions', () => {
  const capability = { canArchive: true, canUnarchive: true };
  const session = { sessionId: 'codex:a', status: 'completed' };
  assert.equal(archiveSelectionReason([session], capability, true, true), '');
  assert.match(archiveSelectionReason([session, { sessionId: 'claude-id' }], capability, true, true), /Codex/);
  assert.match(archiveSelectionReason([session], capability, false, true), /offline/i);
  assert.match(archiveSelectionReason([{ ...session, status: 'needs_input' }], capability, true, true), /active/i);
  assert.match(archiveSelectionReason([session], {}, true, true), /Update/);
});

test('late REST metadata cannot overwrite a newer archive notification', () => {
  assert.deepEqual(
    mergeArchiveObservation({ archiveState: 'archived', archiveVersion: 10 }, { archiveState: 'unarchived', archiveVersion: 9 }),
    { archiveState: 'archived', archiveVersion: 10 },
  );
  assert.equal(mergeArchiveObservation({ archiveState: 'archived', archiveVersion: 10 }, { archiveState: 'unarchived', archiveVersion: 11 }).archiveState,
    'unarchived');
});

test('late archived metadata cannot disable a restored session', () => {
  state.appState = { device: 'D', project: { hash: 'send-order' }, session: 'codex:root' };
  state.activeThreadId = state.wsSessionId = state.rootSessionId = 'codex:root';
  applyArchiveMetadata({ archiveState: 'unarchived', archiveVersion: 11, canSend: true }, 'codex:root');
  applyArchiveMetadata({ archiveState: 'archived', archiveVersion: 10, canSend: false }, 'codex:root');
  assert.equal(currentArchiveReadOnly(), false);
  assert.equal(state.activeThreadCanSend, true);
});

test('send permission respects root versions even when the child version is unchanged', () => {
  state.appState = { device: 'D', project: { hash: 'root-send-order' }, session: 'codex:root' };
  state.activeThreadId = state.wsSessionId = 'codex:child';
  state.rootSessionId = 'codex:root';
  const child = { archiveState: 'unarchived', archiveVersion: 5, rootSessionId: 'codex:root' };
  applyArchiveMetadata({ ...child, rootArchiveState: 'unarchived', rootArchiveVersion: 11, canSend: true }, 'codex:child');
  applyArchiveMetadata({ ...child, rootArchiveState: 'archived', rootArchiveVersion: 10, canSend: false }, 'codex:child');
  assert.equal(currentArchiveReadOnly(), false);
  assert.equal(state.activeThreadCanSend, true);
});

test('root restoration preserves archived children and intrinsic subagent restrictions', () => {
  state.appState = { device: 'D', project: { hash: 'child-send-order' }, session: 'codex:root' };
  state.activeThreadId = state.wsSessionId = 'codex:child';
  state.rootSessionId = 'codex:root';
  const root = { rootSessionId: 'codex:root', rootArchiveState: 'unarchived', rootArchiveVersion: 11 };
  applyArchiveMetadata({ ...root, archiveState: 'archived', archiveVersion: 6, canSend: false }, 'codex:child');
  applyArchiveMetadata({ ...root, archiveState: 'unarchived', archiveVersion: 5, canSend: true }, 'codex:child');
  assert.equal(currentArchiveReadOnly(), true);
  assert.equal(state.activeThreadCanSend, false);

  applyArchiveMetadata({ ...root, archiveState: 'unarchived', archiveVersion: 7, canSend: false }, 'codex:child');
  rememberArchiveMetadata({ archiveState: 'unarchived', archiveVersion: 12 }, 'codex:root');
  assert.equal(currentArchiveReadOnly(), false);
  assert.equal(state.activeThreadCanSend, false);
});

test('a full metadata cache retains the active child while merging its root', () => {
  state.appState = { device: 'D', project: { hash: 'permission-cache' }, session: 'codex:cached-0' };
  state.activeThreadId = state.wsSessionId = 'codex:cached-0';
  state.rootSessionId = 'codex:new-root';
  for (let index = 0; index < 2000; index++) {
    rememberArchiveMetadata({ archiveState: 'archived', archiveVersion: 10, canSend: false }, `codex:cached-${index}`);
  }
  applyArchiveMetadata({
    archiveState: 'unarchived', archiveVersion: 11, canSend: true,
    rootSessionId: 'codex:new-root', rootArchiveState: 'unarchived', rootArchiveVersion: 20,
  }, 'codex:cached-0');
  assert.equal(archiveInfo('codex:cached-0').archiveVersion, 11);
  assert.equal(state.activeThreadCanSend, true);
});

test('child deep links retain their own state and use the actual root for read-only checks', () => {
  state.appState = { device: 'D', project: { hash: 'deep' }, session: 'codex:child' };
  state.activeThreadId = 'codex:child';
  state.rootSessionId = 'codex:child';
  rememberArchiveMetadata({
    sessionId: 'codex:child', archiveState: 'unarchived', archiveVersion: 3,
    rootSessionId: 'codex:parent', rootArchiveState: 'archived', rootArchiveVersion: 4,
  });
  assert.equal(archiveInfo('codex:child').archiveState, 'unarchived');
  assert.equal(currentArchiveReadOnly(), true);
  handleArchiveMessage({ action: 'session_archives_changed', deviceName: 'other',
    changes: [{ projectHash: 'deep', sessionId: 'codex:parent', archiveState: 'unarchived', archiveVersion: 5 }] });
  assert.equal(currentArchiveReadOnly(), true);
  handleArchiveMessage({ action: 'session_archives_changed', deviceName: 'D',
    changes: [{ projectHash: 'deep', sessionId: 'codex:parent', archiveState: 'unarchived', archiveVersion: 5 }] });
  assert.equal(currentArchiveReadOnly(), false);
});

test('batch dialog preserves partial failures, retries only failures and never queues offline mutations', async (t) => {
  const dom = new JSDOM('<button id="focus">Open</button><div id="archiveModal" style="display:none">'
    + '<div id="archiveModalTitle"></div><div id="archiveModalDesc"></div><div id="archiveError"></div>'
    + '<button id="archiveConfirmBtn"></button></div>');
  const globals = ['window', 'document', 'navigator'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  for (const key of ['window', 'document', 'navigator']) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'window' ? dom.window : dom.window[key] });
  }
  t.after(() => {
    closeArchiveDialog();
    dom.window.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  state.appState = { device: 'D', project: { hash: 'batch' } };
  state.deviceOnlineMap.D = true;
  state.deviceRuntimeCapabilities.D = { codex: { canArchive: true, canUnarchive: true } };
  window.loadViewerLibs = async () => {};
  window.connectWs = () => {};
  const requests = [];
  state.ws = { readyState: 1, send: (text) => {
    const request = JSON.parse(text);
    requests.push(request);
    queueMicrotask(() => handleArchiveMessage({
      action: 'set_session_archive_result', requestId: request.requestId, deviceName: 'D', projectHash: 'batch',
      results: request.sessionIds.map((sessionId) => ({
        sessionId, ok: requests.length > 1 || sessionId === 'codex:success',
        ...(requests.length === 1 && sessionId !== 'codex:success' ? { error: 'External writer busy' } : {}),
      })),
    }));
  } };
  const results = [];
  initSessionArchive({ results: (_operation, items) => { results.push(items); } });
  document.getElementById('focus').focus();
  openArchiveDialog([{ sessionId: 'codex:success' }, { sessionId: 'codex:failed' }], true);
  await submitArchive();
  assert.match(document.getElementById('archiveError').textContent, /External writer busy/);
  assert.equal(results[0].filter((item) => item.ok).length, 1);
  assert.equal(document.getElementById('archiveConfirmBtn').textContent, 'Retry failed');
  await submitArchive();
  assert.deepEqual(requests[1].sessionIds, ['codex:failed']);
  assert.equal(document.getElementById('archiveModal').style.display, 'none');
  assert.equal(document.activeElement.id, 'focus');
  openArchiveDialog([{ sessionId: 'codex:offline' }], false);
  state.deviceOnlineMap.D = false;
  await submitArchive();
  assert.equal(requests.length, 2);
  assert.match(document.getElementById('archiveError').textContent, /no operation was queued/i);
});
