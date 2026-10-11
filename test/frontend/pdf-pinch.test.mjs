import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { MAX_SCALE, attachPinchZoom } from '../../web/js/components/pdf-pinch.js';

const { window } = new JSDOM('<div class="pdf-container"><div class="pdfViewer"></div></div>');
const container = window.document.querySelector('.pdf-container');
const pages = window.document.querySelector('.pdfViewer');
container.getBoundingClientRect = () => ({ left: 0, top: 100 });
const viewer = { pagesCount: 3, currentScale: 1 };
let zoomed = 0;
attachPinchZoom(container, pages, viewer, () => { zoomed++; });

function touch(type, spread) {
  const event = new window.Event(type, { cancelable: true });
  event.touches = spread ? [{ clientX: 200 - spread, clientY: 300 }, { clientX: 200 + spread, clientY: 300 }] : [];
  container.dispatchEvent(event);
  return event;
}

test('pinching previews with CSS, then applies the scale around the fingers', () => {
  container.scrollLeft = 10;
  container.scrollTop = 50;
  touch('touchstart', 50);
  assert.equal(touch('touchmove', 100).defaultPrevented, true);
  assert.equal(pages.style.transform, 'scale(2)');
  assert.equal(viewer.currentScale, 1);
  touch('touchend');
  assert.equal(pages.style.transform, '');
  assert.equal(viewer.currentScale, 2);
  assert.equal(zoomed, 1);
  // The content point under the midpoint (210, 250) stays at container offset (200, 200).
  assert.equal(container.scrollLeft, 220);
  assert.equal(container.scrollTop, 300);
});

test('pinch scale is clamped and a still pinch keeps fit-width', () => {
  touch('touchstart', 10);
  touch('touchmove', 1000);
  touch('touchend');
  assert.equal(viewer.currentScale, MAX_SCALE);
  touch('touchstart', 50);
  touch('touchend');
  assert.equal(viewer.currentScale, MAX_SCALE);
  assert.equal(zoomed, 2);
});
