// Shared image preview gestures for chat images, staged images, and project files.
import { downloadFailure, downloadFile, nativeDownloads } from '../project/download.js';
import { imageMimeType } from './image-type.js';
import { setDownloadButtonState } from './download-button.js';
import { showToast } from './toast.js';

const MAX_SCALE = 5;
const SWIPE_MS = 200;
const SWIPE_GAP = 16; // matches .img-overlay-peek
const ARROW = points => '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="' + points + '"/></svg>';
let overlay;
let image;
let peeks = [];
let downloadButton;
let items = [];
let index = 0;
let scale = 1;
let x = 0;
let y = 0;
let touchMode = null;
let swipe = null;
let pendingSlide = null; // a settling swipe: { timer, finish }
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
  pendingSlide?.finish();
  if (swipe?.axis === 'x') placeStrip(0, ''); // a second finger ends the swipe
  swipe = null;
  if (event.touches.length === 1 && event.target.closest('button')) return;
  if (event.touches.length === 1 && scale === 1 && items.length > 1) {
    swipe = { x: event.touches[0].clientX, y: event.touches[0].clientY, dx: 0, axis: null };
  }
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
  } else if (event.touches.length === 1 && swipe) {
    event.preventDefault();
    const dx = event.touches[0].clientX - swipe.x;
    const dy = event.touches[0].clientY - swipe.y;
    if (!swipe.axis && Math.hypot(dx, dy) > 8) swipe.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (swipe.axis !== 'x') return;
    // The images follow the finger, with resistance past the first and last image.
    swipe.dx = items[index + (dx < 0 ? 1 : -1)] ? dx : dx / 3;
    placeStrip(swipe.dx, 'none');
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
  pendingSlide?.finish();
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
    // preventDefault drops the click that would otherwise follow a swipe.
    if (swipe?.axis === 'x' && !event.touches.length) {
      event.preventDefault();
      settleSwipe(swipe.dx);
    }
    swipe = null;
    if (!nativeGesture && event.touches.length === 1 && scale > 1) beginPan(event.touches[0]);
    else touchMode = null;
  });
  overlay.addEventListener('touchcancel', () => {
    if (swipe?.axis === 'x') placeStrip(0, '');
    swipe = null; touchMode = null; nativeGesture = null;
  });
  overlay.addEventListener('gesturestart', onGestureStart, { passive: false });
  overlay.addEventListener('gesturechange', onGestureChange, { passive: false });
  overlay.addEventListener('gestureend', event => {
    if (!nativeGesture) return;
    event.preventDefault();
    nativeGesture = null;
  }, { passive: false });
  image.addEventListener('dragstart', event => event.preventDefault());
  // The neighbouring images wait off screen, so a swipe shows the next one coming in like a photo strip.
  peeks = [-1, 1].map(side => {
    const peek = document.createElement('img');
    peek.className = 'img-overlay-peek';
    peek.alt = '';
    peek.dataset.side = side;
    overlay.append(peek);
    return peek;
  });
}

function showAt(next) {
  const item = items[next];
  if (!item) return;
  clearTimeout(pendingSlide?.timer);
  pendingSlide = null;
  index = next;
  resetZoom();
  image.src = item.src;
  peeks.forEach(peek => {
    const neighbour = items[index + Number(peek.dataset.side)];
    peek.hidden = !neighbour;
    if (neighbour) peek.src = neighbour.src;
  });
  placeStrip(0, '');
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

// Moves the current image and its neighbours together by `dx`.
function placeStrip(dx, transition) {
  image.style.transition = transition;
  image.style.transform = dx ? `translateX(${dx}px)` : '';
  peeks.forEach(peek => {
    peek.style.transition = transition;
    peek.style.transform = dx ? `translate(-50%, -50%) translateX(${dx}px)` : '';
  });
}

// Past 50px the strip settles on the neighbour, which then becomes the current image; otherwise it springs back.
function settleSwipe(dx) {
  const step = dx < 0 ? 1 : -1;
  const target = index + step;
  const turn = Math.abs(dx) >= 50 && !!items[target];
  placeStrip(turn ? -step * (overlay.clientWidth + SWIPE_GAP) : 0, `transform ${SWIPE_MS}ms ease-out`);
  // Finishes now when a new touch arrives; any other navigation cancels it in showAt.
  const finish = () => {
    clearTimeout(pendingSlide?.timer);
    pendingSlide = null;
    if (turn) showAt(target);
    else placeStrip(0, '');
  };
  pendingSlide = { finish, timer: setTimeout(finish, SWIPE_MS) };
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
    // Above the gallery navigation, which sits 24-60px over the safe area.
    showToast(downloadFailure(error), items.length > 1 ? { bottom: 72 } : undefined);
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
