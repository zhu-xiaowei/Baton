// ---- Image Staging & Sending ----
import { state } from '../state.js';
import { fileIconHtml } from './file-icon.js';
import { FILE_MAX_BYTES, escapeAttachment, uploadAttachment } from './attachment.js';

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
    const prepared = await window.apiPost('/api/bridge/file-prepare', {
      name: entry.name, size: entry.size, contentType: entry.file.type || 'application/octet-stream',
    });
    if (!state.stagedImages.includes(entry)) return;
    entry.key = prepared.key;
    entry.uploadPhase = 'uploading';
    updateStagedUpload(entry);
    await uploadAttachment(entry.file, prepared, progress => {
      entry.progress = progress;
      updateStagedUpload(entry);
    }, entry.controller.signal);
    if (!state.stagedImages.includes(entry)) return;
    entry.progress = 100;
    entry.uploaded = true;
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
    + '<svg class="staged-progress-indicator" viewBox="0 0 36 36" shape-rendering="geometricPrecision">'
    + '<circle class="staged-progress-pie" cx="18" cy="18" r="6.5" fill="none" stroke="currentColor"'
    + ' stroke-width="13" pathLength="100" stroke-dasharray="100 100" transform="rotate(-90 18 18)"/>'
    + '<g class="staged-progress-orbit"><circle class="staged-progress-ring" cx="18" cy="18" r="16"'
    + ' fill="none" stroke="currentColor" stroke-width="1.5" pathLength="100"'
    + ' stroke-dasharray="100 100" stroke-linecap="round"/></g></svg>'
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
      card.innerHTML = preview + '<button class="img-remove" type="button" aria-label="Remove ' + name + '">&times;</button>';
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
  state.stagedImages[i]?.controller?.abort();
  state.stagedImages.splice(i, 1);
  renderStagedImages();
}

var galleryIndex = 0;
function viewStagedImage(i) {
  if (!state.stagedImages[i]?.uploaded || state.stagedImages[i].kind === 'file') return;
  galleryIndex = galleryImages().indexOf(state.stagedImages[i]);
  showGallery();
}

function galleryImages() { return state.stagedImages.filter(image => image.kind !== 'file' && image.uploaded); }

function showGallery() {
  var images = galleryImages();
  var img = images[galleryIndex];
  if (!img || !img.dataUrl) return;
  var overlay = document.getElementById('imgOverlay');
  var overlayImg = document.getElementById('imgOverlayImg');
  overlayImg.src = img.dataUrl;
  overlay.style.display = 'flex';
  overlay.onclick = null;
  // Build nav buttons if multiple
  var nav = overlay.querySelector('.gallery-nav');
  if (nav) nav.remove();
  if (images.length > 1) {
    var navHtml = '<div class="gallery-nav">'
      + '<button onclick="event.stopPropagation();galleryPrev()"' + (galleryIndex <= 0 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>'
      + '<span>' + (galleryIndex + 1) + ' / ' + images.length + '</span>'
      + '<button onclick="event.stopPropagation();galleryNext()"' + (galleryIndex >= images.length - 1 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg></button>'
      + '</div>';
    overlay.insertAdjacentHTML('beforeend', navHtml);
  }
  overlay.onclick = function (e) { if (e.target === overlay) { overlay.style.display = 'none'; } };
}

function galleryPrev() { if (galleryIndex > 0) { galleryIndex--; showGallery(); } }
function galleryNext() { if (galleryIndex < galleryImages().length - 1) { galleryIndex++; showGallery(); } }

document.addEventListener('keydown', function (e) {
  var overlay = document.getElementById('imgOverlay');
  if (!overlay || overlay.style.display !== 'flex') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); galleryPrev(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); galleryNext(); }
  else if (e.key === 'Escape') overlay.style.display = 'none';
});

// Function bridges for inline HTML handlers (state.stagedImages lives in state.js).
Object.assign(window, {
  onImagePicked, onInputPaste, stageImageFile, renderStagedImages, removeStagedImage,
  viewStagedImage, showGallery, galleryPrev, galleryNext,
  stageAttachmentFile, retryStagedFile,
});
