import { state } from '../state.js';
import { downloadFile, nativeDownloads } from '../project/download.js';
import { localImageFile, MAX_IMAGE_BYTES } from './local-image.js';
import { imageMimeType } from './image-type.js';

const bound = new WeakMap();
let observer;
let scheduled = false;
const scope = () => JSON.stringify([state.SERVER, state.KEY, state.appState.device,
  state.appState.project?.hash, state.appState.session, state.activeThreadId]);

function basename(value) {
  return String(value || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '');
}

async function readImageBlob(src) {
  const response = await fetch(src, { credentials: 'omit' });
  if (!response.ok) throw new Error('Could not read the image. Please retry.');
  if (Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) {
    await response.body?.cancel();
    throw new Error('Image exceeds 32 MiB. Download the original file instead.');
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 32 MiB. Download the original file instead.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0] || '' });
  }
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 32 MiB. Download the original file instead.');
  return blob;
}

export async function imageSaveFile(src, suggestedName = '') {
  if (!src) throw new Error('Wait for the image to load before saving.');
  let name = basename(suggestedName);
  let file;
  if (src.startsWith('data:')) {
    file = localImageFile(src);
  } else {
    const url = new URL(src, location.href);
    if (!['blob:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('This image source cannot be saved.');
    }
    if (!name && url.protocol === 'https:') {
      try { name = basename(decodeURIComponent(url.pathname.split('/').pop())); } catch {}
    }
    if (url.protocol === 'https:' && nativeDownloads()) {
      return { url: url.href, name: name || 'image', contentType: imageMimeType(name) || 'application/octet-stream' };
    }
    const blob = await readImageBlob(url.href);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    file = localImageFile(`data:${blob.type || imageMimeType(name)};base64,${btoa(binary)}`);
  }
  if (name) {
    const extension = file.name.split('.').pop();
    file.name = (name.replace(/\.[^.]*$/, '') || 'image') + '.' + extension;
  }
  return file;
}

function saveControls(getSource) {
  const controls = document.createElement('span');
  controls.className = 'image-save-controls';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Save image';
  const status = document.createElement('span');
  status.className = 'image-save-status';
  status.setAttribute('role', 'status');
  button.addEventListener('click', async event => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    const source = getSource();
    if (!source) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = 'Saving…';
    const show = message => {
      if (getSource()?.src === source.src) status.textContent = message;
      else status.textContent = '';
    };
    try {
      const file = await imageSaveFile(source.src, source.name);
      const result = await downloadFile(file);
      show(({ saved: 'Saved to Downloads.', shared: 'Shared.',
        share_opened: 'Share sheet opened.', cancelled: 'Cancelled.' })[result?.status] || 'Download started.');
    } catch (error) {
      show(error.message || 'Could not save the image. Please retry.');
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
  controls.append(button, status);
  return controls;
}

export function refreshImageSaveControls() {
  const current = scope();
  for (const image of document.querySelectorAll('.messages .img-placeholder img, .messages .assistant-text img')) {
    if (image.closest('.mermaid-block, .codex-visualization, .tool-card')) continue;
    const host = image.closest('.img-placeholder') || image;
    const previous = bound.get(host);
    if (previous?.scope === current && previous.controls.isConnected) continue;
    previous?.controls.remove();
    const controls = saveControls(() => {
      if (!host.isConnected || scope() !== current) return null;
      const active = host.tagName === 'IMG' ? host : host.querySelector('img');
      return { src: active?.currentSrc || active?.src || '',
        name: host.dataset.key || host.dataset.path || '' };
    });
    host.after(controls);
    bound.set(host, { scope: current, controls });
  }
  const overlay = document.getElementById('imgOverlay');
  if (overlay && !overlay.querySelector('.image-save-controls')) {
    const controls = saveControls(() => {
      const image = overlay.querySelector('#imgOverlayImg');
      return { src: image?.src || '' };
    });
    controls.classList.add('image-save-fullscreen');
    overlay.append(controls);
  }
  if (overlay) {
    const image = overlay.querySelector('#imgOverlayImg');
    const src = image?.src || '';
    if (bound.get(overlay)?.src !== src) {
      overlay.querySelector('.image-save-status').textContent = '';
      bound.set(overlay, { src });
    }
  }
}

export function initImageSaveControls() {
  if (observer) return;
  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; refreshImageSaveControls(); });
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  refreshImageSaveControls();
}
