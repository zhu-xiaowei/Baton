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

test('positioned page elements share one pinch origin, offset by their own position', () => {
  const scroller = window.document.createElement('div');
  const pages = [0, 500].map(top => {
    const page = window.document.createElement('div');
    Object.defineProperty(page, 'offsetTop', { value: top });
    Object.defineProperty(page, 'offsetLeft', { value: 16 });
    scroller.appendChild(page);
    return page;
  });
  scroller.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const office = { pagesCount: 1, currentScale: 0.5 };
  attachPinchZoom(scroller, () => pages, office, () => {});
  const fire = (type, spread) => {
    const event = new window.Event(type, { cancelable: true });
    event.touches = spread ? [{ clientX: 200 - spread, clientY: 600 }, { clientX: 200 + spread, clientY: 600 }] : [];
    scroller.dispatchEvent(event);
  };
  fire('touchstart', 50);
  assert.deepEqual(pages.map(page => page.style.transformOrigin), ['184px 600px', '184px 100px']);
  fire('touchmove', 100);
  assert.deepEqual(pages.map(page => page.style.transform), ['scale(2)', 'scale(2)']);
  fire('touchend');
  assert.deepEqual(pages.map(page => page.style.transform), ['', '']);
  assert.equal(office.currentScale, 1);
});
