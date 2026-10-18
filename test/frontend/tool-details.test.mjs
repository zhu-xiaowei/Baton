import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div class="messages"></div></body>', {
  url: 'https://test/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { state } = await import('../../web/js/state.js');
const { handleWsRpcMessage } = await import('../../web/js/ws-rpc.js');
const { observeToolDetails, toolDetailsSource } = await import('../../web/js/tool-details.js');
await import('../../web/js/components/tool.js');
await import('../../web/js/components/message.js');
await import('../../web/js/render.js');

let sent = [];
window.wsSendReliable = (payload) => sent.push(payload);

function setup(session) {
  state.wsSessionId = session;
  state.appState = { device: 'Mac', runtime: 'claude', session };
  sent = [];
  document.body.innerHTML = '<div class="messages"></div>';
  window.resetToolDetails();
}

function addTool(id, { truncated = true, edit = false } = {}) {
  const toolUse = {
    type: 'tool_use', id, name: edit ? 'Edit' : 'Bash',
    input: edit ? { file_path: '/file.js', old_string: 'same', new_string: 'same' } : { command: 'echo preview' },
    ...(truncated ? { truncated: true } : {}),
  };
  const toolResult = { type: 'tool_result', tool_use_id: id, content: edit ? 'Modified successfully.' : 'preview' };
  const row = document.createElement('div');
  row.className = 'assistant-turn';
  row.innerHTML = `<div class="tool-node tool-details-collapsed ${edit ? '' : 'claude-bash'}" data-tool-id="${id}">`
    + window.renderToolNode(toolUse, toolResult, 'claude', { collapsed: true }) + '</div>';
  document.querySelector('.messages').append(row);
  return { node: row.firstElementChild, toolUse, toolResult };
}

function complete(request, tools) {
  handleWsRpcMessage({
    action: 'tool_details', requestId: request.requestId, ok: true,
    sequence: 0, complete: true, content: JSON.stringify({ details: tools }),
  });
}

test('untruncated tools expand without requesting details', async () => {
  setup('plain');
  const { node } = addTool('plain', { truncated: false });
  await window.toggleToolDetails(node.querySelector('.tool-header'));
  assert.equal(sent.length, 0);
  assert.equal(node.classList.contains('tool-details-collapsed'), false);
  const body = node.querySelector('.tool-body-content');
  window.toggleExpand(body);
  assert.equal(sent.length, 0);
  assert.equal(toolDetailsSource('plain'), undefined);
  observeToolDetails({ type: 'tool_use', id: '', truncated: true }, null);
  assert.equal(toolDetailsSource(''), undefined);
});

test('header stays local; body and Show more share one request and cache', async () => {
  setup('cached');
  const tool = addTool('cached');
  const header = tool.node.querySelector('.tool-header');
  await window.toggleToolDetails(header);
  assert.equal(sent.length, 0);
  const button = tool.node.querySelector('.tool-preview-more');
  await window.initializeToolDetails(tool.node);
  assert.equal(sent.length, 0);
  const originalSelection = window.getSelection;
  window.getSelection = () => ({ toString: () => 'selected text' });
  try {
    window.toggleExpand(tool.node.querySelector('.tool-value'));
    assert.equal(sent.length, 0);
  } finally { window.getSelection = originalSelection; }
  const loading = window.toggleExpand(tool.node.querySelector('.tool-value'));
  await window.loadToolDetailsMore(button);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].toolUseIds, ['cached']);
  complete(sent[0], [{
    toolUse: { ...tool.toolUse, truncated: false },
    toolResult: { ...tool.toolResult, content: '完整结果'.repeat(1000) },
  }]);
  await loading;
  assert.equal(tool.node.classList.contains('tool-details-collapsed'), false);
  assert.ok(tool.node.textContent.includes('完整结果'.repeat(100)));
  await window.toggleToolDetails(tool.node.querySelector('.tool-header'));
  await window.toggleToolDetails(tool.node.querySelector('.tool-header'));
  assert.equal(sent.length, 1);

  tool.node.innerHTML = window.renderToolNode(tool.toolUse, tool.toolResult, 'claude', { collapsed: true });
  assert.equal(tool.node.querySelector('[data-tool-preview]'), null);
});

test('group expansion stays local and Show more requests only its own tool', async () => {
  setup('group');
  const one = addTool('one');
  const two = addTool('two');
  window.markToolRunGroups(document.querySelector('.messages'));
  window.toggleToolDetails(one.node.querySelector('.tool-header'));
  assert.equal(sent.length, 0);
  const button = one.node.querySelector('.tool-preview-more');
  const loading = window.loadToolDetailsMore(button);
  assert.deepEqual(sent[0].toolUseIds, ['one']);
  complete(sent[0], [{
    toolUse: { ...one.toolUse, truncated: false }, toolResult: one.toolResult,
  }]);
  await loading;
  assert.equal(one.node.querySelector('.tool-run-group-count').textContent, '×2');
  assert.equal(two.node.classList.contains('tool-run-group-hidden'), false);
});

for (const failure of ['offline', 'timeout', 'missing output']) {
  test(`${failure} leaves the local preview readable and permits retry`, async () => {
    setup(failure);
    const tool = addTool(failure);
    window.toggleToolDetails(tool.node.querySelector('.tool-header'));
    const button = tool.node.querySelector('.tool-preview-more');
    const original = globalThis.setTimeout;
    let loading;
    try {
      if (failure === 'timeout') globalThis.setTimeout = callback => original(callback, 0);
      loading = window.loadToolDetailsMore(button);
    } finally { globalThis.setTimeout = original; }
    if (failure === 'offline') handleWsRpcMessage({ requestId: sent[0].requestId, ok: false, error: 'Device is offline.' });
    if (failure === 'missing output') complete(sent[0], [{ toolUse: tool.toolUse, toolResult: null }]);
    await loading;
    assert.equal(toolDetailsSource(failure).full, null);
    assert.ok(tool.node.querySelector('.tool-detail-error'));
    assert.equal(tool.node.querySelector('.tool-body-content').classList.contains('open'), true);
    assert.match(tool.node.textContent, /preview/);
    const retry = window.loadToolDetailsMore(button);
    assert.equal(sent.length, 2);
    complete(sent[1], [{ toolUse: { ...tool.toolUse, truncated: false }, toolResult: tool.toolResult }]);
    await retry;
    assert.ok(toolDetailsSource(failure).full);
    assert.equal(tool.node.querySelector('.tool-detail-error'), null);
  });
}

test('late responses do not open a tool after navigating to a different session', async () => {
  setup('old');
  const tool = addTool('old');
  window.toggleToolDetails(tool.node.querySelector('.tool-header'));
  const loading = window.loadToolDetailsMore(tool.node.querySelector('.tool-preview-more'));
  const request = sent[0];
  setup('new');
  document.querySelector('.messages').textContent = 'new session';
  complete(request, [{ toolUse: { ...tool.toolUse, truncated: false }, toolResult: tool.toolResult }]);
  await loading;
  assert.equal(document.querySelector('.messages').textContent, 'new session');
});

test('same-session DOM replacement during loading adopts the current tool node', async () => {
  setup('replacement');
  const tool = addTool('replacement');
  window.toggleToolDetails(tool.node.querySelector('.tool-header'));
  const loading = window.loadToolDetailsMore(tool.node.querySelector('.tool-preview-more'));
  document.querySelector('.messages').replaceChildren();
  const replacement = addTool('replacement');
  window.toggleToolDetails(replacement.node.querySelector('.tool-header'));
  complete(sent[0], [{
    toolUse: { ...tool.toolUse, truncated: false },
    toolResult: { ...tool.toolResult, content: 'complete replacement output' },
  }]);
  await loading;
  assert.equal(replacement.node.classList.contains('tool-details-collapsed'), false);
  assert.match(replacement.node.textContent, /complete replacement output/);
  assert.equal(sent.length, 1);
});

test('Edit retries failures, caches its loaded diff and invalidates changed previews', async () => {
  setup('edit');
  const tool = addTool('edit', { edit: true });
  const initialize = window.initializeToolDetails;
  let initialized = 0;
  window.initializeToolDetails = async (node) => {
    if (node.querySelector('[data-tool-preview]')) return;
    assert.ok(node.querySelector('.diff-container'));
    initialized++;
  };
  try {
    assert.equal(tool.node.querySelector('.diff-container'), null);
    const failed = window.toggleToolDetails(tool.node.querySelector('.tool-header'));
    handleWsRpcMessage({ requestId: sent[0].requestId, ok: false, error: 'Device is offline.' });
    await failed;
    assert.equal(tool.node.classList.contains('tool-details-collapsed'), true);
    assert.ok(tool.node.querySelector('.tool-detail-error'));
    const loading = window.toggleToolDetails(tool.node.querySelector('.tool-header'));
    assert.equal(sent.length, 2);
    complete(sent[1], [{
      toolUse: { ...tool.toolUse, truncated: false, input: {
        file_path: '/file.js', old_string: 'same'.repeat(200) + 'old',
        new_string: 'same'.repeat(200) + 'new',
      } },
      toolResult: tool.toolResult,
    }]);
    await loading;
    assert.equal(initialized, 1);
    assert.equal(tool.node.classList.contains('tool-details-collapsed'), false);
    const diff = tool.node.querySelector('.diff-container');
    window.toggleToolDetails(tool.node.querySelector('.tool-header'));
    window.toggleToolDetails(tool.node.querySelector('.tool-header'));
    assert.equal(sent.length, 2);
    assert.equal(tool.node.querySelector('.diff-container'), diff);
    window.toggleToolDetails(tool.node.querySelector('.tool-header'));
    const updated = { ...tool.toolUse, input: { ...tool.toolUse.input, file_path: '/updated.js' } };
    tool.node.innerHTML = window.renderToolNode(updated, tool.toolResult, 'claude', { collapsed: true });
    const refresh = window.toggleToolDetails(tool.node.querySelector('.tool-header'));
    assert.equal(sent.length, 3);
    complete(sent[2], [{
      toolUse: { ...updated, truncated: false, input: {
        file_path: '/updated.js', old_string: 'before', new_string: 'after',
      } }, toolResult: tool.toolResult,
    }]);
    await refresh;
    assert.equal(tool.node.classList.contains('tool-details-collapsed'), false);
  } finally { window.initializeToolDetails = initialize; }
});
