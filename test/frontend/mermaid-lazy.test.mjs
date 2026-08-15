import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(
  new URL('../../web/js/components/mermaid.js', import.meta.url),
  'utf8',
);

function setupViewer({ mobile = false, count = 1 } = {}) {
  const blocks = Array.from({ length: count }, (_, index) => `
    <div class="mermaid-block">
      <div class="mermaid-src">flowchart LR; A${index}--&gt;B${index}</div>
      <div class="mermaid-svg">
        <svg viewBox="0 0 100 50"><text>${index}</text></svg>
      </div>
    </div>
  `).join('');
  const dom = new JSDOM(`<!doctype html><body><div id="content">${blocks}</div></body>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });

  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    value: mobile ? 'iPhone' : 'Desktop',
  });
  dom.window.matchMedia = () => ({ matches: mobile });

  const observers = [];
  class FakeIntersectionObserver {
    constructor(callback, options) {
      this.callback = callback;
      this.options = options;
      this.targets = new Set();
      this.unobserved = new Set();
      observers.push(this);
    }

    observe(target) {
      this.targets.add(target);
    }

    unobserve(target) {
      this.targets.delete(target);
      this.unobserved.add(target);
    }

    emit(entries) {
      this.callback(entries.map(({ target, isIntersecting }) => ({
        target,
        isIntersecting,
      })));
    }
  }
  dom.window.IntersectionObserver = FakeIntersectionObserver;

  const content = dom.window.document.getElementById('content');
  content.getBoundingClientRect = () => ({
    top: 0, left: 0, right: 400, bottom: 800, width: 400, height: 800,
  });
  const blockEls = Array.from(content.querySelectorAll('.mermaid-block'));
  blockEls.forEach((block, index) => {
    const code = block.querySelector('.mermaid-src').textContent.trim();
    block.querySelector('svg').setAttribute('data-mcode', code);
    block.getBoundingClientRect = () => {
      const top = index < 2 ? index * 320 : 1200 + index * 320;
      return {
        top,
        bottom: top + 300,
        left: 0,
        right: 400,
        width: 400,
        height: 300,
      };
    };
  });

  dom.window.eval(source);
  dom.window.renderMermaidBlocks(content);
  return { dom, content, blocks: blockEls, observer: observers[0] };
}

test('Mermaid renders only after entering the viewport preload range', () => {
  const { blocks, observer } = setupViewer();
  const block = blocks[0];
  const box = block.querySelector('.mermaid-svg');

  assert.equal(observer.targets.has(block), true);
  observer.emit([{ target: block, isIntersecting: false }]);
  assert.equal(box.querySelector('svg'), null);
  assert.equal(block.classList.contains('rendered'), false);

  observer.emit([{ target: block, isIntersecting: true }]);
  assert.ok(box.querySelector('svg'));
  assert.equal(block.classList.contains('rendered'), true);
});

test('mobile Mermaid keeps visible diagrams and caps live SVG nodes at six', () => {
  const { content, blocks, observer } = setupViewer({ mobile: true, count: 9 });

  assert.equal(observer.options.root, content);
  assert.equal(observer.options.rootMargin, '480px 0px');
  observer.emit(blocks.map((block) => ({ target: block, isIntersecting: true })));

  assert.equal(content.querySelectorAll('.mermaid-svg > svg').length, 6);
  assert.ok(blocks[0].querySelector('.mermaid-svg > svg'));
  assert.ok(blocks[1].querySelector('.mermaid-svg > svg'));
});

test('visible streaming Mermaid keeps the last SVG while a changed source rerenders', () => {
  const { dom, blocks, observer } = setupViewer();
  const block = blocks[0];
  const svg = block.querySelector('.mermaid-svg > svg');

  observer.emit([{ target: block, isIntersecting: true }]);
  block.querySelector('.mermaid-src').textContent = 'flowchart LR; A-->B; B-->C';
  dom.window.renderMermaidBlocks(block);

  assert.equal(block.querySelector('.mermaid-svg > svg'), svg);
});

test('removed Mermaid blocks are unobserved', async () => {
  const { dom, content, blocks, observer } = setupViewer();
  const block = blocks[0];

  block.remove();
  const replacement = dom.window.document.createElement('div');
  replacement.className = 'mermaid-block';
  replacement.innerHTML = '<div class="mermaid-src">flowchart LR; X-->Y</div><div class="mermaid-svg"></div>';
  content.appendChild(replacement);
  dom.window.renderMermaidBlocks(content);

  assert.equal(observer.unobserved.has(block), true);
});
