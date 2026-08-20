import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();

test('sync_complete merges new rows without rebuilding live tool DOM', async () => {
  resetSession(h, { sessionId: 'codex:thread-1' });
  const container = h.document.querySelector('.messages');
  container.innerHTML = [
    '<div class="msg-user" data-anchor="client-1">question</div>',
    '<div class="assistant-turn">',
    '<div class="tl-item tool-node" data-tool-id="tool-1">',
    '<div class="tool-body-content open">expanded</div>',
    '</div>',
    '</div>',
  ].join('');
  const tool = container.querySelector('[data-tool-id="tool-1"]');
  h.state.wsAllMessages = [{
    uuid: 'assistant-1',
    type: 'assistant',
    content: [{
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    }],
  }];
  h.state.wsMessageUuids = new Set(['assistant-1']);
  h.state.wsRenderedCount = 1;
  h.state.wsMessageCount = 1;
  h.state.stickBottom = false;
  h.setApiResponse({
    messages: [{
      uuid: 'title-1',
      type: 'ai-title',
      content: 'Session title',
      timestamp: '2026-08-17T00:00:00.000Z',
    }],
    hasMore: false,
  });

  h.hooks.handleWsMessage({
    action: 'sync_complete',
    sessionId: 'codex:thread-1',
    status: 'complete',
    count: 1,
  });
  await h.tick(10);

  assert.equal(container.querySelector('[data-tool-id="tool-1"]'), tool);
  assert.equal(tool.querySelector('.tool-body-content').classList.contains('open'), true);
  assert.equal(h.state.stickBottom, false);
});

test('sync_complete replaces the session skeleton with complete history', async () => {
  resetSession(h, { sessionId: 'codex:thread-skeleton' });
  h.state.appState.runtime = 'codex';
  h.document.getElementById('content').innerHTML = [
    '<div class="messages skeleton-messages">',
    '<div class="skeleton-user"></div>',
    '<div class="assistant-turn"><div class="assistant-text">live draft</div></div>',
    '</div>',
  ].join('');
  h.setApiResponse({
    messages: [{
      uuid: 'assistant-final',
      type: 'assistant',
      content: [{ type: 'text', text: 'final response' }],
      timestamp: '2026-08-20T00:00:00.000Z',
    }],
    hasMore: false,
  });

  h.hooks.handleWsMessage({
    action: 'sync_complete',
    sessionId: 'codex:thread-skeleton',
    status: 'complete',
    count: 1,
  });
  await h.tick(10);

  assert.equal(h.document.querySelector('.skeleton-messages'), null);
  assert.equal(h.document.querySelectorAll('.messages').length, 1);
  assert.equal(
    h.document.querySelector('.messages').textContent.includes('live draft'),
    false,
  );
  assert.equal(
    h.document.querySelector('.messages').textContent.includes('final response'),
    true,
  );
});
