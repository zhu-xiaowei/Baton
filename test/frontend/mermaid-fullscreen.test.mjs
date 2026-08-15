import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const source = fs.readFileSync(
  new URL('../../web/js/components/mermaid.js', import.meta.url),
  'utf8',
);
const markdownSource = fs.readFileSync(
  new URL('../../web/js/components/markdown.js', import.meta.url),
  'utf8',
);

function setupViewer() {
  const dom = new JSDOM(`<!doctype html><body>
    <div class="mermaid-block">
      <button class="mermaid-zoom"></button>
      <div class="mermaid-src">flowchart LR; A-->B</div>
      <div class="mermaid-svg">
        <svg viewBox="0 0 1000 500" width="1000" height="500">
          <text x="500" y="250">Vector diagram</text>
        </svg>
      </div>
    </div>
  </body>`, { runScripts: 'outside-only' });

  const rafQueue = [];
  dom.window.requestAnimationFrame = (callback) => {
    rafQueue.push(callback);
    return rafQueue.length;
  };
  dom.window.cancelAnimationFrame = () => {};
  dom.window.matchMedia = () => ({ matches: false });
  dom.window.eval(source);
  dom.window.openMermaidFullscreen(dom.window.document.querySelector('.mermaid-zoom'));

  const stage = dom.window.document.querySelector('.mermaid-fs-stage');
  const svg = stage.querySelector('svg');
  const viewport = { left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800 };
  stage.getBoundingClientRect = () => viewport;
  svg.getBoundingClientRect = () => viewport;
  dom.window.dispatchEvent(new dom.window.Event('resize'));

  return {
    dom,
    stage,
    svg,
    flushAnimation() {
      let now = 0;
      let turns = 0;
      while (rafQueue.length && turns < 240) {
        const callback = rafQueue.shift();
        now += 16.667;
        callback(now);
        turns++;
      }
      assert.ok(turns < 240, 'spring animation should settle');
    },
  };
}

function viewBox(svg) {
  return svg.getAttribute('viewBox').split(/\s+/).map(Number);
}

function gestureEvent(dom, type, values) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: values.clientX },
    clientY: { value: values.clientY },
    scale: { value: values.scale },
  });
  return event;
}

test('inline Mermaid preview is directly keyboard and pointer accessible for fullscreen', () => {
  assert.match(markdownSource, /class="mermaid-svg" role="button" tabindex="0"/);
  assert.match(markdownSource, /onclick="openMermaidFullscreen\(this\)"/);
  assert.match(markdownSource, /event\.key===\\'Enter\\'.*event\.key===\\' \\'/);
});

test('fullscreen Mermaid zoom stays SVG-native and changes viewBox instead of CSS transforms', () => {
  const viewer = setupViewer();
  const { dom, stage, svg } = viewer;
  const initial = viewBox(svg);

  stage.dispatchEvent(new dom.window.WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 200,
    clientY: 400,
    deltaY: -500,
  }));

  const zoomed = viewBox(svg);
  assert.ok(zoomed[2] < initial[2]);
  assert.ok(zoomed[3] < initial[3]);
  assert.equal(initial[2] / initial[3], 400 / 800);
  assert.equal(stage.style.transform, '');
  assert.equal(svg.tagName.toLowerCase(), 'svg');
  assert.equal(stage.querySelector('canvas, img'), null);
  assert.equal(stage.querySelector('.mermaid-fs-viewport'), null);
  assert.equal(viewer.stage.getBoundingClientRect().width, 400);
  assert.equal(svg.getAttribute('width'), '100%');
  assert.equal(svg.getAttribute('height'), '100%');
});

test('fullscreen Mermaid can zoom out to half of the initial fitted size', () => {
  const viewer = setupViewer();
  const { dom, stage, svg } = viewer;
  const initial = viewBox(svg);

  stage.dispatchEvent(new dom.window.WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 200,
    clientY: 400,
    deltaY: 1000,
  }));

  const zoomedOut = viewBox(svg);
  assert.equal(zoomedOut[2], initial[2] * 2);
  assert.equal(zoomedOut[3], initial[3] * 2);

  stage.dispatchEvent(new dom.window.WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 200,
    clientY: 400,
    deltaY: 1000,
  }));
  assert.deepEqual(viewBox(svg), zoomedOut);
});

test('iOS native pinch overscroll springs back to the half-scale boundary', () => {
  const viewer = setupViewer();
  const { dom, stage, svg } = viewer;
  const initial = viewBox(svg);

  stage.dispatchEvent(gestureEvent(dom, 'gesturestart', {
    clientX: 200,
    clientY: 400,
    scale: 1,
  }));
  stage.dispatchEvent(gestureEvent(dom, 'gesturechange', {
    clientX: 200,
    clientY: 400,
    scale: 0.1,
  }));

  const overscrolled = viewBox(svg);
  assert.ok(overscrolled[2] > initial[2] * 2);
  assert.ok(overscrolled[3] > initial[3] * 2);

  stage.dispatchEvent(gestureEvent(dom, 'gestureend', {
    clientX: 200,
    clientY: 400,
    scale: 0.1,
  }));
  viewer.flushAnimation();

  const settled = viewBox(svg);
  assert.equal(settled[2], initial[2] * 2);
  assert.equal(settled[3], initial[3] * 2);
});

test('fullscreen Mermaid pan resists overscroll and springs back inside the diagram', () => {
  const viewer = setupViewer();
  const { dom, stage, svg } = viewer;
  const initial = viewBox(svg);

  stage.dispatchEvent(new dom.window.MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 200,
    clientY: 400,
  }));
  dom.window.dispatchEvent(new dom.window.MouseEvent('mousemove', {
    clientX: 320,
    clientY: 520,
  }));

  const dragged = viewBox(svg);
  assert.ok(dragged[0] < initial[0]);
  assert.ok(dragged[1] < initial[1]);
  assert.ok(dragged[0] > initial[0] - 500, 'horizontal overscroll should be damped');
  assert.ok(dragged[1] > initial[1] - 500, 'vertical overscroll should be damped');

  dom.window.dispatchEvent(new dom.window.MouseEvent('mouseup'));
  viewer.flushAnimation();
  assert.deepEqual(viewBox(svg), initial);
});

test('fullscreen Mermaid zoomed pan springs to the nearest legal edge', () => {
  const viewer = setupViewer();
  const { dom, stage, svg } = viewer;

  stage.dispatchEvent(new dom.window.WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 200,
    clientY: 400,
    deltaY: -800,
  }));
  const zoomed = viewBox(svg);

  stage.dispatchEvent(new dom.window.MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 200,
    clientY: 400,
  }));
  dom.window.dispatchEvent(new dom.window.MouseEvent('mousemove', {
    clientX: 2000,
    clientY: 2000,
  }));
  dom.window.dispatchEvent(new dom.window.MouseEvent('mouseup'));
  viewer.flushAnimation();

  const settled = viewBox(svg);
  assert.equal(settled[0], 0);
  assert.ok(Math.abs(settled[1] - (500 - zoomed[3]) / 2) < 0.0001);
  assert.equal(settled[2], zoomed[2]);
  assert.equal(settled[3], zoomed[3]);
});
