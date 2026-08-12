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
});
