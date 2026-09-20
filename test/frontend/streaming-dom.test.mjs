import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { StreamingDomRenderer } from '../../web/js/streaming.js';

function createRenderer() {
  const dom = new JSDOM('<div class="messages"></div>');
  const frames = [];
  const revealed = [];
  const renderer = new StreamingDomRenderer({
    document: dom.window.document,
    getContainer: () => dom.window.document.querySelector('.messages'),
    findAnchor: (turnId) => dom.window.document.querySelector(
      `[data-anchor="${turnId}"]`,
    ),
    renderMarkdown: (element, text) => { element.textContent = text; },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
    revealMinimum: 1,
    onBlockRevealComplete: (turnId, blockId) => {
      revealed.push([turnId, blockId]);
    },
  });
  return {
    document: dom.window.document,
    frames,
    revealed,
    renderer,
    ensureAnchor(turnId) {
      const container = dom.window.document.querySelector('.messages');
      if (!container.querySelector(`[data-anchor="${turnId}"]`)) {
        container.insertAdjacentHTML(
          'beforeend',
          `<div class="msg-user" data-anchor="${turnId}">question</div>`,
        );
      }
    },
    flushFrames() {
      while (frames.length) frames.shift()();
    },
  };
}

function createText(renderer, turnId = 'turn-1', blockId = 1) {
  const container = renderer.getContainer();
  if (!container.querySelector(`[data-anchor="${turnId}"]`)) {
    container.insertAdjacentHTML(
      'beforeend',
      `<div class="msg-user" data-anchor="${turnId}">question</div>`,
    );
  }
  renderer.applyOperations([
    { type: 'createTurn', turnId },
    {
      type: 'createBlock',
      turnId,
      blockId,
      block: { blockId, kind: 'text', text: '' },
    },
  ]);
}

test('ordered delta operations append each character exactly once', () => {
  const h = createRenderer();
  createText(h.renderer);
  h.renderer.applyOperations([
    { type: 'appendText', turnId: 'turn-1', blockId: 1, chunk: 'A' },
    { type: 'appendText', turnId: 'turn-1', blockId: 1, chunk: 'B' },
    { type: 'finishBlockInput', turnId: 'turn-1', blockId: 1 },
  ]);
  h.flushFrames();

  assert.equal(h.document.querySelector('[data-block-id="1"]').textContent, 'AB');
  assert.deepEqual(h.revealed, [['turn-1', 1]]);
});

test('blocks arriving after an interrupt remain before the turn footer', () => {
  const harness = createRenderer();
  createText(harness.renderer);
  const turn = harness.document.querySelector('[data-turn-id="turn-1"]');
  const interrupt = harness.document.createElement('div');
  interrupt.className = 'tl-item msg-interrupt';
  interrupt.textContent = 'Interrupted';
  turn.appendChild(interrupt);

  createText(harness.renderer, 'turn-1', 2);
  createText(harness.renderer, 'turn-1', 3);

  assert.deepEqual(
    [...turn.children].map(child => child.dataset.blockId || child.textContent),
    ['1', '2', '3', 'Interrupted'],
  );
  assert.equal(turn.lastElementChild, interrupt);
  assert.equal(turn.querySelectorAll('.msg-interrupt').length, 1);
});

test('live thinking uses the collapsible Thinking component from its first frame', () => {
  const h = createRenderer();
  h.ensureAnchor('turn-thinking');
  h.renderer.applyOperations([
    { type: 'createTurn', turnId: 'turn-thinking' },
    {
      type: 'createBlock',
      turnId: 'turn-thinking',
      blockId: 1,
      block: { blockId: 1, kind: 'thinking', text: '' },
    },
    {
      type: 'appendText',
      turnId: 'turn-thinking',
      blockId: 1,
      chunk: 'reasoning',
    },
  ]);
  h.flushFrames();

  const block = h.document.querySelector('.thinking-block');
  const toggle = block.querySelector('.thinking-toggle');
  const body = block.querySelector('.thinking-body');
  assert.ok(block);
  assert.equal(toggle.textContent, 'Thinking ›');
  assert.ok(toggle.querySelector('.thinking-chevron'));
  assert.equal(body.textContent, 'reasoning');

  toggle.click();
  assert.equal(toggle.classList.contains('open'), true);
  assert.equal(body.style.display, 'block');
});

test('authority patches the existing block instead of creating a duplicate', () => {
  const h = createRenderer();
  createText(h.renderer);
  const original = h.document.querySelector('[data-block-id="1"]');
  h.renderer.applyOperations([
    { type: 'appendText', turnId: 'turn-1', blockId: 1, chunk: 'draft' },
    { type: 'commitBlock', turnId: 'turn-1', blockId: 1 },
    {
      type: 'patchBlock',
      turnId: 'turn-1',
      blockId: 1,
      block: {
        blockId: 1,
        kind: 'text',
        text: 'final',
        displayComplete: true,
      },
    },
  ]);

  assert.equal(h.document.querySelectorAll('[data-block-id="1"]').length, 1);
  assert.equal(h.document.querySelector('[data-block-id="1"]'), original);
  assert.equal(original.textContent, 'final');
});

test('freezing a local block renders all visible text without claiming authority', () => {
  const h = createRenderer();
  createText(h.renderer);
  const original = h.document.querySelector('[data-block-id="1"]');
  h.renderer.applyOperations([
    { type: 'appendText', turnId: 'turn-1', blockId: 1, chunk: 'partial' },
    {
      type: 'patchBlock',
      turnId: 'turn-1',
      blockId: 1,
      block: {
        blockId: 1,
        kind: 'text',
        text: 'partial answer',
        stopped: true,
        displayComplete: true,
        authoritative: false,
      },
    },
    { type: 'commitBlock', turnId: 'turn-1', blockId: 1 },
    { type: 'completeTurn', turnId: 'turn-1' },
  ]);

  assert.equal(original.textContent, 'partial answer');
  assert.equal(original.classList.contains('stream-block-committed'), true);
  assert.equal(original.classList.contains('stream-block-authoritative'), false);
  assert.equal(
    original.parentElement.classList.contains('stream-committed'),
    true,
  );
});

test('discarding the only incomplete block removes its empty live turn', () => {
  const h = createRenderer();
  createText(h.renderer);
  h.renderer.applyOperation({
    type: 'discardBlock',
    turnId: 'turn-1',
    blockId: 1,
  });

  assert.equal(h.document.querySelector('[data-block-id="1"]'), null);
  assert.equal(h.document.querySelector('[data-turn-id="turn-1"]'), null);
});

for (const identity of ['block', 'tool']) {
  for (const collapsed of [true, false]) {
    test(`adopting history by ${identity} identity preserves ${collapsed ? 'collapsed' : 'expanded'} details`, () => {
      const harness = createRenderer();
      const container = harness.document.querySelector('.messages');
      const blockAttribute = identity === 'block' ? ' data-block-id="1"' : '';
      container.innerHTML = '<div class="msg-user" data-anchor="turn-1">question</div>'
        + '<div class="assistant-turn" data-turn-id="turn-1">'
        + `<div class="tl-item tool-node${collapsed ? ' tool-details-collapsed' : ''}" data-tool-id="tool-1"${blockAttribute}>`
        + `<div class="tool-header tool-details-toggle" aria-expanded="${!collapsed}">Bash</div>`
        + '<div class="tool-body">history output</div></div></div>';
      const historical = container.querySelector('.tool-node');
      const block = { kind: 'tool_use', name: 'Bash', toolUseId: 'tool-1' };

      harness.renderer.applyOperations([
        { type: 'createBlock', turnId: 'turn-1', blockId: 1, block },
        { type: 'confirmBlock', turnId: 'turn-1', blockId: 1, block },
      ]);

      assert.equal(container.querySelectorAll('.tool-node').length, 1);
      assert.equal(container.querySelector('[data-block-id="1"]'), historical);
      assert.equal(historical.classList.contains('tool-details-collapsed'), collapsed);
      assert.equal(historical.querySelector('.tool-header').getAttribute('aria-expanded'), String(!collapsed));
      assert.equal(historical.querySelector('.tool-body').textContent, 'history output');
    });
  }
}

test('reset removes provisional live turns and pending reveal work', () => {
  const h = createRenderer();
  createText(h.renderer);
  h.renderer.applyOperation({
    type: 'appendText',
    turnId: 'turn-1',
    blockId: 1,
    chunk: 'pending',
  });
  h.renderer.reset();

  assert.equal(h.document.querySelector('[data-turn-id="turn-1"]'), null);
  assert.equal(h.renderer.blockViews.size, 0);
});
