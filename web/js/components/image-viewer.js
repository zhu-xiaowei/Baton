// Shared image preview gestures for chat images, staged images, and project files.
const MAX_SCALE = 5;
let overlay;
let image;
let scale = 1;
let x = 0;
let y = 0;
let touchMode = null;
let nativeGesture = null;

function baseCenter() {
  const rect = image.getBoundingClientRect();
  return { x: rect.left + rect.width / 2 - x, y: rect.top + rect.height / 2 - y };
}

function clampAxis(position, center, size, start, length) {
  if (size <= length) return 0;
  return Math.max(start + length - center - size / 2, Math.min(start - center + size / 2, position));
}

function setZoom(nextScale, nextX, nextY) {
  const center = baseCenter();
  const bounds = overlay.getBoundingClientRect();
  scale = Math.max(1, Math.min(MAX_SCALE, nextScale));
  x = clampAxis(nextX, center.x, image.offsetWidth * scale, bounds.left, bounds.width);
  y = clampAxis(nextY, center.y, image.offsetHeight * scale, bounds.top, bounds.height);
  image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  overlay.classList.toggle('zoomed', scale > 1);
}

function resetZoom() {
  scale = 1;
  x = 0;
  y = 0;
  touchMode = null;
  nativeGesture = null;
  image.style.transform = '';
  overlay.classList.remove('zoomed');
}

function midpoint(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function distance(touches) {
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY,
  );
}

function beginPinch(touches) {
  const point = midpoint(touches);
  const center = baseCenter();
  touchMode = {
    type: 'pinch',
    distance: Math.max(1, distance(touches)),
    scale,
    anchorX: (point.x - center.x - x) / scale,
    anchorY: (point.y - center.y - y) / scale,
  };
}

function beginPan(touch) {
  touchMode = { type: 'pan', startX: touch.clientX, startY: touch.clientY, x, y };
}

function onTouchStart(event) {
  if (event.touches.length === 1 && event.target.closest('button')) return;
  if (event.touches.length >= 2) {
    event.preventDefault();
    if (!nativeGesture) beginPinch(event.touches);
  } else if (event.touches.length === 1 && scale > 1) {
    event.preventDefault();
    beginPan(event.touches[0]);
  }
}

function onTouchMove(event) {
  if (nativeGesture) {
    event.preventDefault();
    return;
  }
  if (event.touches.length >= 2) {
    event.preventDefault();
    if (touchMode?.type !== 'pinch') beginPinch(event.touches);
    const point = midpoint(event.touches);
    const center = baseCenter();
    const nextScale = Math.max(1, Math.min(MAX_SCALE,
      touchMode.scale * distance(event.touches) / touchMode.distance));
    setZoom(nextScale,
      point.x - center.x - touchMode.anchorX * nextScale,
      point.y - center.y - touchMode.anchorY * nextScale);
  } else if (event.touches.length === 1 && scale > 1) {
    event.preventDefault();
    if (touchMode?.type !== 'pan') beginPan(event.touches[0]);
    setZoom(scale,
      touchMode.x + event.touches[0].clientX - touchMode.startX,
      touchMode.y + event.touches[0].clientY - touchMode.startY);
  }
}

function gesturePoint(event) {
  if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY };
  const bounds = overlay.getBoundingClientRect();
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

function onGestureStart(event) {
  event.preventDefault();
  const point = gesturePoint(event);
  const center = baseCenter();
  nativeGesture = {
    scale,
    anchorX: (point.x - center.x - x) / scale,
    anchorY: (point.y - center.y - y) / scale,
  };
  touchMode = null;
}

function onGestureChange(event) {
  if (!nativeGesture) return;
  event.preventDefault();
  const point = gesturePoint(event);
  const center = baseCenter();
  const nextScale = Math.max(1, Math.min(MAX_SCALE, nativeGesture.scale * (Number(event.scale) || 1)));
  setZoom(nextScale,
    point.x - center.x - nativeGesture.anchorX * nextScale,
    point.y - center.y - nativeGesture.anchorY * nextScale);
}

function ensureViewer() {
  if (overlay) return;
  overlay = document.getElementById('imgOverlay');
  image = document.getElementById('imgOverlayImg');
  overlay.addEventListener('click', event => {
    if (event.target.closest('.img-overlay-close')) closeImageViewer();
    else if (event.target === overlay || (event.target === image && scale === 1 && overlay.dataset.gallery !== '1')) {
      closeImageViewer();
    }
  });
  overlay.addEventListener('touchstart', onTouchStart, { passive: false });
  overlay.addEventListener('touchmove', onTouchMove, { passive: false });
  overlay.addEventListener('touchend', event => {
    if (!nativeGesture && event.touches.length === 1 && scale > 1) beginPan(event.touches[0]);
    else touchMode = null;
  });
  overlay.addEventListener('touchcancel', () => { touchMode = null; nativeGesture = null; });
  overlay.addEventListener('gesturestart', onGestureStart, { passive: false });
  overlay.addEventListener('gesturechange', onGestureChange, { passive: false });
  overlay.addEventListener('gestureend', event => {
    if (!nativeGesture) return;
    event.preventDefault();
    nativeGesture = null;
  }, { passive: false });
  image.addEventListener('dragstart', event => event.preventDefault());
}

function showImageViewer(src, gallery = false) {
  ensureViewer();
  resetZoom();
  if (!gallery) overlay.querySelector('.gallery-nav')?.remove();
  overlay.dataset.gallery = gallery ? '1' : '0';
  image.src = src;
  overlay.style.display = 'flex';
}

function closeImageViewer() {
  ensureViewer();
  overlay.style.display = 'none';
  resetZoom();
}

export { showImageViewer, closeImageViewer };
