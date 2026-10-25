// ---- Image Staging & Sending ----
import { state } from '../state.js';
import { fileIconHtml } from './file-icon.js';
import { FILE_MAX_BYTES, escapeAttachment, uploadAttachment } from './attachment.js';
import { showImageViewer } from './image-viewer.js';
import { cacheAttachment, isCachedPreview } from './attachment-cache.js';
import { contentHash } from './content-hash.js';

const stagedAttachmentCards = new WeakMap();

function stagePickedFile(file) {
  if (!file) return;
  if (file.type.startsWith('image/')) stageImageFile(file);
  else stageAttachmentFile(file);
}

function onImagePicked(input) {
  if (!input.files) return;
  for (var i = 0; i < input.files.length; i++) stagePickedFile(input.files[i]);
  input.value = '';
}

function onInputPaste(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  var hasImage = false;
  for (var i = 0; i < items.length; i++) {
    if (items[i].kind === 'file') {
      hasImage = true;
      stagePickedFile(items[i].getAsFile());
    }
  }
  if (hasImage) e.preventDefault();
}

// Let the browser deliver Files, exactly like the picker and clipboard do.
// Each window owns its document, so no native window routing is needed.
let fileDragDepth = 0;
const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
function canDropFiles() {
  const bar = document.getElementById('input-bar');
  const input = document.getElementById('msg-input');
  const modalOpen = Array.from(document.querySelectorAll('.modal-overlay, .file-overlay, .img-overlay, dialog[open]'))
    .some(modal => modal.getClientRects().length > 0);
  return !!(state.appState.session && bar && input && !bar.hidden && !bar.inert && !modalOpen
    && window.getComputedStyle(bar).display !== 'none' && !input.disabled
    && state.activeThreadCanSend !== false);
}
function clearFileDrag() {
  fileDragDepth = 0;
  document.getElementById('input-bar')?.classList.remove('file-drop-active');
}
document.addEventListener('dragenter', event => {
  if (isFileDrag(event)) fileDragDepth++;
});
document.addEventListener('dragover', event => {
  if (!isFileDrag(event)) return;
  // Also suppress browser navigation when the current page cannot accept files.
  event.preventDefault();
  const allowed = canDropFiles();
  event.dataTransfer.dropEffect = allowed ? 'copy' : 'none';
  document.getElementById('input-bar')?.classList.toggle('file-drop-active', allowed);
});
document.addEventListener('dragleave', event => {
  if (!isFileDrag(event)) return;
  if (event.relatedTarget === null || --fileDragDepth <= 0) clearFileDrag();
});
document.addEventListener('drop', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  clearFileDrag();
  if (!canDropFiles()) return;
  const items = Array.from(event.dataTransfer.items || []);
  const files = items.length
    ? items.filter(item => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
      .map(item => item.getAsFile())
    : Array.from(event.dataTransfer.files || []);
  // Stage synchronously in this conversation before hashing/reading starts.
  for (const file of files) stagePickedFile(file);
});
document.addEventListener('dragend', clearFileDrag);
window.addEventListener('blur', clearFileDrag);

function stageAttachmentFile(file) {
  const entry = { kind: 'file', name: file.name, size: file.size, file, key: '', uploaded: false, progress: 0 };
  state.stagedImages.push(entry);
  return uploadStagedFile(entry);
}

async function uploadStagedFile(entry) {
  entry.error = '';
  entry.progress = 0;
  entry.uploadPhase = 'preparing';
  entry.controller = new AbortController();
  renderStagedImages();
  try {
    if (entry.size > FILE_MAX_BYTES) throw new Error('File exceeds the 512 MB limit');
    const hash = await contentHash(entry.file, entry.controller.signal);
    if (!state.stagedImages.includes(entry)) return;
    const prepared = await window.apiPost('/api/bridge/file-prepare', {
      name: entry.name, size: entry.size, contentType: entry.file.type || 'application/octet-stream',
      contentHash: hash,
    });
    if (!state.stagedImages.includes(entry)) return;
    entry.key = prepared.key;
    // The same content is already stored: nothing to upload.
    if (!prepared.exists) {
      entry.uploadPhase = 'uploading';
      updateStagedUpload(entry);
      await uploadAttachment(entry.file, prepared, progress => {
        entry.progress = progress;
        updateStagedUpload(entry);
      }, entry.controller.signal);
    }
    if (!state.stagedImages.includes(entry)) return;
    entry.progress = 100;
    entry.uploaded = true;
    // Keep the local copy so previewing it never downloads it back.
    if (isCachedPreview(entry.key)) cacheAttachment(entry.key, entry.name, entry.file);
  } catch (error) {
    if (!entry.controller.signal.aborted) entry.error = error.message || 'Upload failed';
  }
  renderStagedImages();
}

function retryStagedFile(index) {
  const entry = state.stagedImages[index];
  if (entry?.kind === 'file' && entry.error) return uploadStagedFile(entry);
}

function stageImageFile(file) {
  if (!file) return;
  var entry = { name: file.name, dataUrl: '', key: '', uploaded: false };
  state.stagedImages.push(entry);
  renderStagedImages();

  var reader = new FileReader();
  reader.onload = function () {
    var img = new Image();
    img.onload = function () {
      // Compress
      var scale = Math.min(1, 1280 / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      var base64 = dataUrl.split(',')[1];
      var raw = atob(base64);
      var hashStr = raw.slice(0, 8192) + String(raw.length);
      var h = 0;
      for (var hi = 0; hi < hashStr.length; hi++) { h = ((h << 5) - h + hashStr.charCodeAt(hi)) | 0; }
      var key = Math.abs(h).toString(16).padStart(8, '0') + raw.length.toString(16) + '.jpg';

      entry.dataUrl = dataUrl;
      entry.key = key;
      renderStagedImages();

      // Upload immediately
      apiPost('/api/bridge/upload-image', { key: key, data: base64 })
        .then(function () {
          entry.uploaded = true;
          renderStagedImages();
        })
        .catch(function () {
          // Remove failed entry
          var fi = state.stagedImages.indexOf(entry);
          if (fi >= 0) state.stagedImages.splice(fi, 1);
          renderStagedImages();
        });
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function stagedUploadOverlayHtml(entry) {
  if (entry.uploaded) return '';
  if (entry.error) {
    return '<div class="staged-error-overlay"><span class="staged-error-message" role="status" title="'
      + escapeAttachment(entry.error) + '">' + escapeAttachment(entry.error) + '</span>'
      + '<button class="staged-retry" type="button" onclick="retryStagedFile('
      + state.stagedImages.indexOf(entry) + ')">Retry</button></div>';
  }
  return '<div class="staged-upload-overlay" role="progressbar" aria-label="'
    + escapeAttachment('Uploading ' + (entry.name || 'image')) + '" aria-valuemin="0" aria-valuemax="100">'
    + '<div class="staged-upload-visual" aria-hidden="true">'
    // The ring spins as its own <svg> box: WebKit offsets a spinning element inside an SVG under page zoom.
    + '<span class="staged-progress-indicator">'
    + '<svg viewBox="0 0 36 36" shape-rendering="geometricPrecision">'
    + '<circle class="staged-progress-pie" cx="18" cy="18" r="6.5" fill="none" stroke="currentColor"'
    + ' stroke-width="13" pathLength="100" stroke-dasharray="100 100" transform="rotate(-90 18 18)"/></svg>'
    + '<svg class="staged-progress-orbit" viewBox="0 0 36 36" shape-rendering="geometricPrecision">'
    + '<circle class="staged-progress-ring" cx="18" cy="18" r="16"'
    + ' fill="none" stroke="currentColor" stroke-width="1.5" pathLength="100"'
    + ' stroke-dasharray="100 100" stroke-linecap="round"/></svg></span>'
    + '<span class="staged-progress-text"></span></div></div>';
}

function updateStagedUpload(entry) {
  const overlay = stagedAttachmentCards.get(entry)?.querySelector('.staged-upload-overlay');
  if (!overlay || overlay.dataset.state === 'complete') return;
  const isFile = entry.kind === 'file';
  const progress = entry.uploaded ? 100 : Math.min(99, Math.max(0, Math.round(Number(entry.progress) || 0)));
  const phase = isFile ? entry.uploadPhase || (entry.key ? 'uploading' : 'preparing') : 'loading';
  const hasProgress = phase === 'uploading';
  overlay.dataset.state = phase;
  overlay.classList.toggle('has-progress', hasProgress);
  const pie = overlay.querySelector('.staged-progress-pie');
  const full = hasProgress && progress === 100;
  pie.setAttribute('r', full ? '13' : '6.5');
  pie.setAttribute('fill', full ? 'currentColor' : 'none');
  pie.setAttribute('stroke', full ? 'none' : 'currentColor');
  pie.style.strokeDashoffset = String(100 - progress);
  overlay.querySelector('.staged-progress-text').textContent = isFile ? progress + '%' : '';
  if (hasProgress) overlay.setAttribute('aria-valuenow', progress);
  else overlay.removeAttribute('aria-valuenow');
  overlay.setAttribute('aria-valuetext', !isFile ? 'Uploading' : phase === 'preparing' ? 'Preparing upload'
    : progress + '%');
  if (entry.uploaded) {
    overlay.dataset.state = 'complete';
    overlay.removeAttribute('role');
    overlay.setAttribute('aria-hidden', 'true');
    setTimeout(() => overlay.remove(), 180);
  }
}

function renderStagedImages() {
  window.updateSendBtn?.({ skipSpinner: true });
  var row = document.getElementById('img-preview-row');
  if (!state.stagedImages.length) { row.style.display = 'none'; row.innerHTML = ''; return; }
  const scrollLeft = row.scrollLeft;
  row.style.display = 'flex';
  const cards = new Set();
  state.stagedImages.forEach(function (entry, index) {
    const isFile = entry.kind === 'file';
    const name = escapeAttachment(entry.name || 'Image');
    let card = stagedAttachmentCards.get(entry);
    if (!card) {
      card = document.createElement('div');
      card.className = 'staged-attachment ' + (isFile ? 'staged-file' : 'img-thumb');
      let preview;
      if (isFile) {
        const extension = String(entry.name || '').match(/\.([^.]+)$/)?.[1].toUpperCase() || 'FILE';
        preview = '<button type="button" class="staged-file-preview attachment-file" title="' + name + '">'
          + '<span class="staged-file-name">' + name + '</span><span class="staged-file-type">'
          + fileIconHtml(entry.name) + '<span>' + escapeAttachment(extension) + '</span></span></button>';
      } else {
        preview = '<button class="staged-image-preview" type="button" aria-label="Preview ' + name + '">'
          + '<img alt="' + name + '"></button>';
      }
      card.innerHTML = preview + '<button class="img-remove" type="button" aria-label="Remove ' + name + '">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
      stagedAttachmentCards.set(entry, card);
    }
    const preview = card.firstElementChild;
    preview.disabled = !entry.uploaded;
    if (entry.uploaded) preview.setAttribute('onclick', isFile
      ? "openFile('baton-file:" + entry.key + "',this.title)" : 'viewStagedImage(' + index + ')');
    else preview.removeAttribute('onclick');
    if (!isFile) {
      const src = entry.dataUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      const image = preview.querySelector('img');
      if (image.getAttribute('src') !== src) image.src = src;
    }
    card.querySelector('.img-remove').setAttribute('onclick', 'event.stopPropagation();removeStagedImage(' + index + ')');
    card.classList.toggle('upload-failed', !!entry.error);
    card.setAttribute('aria-busy', !entry.uploaded && !entry.error);
    if (entry.error) {
      card.querySelector('.staged-upload-overlay')?.remove();
      card.querySelector('.staged-error-overlay')?.remove();
      card.insertAdjacentHTML('beforeend', stagedUploadOverlayHtml(entry));
    } else {
      card.querySelector('.staged-error-overlay')?.remove();
      if (!entry.uploaded && !card.querySelector('.staged-upload-overlay')) {
        card.insertAdjacentHTML('beforeend', stagedUploadOverlayHtml(entry));
      }
      updateStagedUpload(entry);
    }
    if (row.children[index] !== card) row.insertBefore(card, row.children[index] || null);
    cards.add(card);
  });
  for (const card of [...row.children]) if (!cards.has(card)) card.remove();
  row.scrollLeft = scrollLeft;
}

function removeStagedImage(i) {
  const entry = state.stagedImages[i];
  entry?.controller?.abort();
  if (entry?.kind === 'file' && entry.key) window.clearAttachmentPreviewCache?.(entry.key);
  state.stagedImages.splice(i, 1);
  renderStagedImages();
}

function viewStagedImage(i) {
  var images = state.stagedImages.filter(image => image.kind !== 'file' && image.uploaded);
  if (!images.includes(state.stagedImages[i])) return;
  showImageViewer(images.map(image => ({ src: image.dataUrl })), images.indexOf(state.stagedImages[i]));
}

// Function bridges for inline HTML handlers (state.stagedImages lives in state.js).
Object.assign(window, {
  onImagePicked, onInputPaste, stageImageFile, renderStagedImages, removeStagedImage,
  viewStagedImage,
  stageAttachmentFile, retryStagedFile,
});
