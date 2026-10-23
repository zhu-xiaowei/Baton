import { openDownloadReceipt } from './download.js';

export function formatDownloadBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return Math.floor(bytes) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function createDownloadFeedback({ openReceipt = openDownloadReceipt } = {}) {
  let card, toggle, previousFocus, backLayer;
  const entries = new Map();
  function hide() {
    if (!card || card.hidden) return false;
    const restoreFocus = card.contains(document.activeElement);
    card.hidden = true;
    backLayer?.deactivate();
    toggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) (previousFocus?.isConnected ? previousFocus : toggle).focus();
    return true;
  }
  function reveal() {
    card.hidden = false;
    backLayer?.activate();
    toggle.setAttribute('aria-expanded', 'true');
  }
  function mount() {
    if (card) return;
    card = document.createElement('section');
    card.className = 'download-panel';
    card.id = 'download-panel';
    card.hidden = true;
    card.setAttribute('aria-label', 'Downloads');
    card.innerHTML = '<div class="download-heading"><strong>Downloads</strong>'
      + '<button type="button" data-action="dismiss">Hide</button></div>'
      + '<div class="download-list"></div>';
    toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'download-toggle';
    toggle.title = 'Downloads';
    toggle.setAttribute('aria-label', 'Downloads');
    toggle.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'
      + '<path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5"/></svg><span class="download-count" hidden></span>';
    toggle.setAttribute('aria-controls', card.id);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = event => {
      event.stopPropagation();
      if (!hide()) {
        previousFocus = document.activeElement;
        reveal();
        card.querySelector('[data-action="dismiss"]').focus();
      }
    };
    const topBar = document.querySelector('.top-bar');
    if (topBar) topBar.insertBefore(toggle, document.getElementById('top-right'));
    else { toggle.classList.add('download-toggle-floating'); document.body.appendChild(toggle); }
    document.body.appendChild(card);
    backLayer = window.registerEdgeBackLayer?.({
      navigateBack: hide, foregroundSelectors: ['#download-panel'],
      guardZIndex: 1101, foregroundZIndex: 1100,
    });
    card.querySelector('[data-action="dismiss"]').onclick = hide;
    window.addEventListener('keydown', onKeyDown, true);
  }
  function onKeyDown(event) {
    if (event.key === 'Escape' && hide()) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  function addEntry(id) {
    const node = document.createElement('article');
    node.className = 'download-item';
    node.dataset.downloadId = id;
    node.innerHTML = '<strong class="download-name"></strong>'
      + '<span class="download-message" role="status"></span>'
      + '<progress aria-label="Download progress"></progress><div class="download-actions">'
      + '<button type="button" data-action="open" hidden>Open file</button>'
      + '<button type="button" data-action="folder" hidden>Show in folder</button>'
      + '<button type="button" data-action="cancel" hidden>Cancel</button>'
      + '<button type="button" data-action="retry" hidden>Retry</button></div>';
    const entry = { node };
    entries.set(id, entry);
    card.querySelector('.download-list').prepend(node);
    for (const action of ['open', 'folder']) {
      const button = node.querySelector(`[data-action="${action}"]`);
      button.onclick = async () => {
        button.disabled = true;
        try { await openReceipt(entry.receipt, action === 'folder'); }
        catch (error) { node.querySelector('.download-message').textContent = String(error.message || error); }
        finally { button.disabled = false; }
      };
    }
    return entry;
  }
  return {
    show({ id, name, message, progress, result, busy = false, cancel, retry, notify = false }) {
      mount();
      const isNew = !entries.has(id);
      const entry = entries.get(id) || addEntry(id);
      const node = entry.node;
      entry.busy = busy;
      entry.receipt = result || null;
      if (isNew || notify) reveal();
      node.querySelector('.download-name').textContent = result?.name || name;
      const bar = node.querySelector('progress');
      bar.hidden = !busy;
      const received = Math.max(0, Number(progress?.received) || 0);
      const total = Number(progress?.total);
      const known = Number.isFinite(total) && total > 0;
      bar.max = known ? total : 1;
      if (known) bar.value = received;
      else bar.removeAttribute('value');
      if (progress) message += ' ' + (known ? `${Math.min(100, Math.floor(received / total * 100))}% · ` : '')
        + formatDownloadBytes(received) + (known ? ' / ' + formatDownloadBytes(total) : '');
      node.querySelector('.download-message').textContent = message;
      node.querySelector('[data-action="open"]').hidden = busy || !result?.id || result.canOpen === false;
      node.querySelector('[data-action="folder"]').hidden = busy || !result?.id || result.canReveal === false;
      const cancelButton = node.querySelector('[data-action="cancel"]');
      cancelButton.hidden = !busy;
      cancelButton.disabled = !cancel;
      cancelButton.onclick = cancel || null;
      const retryButton = node.querySelector('[data-action="retry"]');
      retryButton.hidden = busy || !retry;
      retryButton.onclick = retry || null;
      if (retry) retryButton.textContent = result?.status === 'ready' ? 'Share' : 'Retry';
      const pending = [...entries.values()].filter(entry => entry.busy).length;
      toggle.setAttribute('aria-label', pending ? `Downloads (${pending})` : 'Downloads');
      const badge = toggle.querySelector('.download-count');
      badge.hidden = !pending;
      badge.textContent = pending > 99 ? '99+' : String(pending);
    },
    hide,
    dispose() {
      window.removeEventListener('keydown', onKeyDown, true);
      backLayer?.unregister();
      backLayer = null;
      card?.remove(); toggle?.remove(); entries.clear();
      card = toggle = null;
    },
  };
}
