// Two-finger pinch zoom for the PDF.js and Office viewers: CSS-scale while the fingers move (smooth, no
// re-render), then apply the real scale on release and keep the pinch midpoint under the fingers.
// `pages` is the content element at the scroll origin, or a function returning positioned page elements.
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

function gesture(container, touches) {
  const [a, b] = touches;
  const box = container.getBoundingClientRect();
  return {
    distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    x: (a.clientX + b.clientX) / 2 - box.left,
    y: (a.clientY + b.clientY) / 2 - box.top,
  };
}

export function attachPinchZoom(container, pages, viewer, onZoom) {
  let pinch = null;
  container.addEventListener('touchstart', event => {
    if (event.touches.length !== 2 || !viewer.pagesCount) return;
    const start = gesture(container, event.touches);
    // Content-space point under the fingers; .pdfViewer starts at the scroll origin.
    const own = typeof pages === 'function';
    pinch = { ...start, scale: viewer.currentScale, ratio: 1,
      originX: container.scrollLeft + start.x, originY: container.scrollTop + start.y,
      surfaces: own ? pages() : [pages] };
    for (const el of pinch.surfaces) {
      el.style.transformOrigin = (pinch.originX - (own ? el.offsetLeft : 0)) + 'px '
        + (pinch.originY - (own ? el.offsetTop : 0)) + 'px';
    }
  }, { passive: true });
  container.addEventListener('touchmove', event => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
      pinch.scale * gesture(container, event.touches).distance / pinch.distance));
    pinch.ratio = target / pinch.scale;
    for (const el of pinch.surfaces) el.style.transform = 'scale(' + pinch.ratio + ')';
  }, { passive: false });
  const end = () => {
    if (!pinch) return;
    const { ratio, scale, originX, originY, x, y, surfaces } = pinch;
    pinch = null;
    for (const el of surfaces) {
      el.style.transform = '';
      el.style.transformOrigin = '';
    }
    if (Math.abs(ratio - 1) < 0.01) return;
    onZoom();
    viewer.currentScale = scale * ratio;
    container.scrollLeft = originX * ratio - x;
    container.scrollTop = originY * ratio - y;
  };
  container.addEventListener('touchend', end);
  container.addEventListener('touchcancel', end);
  // iOS Safari ignores user-scalable=no; keep its page zoom out of the PDF gesture.
  container.addEventListener('gesturestart', event => event.preventDefault());
}
