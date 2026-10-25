// Shared image preview gestures for chat images, staged images, and project files.
import { downloadFile, nativeDownloads } from '../project/download.js';
import { imageMimeType } from './image-type.js';
import { setDownloadButtonState } from './download-button.js';
import { showToast } from './toast.js';

const MAX_SCALE = 5;
const ARROW = points => '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="' + points + '"/></svg>';
let overlay;
let image;
let downloadButton;
let items = [];
let index = 0;
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
  downloadButton = overlay.querySelector('.img-overlay-download');
  downloadButton?.addEventListener('click', downloadCurrentImage);
  overlay.addEventListener('click', event => {
    const step = event.target.closest('.gallery-nav button');
    if (step) showAt(index + Number(step.dataset.step));
    else if (event.target.closest('.img-overlay-close')) closeImageViewer();
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

function showAt(next) {
  const item = items[next];
  if (!item) return;
  index = next;
  resetZoom();
  image.src = item.src;
  overlay.dataset.gallery = items.length > 1 ? '1' : '0';
  overlay.querySelector('.gallery-nav')?.remove();
  if (items.length > 1) {
    overlay.insertAdjacentHTML('beforeend', '<div class="gallery-nav">'
      + '<button data-step="-1"' + (index <= 0 ? ' disabled' : '') + '>' + ARROW('15 18 9 12 15 6') + '</button>'
      + '<span>' + (index + 1) + ' / ' + items.length + '</span>'
      + '<button data-step="1"' + (index >= items.length - 1 ? ' disabled' : '') + '>' + ARROW('9 6 15 12 9 18') + '</button>'
      + '</div>');
  }
  if (downloadButton) {
    downloadButton.hidden = !item.key;
    setDownloadButtonState(downloadButton);
  }
}

// Native saving needs an HTTPS source; the browser saves the Blob already on screen.
async function downloadCurrentImage() {
  const item = items[index];
  if (!item?.key) return;
  setDownloadButtonState(downloadButton, 'busy');
  let result = 'failed';
  let objectUrl = '';
  try {
    let url = item.src;
    if (nativeDownloads()) {
      url = (await window.api('/api/bridge/image-url/' + encodeURIComponent(item.key),
        item.attachment ? { attachment: 'true' } : undefined)).url;
    } else if (!url.startsWith('blob:')) {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Image unavailable');
      url = objectUrl = URL.createObjectURL(await response.blob());
    }
    const saved = await downloadFile({ url, name: item.key, contentType: imageMimeType(item.key) });
    result = saved?.status === 'cancelled' ? 'idle' : 'done';
  } catch (error) {
    showToast(error.message || 'Could not download the image.');
  }
  if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  if (items[index] === item) setDownloadButtonState(downloadButton, result);
}

// items: [{ src, key?, attachment? }]; an item with a storage key can be downloaded.
function showImageViewer(list, start = 0) {
  ensureViewer();
  items = list;
  showAt(start);
  overlay.style.display = 'flex';
}

function closeImageViewer() {
  ensureViewer();
  overlay.style.display = 'none';
  resetZoom();
}

document.addEventListener('keydown', event => {
  if (!overlay || overlay.style.display !== 'flex') return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); showAt(index - 1); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); showAt(index + 1); }
  else if (event.key === 'Escape') closeImageViewer();
});

export { showImageViewer, closeImageViewer };
