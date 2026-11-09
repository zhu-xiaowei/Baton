import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><body><div class="messages"></div></body>', {
  url: 'https://test/', pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { state } = await import('../../web/js/state.js');
const { configureToolDetails, observeToolDetails, toolDetailsSource } = await import('../../web/js/tool-details.js');
await import('../../web/js/components/tool.js');
await import('../../web/js/components/message.js');
await import('../../web/js/render.js');

let sent = [];
configureToolDetails((device, method, params) => new Promise((resolve, reject) => sent.push({ device, method, ...params, resolve, reject })));

function setup(session) {
  state.wsSessionId = session;
  state.appState = { device: 'Mac', runtime: 'claude', session };
  sent = [];
  document.body.innerHTML = '<div class="messages"></div>';
  window.resetToolDetails();
}

function addTool(id, { truncated = true, edit = false, bodyless = false } = {}) {
  const toolUse = {
    type: 'tool_use', id, name: edit ? 'Edit' : 'Bash',
    input: edit ? { file_path: '/file.js', old_string: 'same', new_string: 'same' } : { command: 'echo preview' },
    ...(truncated ? { truncated: true } : {}),
  };
  const toolResult = bodyless // a history page leaves a truncated body out
    ? { type: 'tool_result', tool_use_id: id, truncated: true }
    : { type: 'tool_result', tool_use_id: id, content: edit ? 'Modified successfully.' : 'preview' };
  const row = document.createElement('div');
  row.className = 'assistant-turn';
  row.innerHTML = `<div class="tool-node tool-details-collapsed ${edit ? '' : 'claude-bash'}" data-tool-id="${id}">`
    + window.renderToolNode(toolUse, toolResult, 'claude', { collapsed: true }) + '</div>';
  document.querySelector('.messages').append(row);
  return { node: row.firstElementChild, toolUse, toolResult };
}

function complete(request, tools) {
  request.resolve({ details: tools });
}
const fail = (request, error) => request.reject(new Error(error));

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

test('a group without bodies loads its previews in one request, then Show more loads one tool', async () => {
  setup('previews');
  const tools = ['p1', 'p2', 'p3'].map((id) => addTool(id, { bodyless: true }));
  window.markToolRunGroups(document.querySelector('.messages'));
  const opening = window.toggleToolDetails(tools[0].node.querySelector('.tool-header'));
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].toolUseIds, sent[0].preview], [['p1', 'p2', 'p3'], true]);
  assert.equal(document.querySelectorAll('.tool-detail-loading').length, 1, 'one spinner, on the clicked row');
  assert.equal(tools[1].node.classList.contains('tool-run-group-hidden'), true, 'the group opens once the previews are here');
  complete(sent[0], tools.map((tool) => ({ toolUse: tool.toolUse,
    toolResult: { ...tool.toolResult, content: `${tool.toolUse.id} preview` } })));
  await opening;
  for (const tool of tools) {
    assert.equal(tool.node.classList.contains('tool-run-group-hidden'), false);
    assert.equal(tool.node.classList.contains('tool-details-collapsed'), false);
    assert.match(tool.node.textContent, new RegExp(`${tool.toolUse.id} preview`));
  }
  const loading = window.loadToolDetailsMore(tools[1].node.querySelector('.tool-preview-more'));
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1].toolUseIds, sent[1].preview], [['p2'], undefined]);
  complete(sent[1], [{ toolUse: { ...tools[1].toolUse, truncated: false }, toolResult: { ...tools[1].toolResult, truncated: false, content: 'p2 full' } }]);
  await loading;
  assert.match(tools[1].node.textContent, /p2 full/);
  window.toggleToolDetails(tools[0].node.querySelector('.tool-header'));
  await window.toggleToolDetails(tools[0].node.querySelector('.tool-header'));
  assert.equal(sent.length, 2, 'previews stay cached');
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
    const loading = window.loadToolDetailsMore(button);
    if (failure === 'offline') fail(sent[0], 'offline');
    if (failure === 'timeout') fail(sent[0], 'timeout');
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
    fail(sent[0], 'Device is offline.');
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

test('button and blank-area clicks toggle one tool-body height state', () => {
  setup('read-toggle');
  const row = document.createElement('div');
  row.innerHTML = window.renderToolNode(
    { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/a.js' } },
    { type: 'tool_result', tool_use_id: 'read', content: '1\tconst a = 1;' },
    'claude',
  );
  document.querySelector('.messages').append(row);
  const body = row.querySelector('.tool-body-content');
  const value = body.querySelector('.read-value');
  assert.equal(value.hasAttribute('onclick'), false);
  body.insertAdjacentHTML('beforeend', '<span class="clamp-btn">Show more</span>');
  const button = body.querySelector('.clamp-btn');
  window.toggleExpand(button.parentElement);
  assert.equal(body.classList.contains('open'), true);
  assert.equal(button.textContent, 'Show less');
  window.toggleExpand(value);
  assert.equal(body.classList.contains('open'), false);
  assert.equal(value.classList.contains('expanded'), false);
  assert.equal(button.textContent, 'Show more');
});
