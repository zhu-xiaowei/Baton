import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

test('sync_complete merges new rows without rebuilding live tool DOM', async () => {
  const h = await makeHarness();
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
});
