import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

test('a streaming Explore joins the existing group before authoritative handoff', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:explore-streaming' });
  h.state.appState.runtime = 'codex';
  await import('../../web/js/render.js');

  const container = h.document.querySelector('.messages');
  container.innerHTML = [
    '<div class="assistant-turn">',
    '<div class="tl-item tool-node codex-explore">first explore</div>',
    '</div>',
  ].join('');
  h.window.markTurnAdjacency(container);

  h.hooks.pushStreamFrame('explore-stream', {
    t: 'start',
    seq: 0,
    blockId: 0,
    kind: 'tool_use',
    name: 'Bash',
  });
  h.hooks.pushStreamFrame('explore-stream', {
    t: 'input',
    seq: 1,
    blockId: 0,
    chunk: JSON.stringify({
      command: 'rg -n tool web/js',
      codexCommandActions: [{ type: 'search', query: 'tool', path: 'web/js' }],
    }),
  });
  await h.tick(100);

  const explores = container.querySelectorAll('.codex-explore');
  assert.equal(explores.length, 2);
  assert.ok(explores[0].classList.contains('codex-explore-group-start'));
  assert.ok(!explores[0].classList.contains('codex-explore-group-connected'));
  assert.ok(explores[1].classList.contains('codex-explore-continuation'));
  assert.ok(!explores[1].classList.contains('codex-explore-group-connected'));

  h.hooks.pushStreamFrame('explore-stream', {
    t: 'stop',
    seq: 2,
    blockId: 0,
  });
  await h.tick(20);

  const renderAuthoritative = (message) => (message.content || []).map((block) => {
    if (block.type !== 'tool_use') return '';
    const explore = block.input?.codexCommandKind === 'explore';
    return `<div class="tl-item tool-node${explore ? ' codex-explore' : ''}" `
      + `data-tool-id="${block.id}"><div class="tool-header">`
      + `<span class="tool-name">${explore ? 'Explored' : 'Ran'}</span></div></div>`;
  }).join('');
  globalThis.renderSingleMessage = h.window.renderSingleMessage = renderAuthoritative;

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: 'codex:explore-streaming',
    streamId: 'explore-stream',
    messages: [{
      uuid: 'authoritative-explore',
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'authoritative-explore-tool',
        name: 'Bash',
        input: { command: 'rg -n tool web/js' },
      }],
      timestamp: '2026-08-12T00:00:01.000Z',
    }],
  });

  const finalExplores = container.querySelectorAll('.codex-explore');
  assert.equal(finalExplores.length, 2);
  assert.equal(container.querySelectorAll('.tool-name').length, 1);
  assert.equal(container.querySelector('.tool-name').textContent, 'Explored');
  assert.doesNotMatch(container.textContent, /Ran/);
  assert.equal(
    h.state.wsAllMessages[0].content[0].input.codexCommandKind,
    'explore',
  );
});
