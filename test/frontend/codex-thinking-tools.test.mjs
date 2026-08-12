import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { replay } from './replay.mjs';

const SESSION_ID = 'codex:thinking-tools';
const STREAM_ID = 'stream-thinking-tools';

function send(h, action, extra = {}) {
  h.hooks.handleWsMessage({
    action,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    ...extra,
  });
}

test('captured Codex commentary, Explore, and final sequence keeps stable rows', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'codex';

  const renderMessage = (message) => {
    const blocks = Array.isArray(message.content) ? message.content : [];
    return blocks.map((block) => {
      if (block.type === 'thinking') {
        return `<div class="tl-item thinking-tl" data-ts="${message.timestamp || ''}">`
          + `<div class="thinking-body">${block.thinking || ''}</div></div>`;
      }
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
  globalThis.renderSingleMessage = h.window.renderSingleMessage = renderMessage;

  await replay(h, [
    { u: 'inspect the code' },
    { ack: 'inspect the code', streamId: STREAM_ID },
  ]);

  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'delta', seq: 1, blockId: 0, chunk: 'first ',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'delta', seq: 2, blockId: 0, chunk: 'thought',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'start', seq: 0, blockId: 0, kind: 'text',
  });
  await h.tick(100);

  send(h, 'messages', {
    messages: [{
      uuid: 'live-commentary-1',
      nativeId: 'codex:item:commentary-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'first thought' }],
      timestamp: '2026-08-11T00:00:01.000Z',
    }],
  });

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    messages: [{
      uuid: 'watcher-explore-1',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-explore-1',
        name: 'Bash',
        input: { command: 'rg foo' },
      }],
      timestamp: '2026-08-11T00:00:02.000Z',
    }],
  });

  // The authoritative commentary and tool rows can beat the stop/tool stream
  // frames through the independent Lambda relay paths.
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'stop', seq: 3, blockId: 0,
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'start', seq: 4, blockId: 1, kind: 'tool_use', name: 'Bash',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'input', seq: 5, blockId: 1, chunk: '{"command":"rg foo"}',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'stop', seq: 6, blockId: 1,
  });
  await h.tick(100);

  assert.match(h.document.querySelector('.messages').textContent, /first thought/);
  assert.match(h.document.querySelector('.messages').textContent, /Bash/);

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    messages: [{
      uuid: 'watcher-search-1',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-search-1',
        name: 'WebSearch',
        input: { action: 'search', query: 'Codex overview' },
      }],
      timestamp: '2026-08-11T00:00:03.000Z',
    }],
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'start', seq: 7, blockId: 2, kind: 'tool_use', name: 'WebSearch',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'input', seq: 8, blockId: 2, chunk: '{"action":"search","query":"Codex overview"}',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'stop', seq: 9, blockId: 2,
  });
  await h.tick(100);

  assert.match(h.document.querySelector('.messages').textContent, /first thought/);
  assert.match(h.document.querySelector('.messages').textContent, /WebSearch/);

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    messages: [{
      uuid: 'watcher-open-1',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-open-1',
        name: 'WebSearch',
        input: { action: 'open_page', url: 'https://developers.openai.com/codex/overview/' },
      }],
      timestamp: '2026-08-11T00:00:04.000Z',
    }],
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'start', seq: 10, blockId: 3, kind: 'tool_use', name: 'WebSearch',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'input', seq: 11, blockId: 3,
    chunk: '{"action":"open_page","url":"https://developers.openai.com/codex/overview/"}',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'stop', seq: 12, blockId: 3,
  });
  await h.tick(100);

  assert.match(h.document.querySelector('.messages').textContent, /first thought/);

  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'start', seq: 13, blockId: 4, kind: 'text',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'delta', seq: 15, blockId: 4, chunk: ' am',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'delta', seq: 14, blockId: 4, chunk: 'I',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'delta', seq: 16, blockId: 4, chunk: ' Codex',
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'delta', seq: 17, blockId: 4, chunk: '.',
  });
  await h.tick(100);

  send(h, 'messages', {
    messages: [{
      uuid: 'live-final-1',
      nativeId: 'codex:item:final-1',
      type: 'assistant',
      content: [{ type: 'text', text: 'I am Codex.' }],
      timestamp: '2026-08-11T00:00:05.000Z',
    }],
  });
  h.hooks.pushStreamFrame(STREAM_ID, {
    t: 'stop', seq: 18, blockId: 4,
  });
  send(h, 'stream_end', { finalSeq: 19 });
  await h.tick(200);

  const items = Array.from(h.document.querySelectorAll('.tl-item'));
  const texts = items.map((item) => item.textContent);
  assert.equal(texts.filter((text) => text.includes('first thought')).length, 1);
  assert.equal(texts.filter((text) => text.includes('I am Codex.')).length, 1);
  assert.ok(texts.findIndex((text) => text.includes('first thought'))
    < texts.findIndex((text) => text.includes('I am Codex.')));
});
