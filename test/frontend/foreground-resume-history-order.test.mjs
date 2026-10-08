import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

function event(sessionId, turnId, seq, action, extra = {}) {
  return { action, sessionId, turnId, seq, executionId: turnId, executionSeq: seq, ...structuredClone(extra) };
}

async function useProductionRenderer(h) {
  const expose = (name, value) => { globalThis[name] = value; h.window[name] = value; };
  expose('renderAssistantText', (text) => `<div class="md">${text}</div>`);
  await import('../../web/js/components/message.js');
  for (const name of [
    'renderThinking', 'renderUserBubble', 'renderInterrupt', 'renderSystemEvent', 'renderSummary',
    'renderLocalCommandStdout', 'isToolResultOnly', 'isInterruptMsg', 'isLocalCommandStdout',
  ]) expose(name, h.window[name]);
  expose('clampOverflow', () => {});
  await import('../../web/js/components/tool.js');
  expose('renderToolNode', h.window.renderToolNode);
  await import('../../web/js/render.js');
  expose('renderMessages', h.window.renderMessages);
  expose('renderSingleMessage', h.window.renderSingleMessage);
}

// Reproduces a captured browser HAR: the page was suspended mid-turn, the
// foreground refresh rendered the turn so far from REST, and the live turn
// resumed at the next block checkpoint. Its terminal authority must not remove
// or reorder the content that existed before the refresh.
test('foreground refresh keeps pre-checkpoint history in order at turn end', async () => {
  const h = await makeHarness();
  await useProductionRenderer(h);
  const sessionId = 'codex:foreground-resume-order';
  const turnId = 'sent-foreground-resume-order';
  resetSession(h, { sessionId });

  const user = {
    uuid: 'codex:user:' + turnId,
    nativeId: 'codex:user:' + turnId,
    type: 'user',
    content: 'run the steps',
    timestamp: '2026-10-08T05:58:15.000Z',
  };
  const commentary = {
    uuid: 'codex:item:msg-commentary',
    nativeId: 'codex:item:msg-commentary',
    type: 'assistant',
    content: [{ type: 'text', text: 'first commentary' }],
    timestamp: '2026-10-08T05:58:20.000Z',
  };
  const toolUse = {
    uuid: 'codex:item:call-1:tool-use',
    nativeId: 'codex:item:call-1:tool-use',
    type: 'assistant',
    content: [{ type: 'tool_use', id: 'codex_tool_1', name: 'Bash', input: { command: 'ls' } }],
    timestamp: '2026-10-08T05:58:21.000Z',
    stopReason: 'tool_use',
  };
  const toolResult = {
    uuid: 'codex:item:call-1:tool-result',
    nativeId: 'codex:item:call-1:tool-result',
    type: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'codex_tool_1', content: 'ok', is_error: false }],
    timestamp: '2026-10-08T05:58:29.000Z',
  };
  const final = {
    uuid: 'codex:item:msg-final',
    nativeId: 'codex:item:msg-final',
    type: 'assistant',
    content: [{ type: 'text', text: 'final summary' }],
    timestamp: '2026-10-08T05:58:39.000Z',
  };

  for (const item of [
    event(sessionId, turnId, 0, 'stream_turn_start'),
    event(sessionId, turnId, 1, 'messages', { messages: [user] }),
    event(sessionId, turnId, 2, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 3, 'stream_delta', { chunk: 'first commentary' }),
    event(sessionId, turnId, 4, 'stream_block_stop'),
    event(sessionId, turnId, 5, 'messages', { messages: [commentary] }),
    event(sessionId, turnId, 6, 'stream_block_start', { kind: 'tool_use', name: 'Bash' }),
    event(sessionId, turnId, 7, 'stream_tool_input', { chunk: '{"command":"ls"}' }),
    event(sessionId, turnId, 8, 'stream_block_stop'),
    event(sessionId, turnId, 9, 'messages', { messages: [toolUse] }),
  ]) h.hooks.handleWsMessage(item);
  await h.tick(30);

  // Foreground refresh while the turn is still running.
  h.state.ws = { readyState: WebSocket.OPEN, send() {} };
  const restSnapshots = [
    { messages: [user, commentary, toolUse], hasMore: false, status: 'running' },
    // Gap recovery after the refresh reset the execution queue.
    { messages: [user, commentary, toolUse, toolResult, final], hasMore: false, status: 'completed' },
  ];
  h.setApiHandler(async () => structuredClone(restSnapshots.shift() || restSnapshots.at(-1)));
  await h.window.loadLatestMessages(sessionId);
  await h.tick(30);

  for (const item of [
    event(sessionId, turnId, 10, 'messages', { messages: [toolResult] }),
    event(sessionId, turnId, 11, 'stream_block_start', { kind: 'text' }),
    event(sessionId, turnId, 12, 'stream_delta', { chunk: 'final summary' }),
    event(sessionId, turnId, 13, 'stream_block_stop'),
    event(sessionId, turnId, 14, 'messages', { messages: [final] }),
    event(sessionId, turnId, 15, 'stream_end', {
      messages: [commentary, toolUse, toolResult, final],
    }),
  ]) h.hooks.handleWsMessage(item);

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && (h.state.wsRunning
    || h.document.querySelector('.stream-preview'))) {
    await h.tick(10);
  }
  await h.tick(30);

  const container = h.document.querySelector('.messages');
  const order = [...container.querySelectorAll('.tl-item')].map((element) =>
    element.classList.contains('tool-node')
      ? 'tool'
      : element.textContent.trim());
  assert.deepEqual(order, ['first commentary', 'tool', 'final summary'], container.innerHTML);
});
