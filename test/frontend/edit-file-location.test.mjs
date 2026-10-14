import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createTestServer } from './helpers/vite.mjs';
import { createHash } from 'node:crypto';

const dom = new JSDOM(`<!doctype html><body>
  <div id="fileOverlay"><span id="fileOverlayTitle"></span>
    <div id="fileOverlayTabs"></div><div id="fileOverlayBody"></div>
  </div></body>`, { url: 'https://test/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
const vite = await createTestServer({
  root: new URL('../../web', import.meta.url).pathname, configFile: false,
  server: { middlewareMode: true }, appType: 'custom',
});
const { state } = await vite.ssrLoadModule('/js/state.js');
const { observeToolDetails, loadToolDetails, toolDetailsSource } = await vite.ssrLoadModule('/js/tool-details.js');
const { handleWsRpcMessage } = await vite.ssrLoadModule('/js/ws-rpc.js');
const { openFile, closeFileViewer } = await vite.ssrLoadModule('/js/project/file-viewer.js');

let sent = [];
const initialText = 'first\nsecond\nconst value = 2;\nconst ready = true;\nlast';
let fileText;
test.beforeEach(() => {
  fileText = initialText;
  state.wsSessionId = crypto.randomUUID();
  state.appState = { device: 'Mac', session: state.wsSessionId, project: { hash: 'project' } };
  state.wsAllMessages = [];
  state.fileCache.clear();
  sent = [];
  window.wsSendReliable = payload => {
    sent.push(payload);
    if (payload.action === 'project_files') queueMicrotask(() => handleWsRpcMessage({
      action: 'project_files', requestId: payload.requestId, ok: true,
      sequence: 0, complete: true, path: payload.path, key: 'file',
      content: fileText, contentVersion: createHash('sha256').update(fileText).digest('hex'),
    }));
  };
});
test.afterEach(() => closeFileViewer({ refresh: false }));
test.after(async () => { await vite.close(); dom.window.close(); });

async function loadEdit() {
  const preview = { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/file.js' }, truncated: true };
  state.wsAllMessages = [{ type: 'assistant', content: [preview] }];
  observeToolDetails(preview, null);
  const loading = loadToolDetails('edit');
  handleWsRpcMessage({
    action: 'tool_details', requestId: sent.at(-1).requestId, ok: true,
    sequence: 0, complete: true, content: JSON.stringify({ details: [{
      toolUse: { ...preview, truncated: false, input: {
        file_path: '/file.js', old_string: 'const value = 1;',
        new_string: 'const value = 2;\nconst ready = true;',
      } }, toolResult: null,
    }] }),
  });
  await loading;
}

async function showFile(line = '', toolId = 'edit') {
  openFile('/file.js', 'file.js', line, toolId);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (document.querySelector('.file-content')) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error('File viewer did not render');
}

function highlightedLines() {
  return [...document.querySelectorAll('.file-line-hl')].map(node => Number(node.textContent));
}

test('full file uses the dynamically loaded Edit snippet without expanding history data', async () => {
  await loadEdit();
  await showFile();
  assert.deepEqual(highlightedLines(), [3, 4]);
  assert.equal(state.wsAllMessages[0].content[0].input.new_string, undefined);
  assert.equal(sent.filter(message => message.action === 'tool_details').length, 1);
});

test('legacy Write snippets and explicit line hints still locate the file', async () => {
  state.wsAllMessages = [{ content: [{
    type: 'tool_use', id: 'write', name: 'Write',
    input: { content: 'const value = 2;\nconst ready = true;' },
  }] }];
  await showFile('', 'write');
  assert.deepEqual(highlightedLines(), [3, 4]);
  closeFileViewer({ refresh: false });
  await showFile('2', '');
  assert.deepEqual(highlightedLines(), [2]);
});

test('switching sessions cannot reuse a previous Edit location', async () => {
  await loadEdit();
  state.wsSessionId = 'another-session';
  state.wsAllMessages = [];
  await showFile();
  assert.deepEqual(highlightedLines(), []);
});

test('unexpanded Edit opens the file without requesting details', async () => {
  const preview = { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: '/file.js' }, truncated: true };
  state.wsAllMessages = [{ content: [preview] }];
  observeToolDetails(preview, null);
  await showFile();
  assert.deepEqual(highlightedLines(), []);
  assert.deepEqual(sent.map(message => message.action), ['project_files']);
});

test('file versions reuse locations and invalidate stale file text even if its cache key repeats', async () => {
  await loadEdit();
  await showFile();
  const location = toolDetailsSource('edit').fileLocation;
  closeFileViewer({ refresh: false });
  await showFile();
  assert.equal(toolDetailsSource('edit').fileLocation, location);
  closeFileViewer({ refresh: false });
  fileText = 'inserted\n' + initialText;
  await showFile();
  assert.deepEqual(highlightedLines(), [4, 5]);
  assert.notEqual(toolDetailsSource('edit').fileLocation, location);
  closeFileViewer({ refresh: false });
  fileText = 'const value = 2;\nconst ready = true;\nbetween\nconst value = 2;\nconst ready = true;';
  await showFile();
  assert.deepEqual(highlightedLines(), []);
  assert.equal(sent.filter(message => message.action === 'tool_details').length, 1);
});

test('a file closed during asynchronous location resolution stays closed', async () => {
  await loadEdit();
  openFile('/file.js', 'file.js', '', 'edit');
  closeFileViewer({ refresh: false });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(document.getElementById('fileOverlay').style.display, 'none');
  assert.equal(document.querySelector('.file-content'), null);
});
