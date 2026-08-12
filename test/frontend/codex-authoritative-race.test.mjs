import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { replay } from './replay.mjs';

const SESSION_ID = 'codex:authoritative-race';
const STREAM_ID = 'stream-authoritative-race';

function send(h, action, extra = {}) {
  h.hooks.handleWsMessage({
    action,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    ...extra,
  });
}

test('an Explore row cannot clear an earlier completed text preview', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'codex';
  globalThis.renderSingleMessage = h.window.renderSingleMessage = (message) => {
    return (message.content || []).map((block) => {
      if (block.type === 'tool_use') {
        return `<div class="tl-item tool-node codex-explore" data-tool-id="${block.id}" `
          + `data-ts="${message.timestamp || ''}">${block.name}</div>`;
      }
      if (block.type === 'text') {
        return `<div class="tl-item assistant-text" data-ts="${message.timestamp || ''}">${block.text || ''}</div>`;
      }
      return '';
    }).join('');
  };

  await replay(h, [
    { u: 'race the watcher' },
    { ack: 'race the watcher', streamId: STREAM_ID },
  ]);
  send(h, 'stream_block_start', {
    seq: 0, blockId: 0, kind: 'text',
  });
  send(h, 'stream_delta', {
    seq: 1, blockId: 0, chunk: 'visible progress',
  });
  send(h, 'stream_block_stop', {
    seq: 2, blockId: 0,
  });
  await h.tick(150);
  assert.match(h.document.querySelector('.messages').textContent, /visible progress/);

  // Watcher/extractor traffic is independent from app-server streaming. A later
  // tool row can therefore reach the browser before the preceding text item's
  // authoritative row.
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    messages: [{
      uuid: 'watcher-explore-overtake',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-explore-overtake',
        name: 'WebSearch',
        input: { action: 'search', query: 'race' },
      }],
      timestamp: '2026-08-11T00:00:02.000Z',
    }],
  });

  assert.match(
    h.document.querySelector('.messages').textContent,
    /visible progress/,
    'a later tool row must not remove the preceding streamed text',
  );

  send(h, 'messages', {
    messages: [{
      uuid: 'live-text-after-explore',
      nativeId: 'codex:item:text-before-explore',
      type: 'assistant',
      content: [{ type: 'text', text: 'visible progress' }],
      timestamp: '2026-08-11T00:00:01.000Z',
    }],
  });
  send(h, 'stream_block_start', {
    seq: 3, blockId: 1, kind: 'tool_use', name: 'WebSearch',
  });
  send(h, 'stream_tool_input', {
    seq: 4, blockId: 1, chunk: '{"action":"search","query":"race"}',
  });
  send(h, 'stream_block_stop', {
    seq: 5, blockId: 1,
  });
  await h.tick(150);

  const text = h.document.querySelector('.messages').textContent;
  assert.equal(text.match(/visible progress/g)?.length, 1);
  assert.equal(text.match(/WebSearch/g)?.length, 1);
});
