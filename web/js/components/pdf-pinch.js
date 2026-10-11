// Two-finger pinch zoom for the PDF.js viewer: CSS-scale while the fingers move (smooth, no
// re-render), then apply the real scale on release and keep the pinch midpoint under the fingers.
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
    pinch = { ...start, scale: viewer.currentScale, ratio: 1,
      originX: container.scrollLeft + start.x, originY: container.scrollTop + start.y };
    pages.style.transformOrigin = pinch.originX + 'px ' + pinch.originY + 'px';
  }, { passive: true });
  container.addEventListener('touchmove', event => {
    if (!pinch || event.touches.length !== 2) return;
    event.preventDefault();
    const target = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
      pinch.scale * gesture(container, event.touches).distance / pinch.distance));
    pinch.ratio = target / pinch.scale;
    pages.style.transform = 'scale(' + pinch.ratio + ')';
  }, { passive: false });
  const end = () => {
    if (!pinch) return;
    const { ratio, scale, originX, originY, x, y } = pinch;
    pinch = null;
    pages.style.transform = '';
    pages.style.transformOrigin = '';
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
