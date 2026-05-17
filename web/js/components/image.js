// ---- Image Staging & Sending ----
import { state } from '../state.js';

function onImagePicked(input) {
  if (!input.files) return;
  for (var i = 0; i < input.files.length; i++) stageImageFile(input.files[i]);
  input.value = '';
}

function onInputPaste(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  var hasImage = false;
  for (var i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image/') === 0) {
      hasImage = true;
      stageImageFile(items[i].getAsFile());
    }
  }
  if (hasImage) e.preventDefault();
}

function stageImageFile(file) {
  if (!file) return;
  var entry = { dataUrl: '', key: '', uploaded: false };
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

function renderStagedImages() {
  var row = document.getElementById('img-preview-row');
  if (!state.stagedImages.length) { row.style.display = 'none'; row.innerHTML = ''; return; }
  row.style.display = 'flex';
  row.innerHTML = state.stagedImages.map(function (img, i) {
    var overlay = img.uploaded ? '' : '<div class="img-upload-overlay"><svg class="img-spinner" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="3"/><circle cx="18" cy="18" r="16" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="100" stroke-dashoffset="' + (img.dataUrl ? '25' : '90') + '" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1s" repeatCount="indefinite"/></circle></svg></div>';
    var src = img.dataUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    return '<div class="img-thumb" onclick="viewStagedImage(' + i + ')">'
      + '<img src="' + src + '">' + overlay
      + '<button class="img-remove" onclick="event.stopPropagation();removeStagedImage(' + i + ')">&times;</button></div>';
  }).join('');
}

function removeStagedImage(i) {
  state.stagedImages.splice(i, 1);
  renderStagedImages();
}

var galleryIndex = 0;
function viewStagedImage(i) {
  galleryIndex = i;
  showGallery();
}

function showGallery() {
  var img = state.stagedImages[galleryIndex];
  if (!img || !img.dataUrl) return;
  var overlay = document.getElementById('imgOverlay');
  var overlayImg = document.getElementById('imgOverlayImg');
  overlayImg.src = img.dataUrl;
  overlay.style.display = 'flex';
  overlay.onclick = null;
  // Build nav buttons if multiple
  var nav = overlay.querySelector('.gallery-nav');
  if (nav) nav.remove();
  if (state.stagedImages.length > 1) {
    var navHtml = '<div class="gallery-nav">'
      + '<button onclick="event.stopPropagation();galleryPrev()"' + (galleryIndex <= 0 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>'
      + '<span>' + (galleryIndex + 1) + ' / ' + state.stagedImages.length + '</span>'
      + '<button onclick="event.stopPropagation();galleryNext()"' + (galleryIndex >= state.stagedImages.length - 1 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg></button>'
      + '</div>';
    overlay.insertAdjacentHTML('beforeend', navHtml);
  }
  overlay.onclick = function (e) { if (e.target === overlay) { overlay.style.display = 'none'; } };
}

function galleryPrev() { if (galleryIndex > 0) { galleryIndex--; showGallery(); } }
function galleryNext() { if (galleryIndex < state.stagedImages.length - 1) { galleryIndex++; showGallery(); } }

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
});
