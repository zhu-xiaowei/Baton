import { Channel, invoke } from '@tauri-apps/api/core';

export function supportsNativePreview() {
  return !!window.__TAURI_INTERNALS__ && !/Android/i.test(navigator.userAgent)
    && (!!window.__BATON_NATIVE_MOBILE__ || /^Mac/.test(navigator.platform || ''));
}

export function createNativePreview({ root, area, onState, onError }) {
  const id = crypto.randomUUID();
  let disposed = false;
  let available = true;
  let visible = false;
  let interactive = true;
  let lastBounds = '';
  let pendingBounds;
  let layoutQueued = false;
  let frame = null;
  const channel = new Channel(data => {
    if (!disposed && data.id === id) onState(data);
  });
  let queue = invoke('plugin:preview-webview|create', { id, onEvent: channel })
    .catch(error => {
      available = false;
      if (!disposed) onError(error);
    });

  function command(name, args = {}) {
    queue = queue.then(() => {
      if (!available || (disposed && name !== 'remove')) return;
      return invoke(`plugin:preview-webview|${name}`, { id, ...(typeof args === 'function' ? args() : args) });
    }).catch(error => { if (!disposed) onError(error); });
    return queue;
  }

  function layout() {
    if (disposed) return;
    const rect = area.getBoundingClientRect();
    const viewport = window.visualViewport;
    const offsetLeft = viewport?.offsetLeft || 0;
    const offsetTop = viewport?.offsetTop || 0;
    const top = Math.max(0, rect.top - offsetTop);
    const bounds = {
      left: rect.left - offsetLeft, top,
      width: rect.width,
      height: Math.max(0, Math.min(rect.bottom - offsetTop, viewport?.height || window.innerHeight) - top),
      viewportWidth: window.innerWidth,
      visible: visible && !root.hidden && !document.hidden && root.isConnected && !coveredByDialog(rect),
      interactive,
    };
    const key = JSON.stringify(bounds);
    if (key === lastBounds) return;
    lastBounds = key;
    pendingBounds = bounds;
    if (layoutQueued) return;
    layoutQueued = true;
    void command('layout', () => {
      layoutQueued = false;
      return { bounds: pendingBounds };
    });
  }

  function coveredByDialog(rect) {
    const level = Number(getComputedStyle(root).zIndex) || 0;
    return Array.from(document.querySelectorAll(
      'dialog[open], [aria-modal="true"], .modal-overlay, .mermaid-fs-overlay, .img-overlay, .file-overlay',
    )).some(element => {
      if (root.contains(element) || element.hidden) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden'
        || (element.tagName !== 'DIALOG' && (Number(style.zIndex) || 0) <= level)) return false;
      const other = element.getBoundingClientRect();
      return other.right > rect.left && other.left < rect.right
        && other.bottom > rect.top && other.top < rect.bottom;
    });
  }

  function scheduleLayout() {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      layout();
      // Sample the CSS transition until the host's edge-back animation settles.
      if (visible && !root.hidden && !document.hidden && root.isConnected
        && document.body.classList.contains('edge-back-settling')) scheduleLayout();
    });
  }
  const resize = new ResizeObserver(scheduleLayout);
  resize.observe(area);
  const mutation = new MutationObserver(records => {
    if (records.some(record => record.target === root || !root.contains(record.target))) scheduleLayout();
  });
  mutation.observe(document.body, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['style', 'hidden', 'class', 'open', 'aria-modal'],
  });
  window.addEventListener('resize', scheduleLayout);
  window.visualViewport?.addEventListener('resize', scheduleLayout);
  window.visualViewport?.addEventListener('scroll', scheduleLayout);
  document.addEventListener('visibilitychange', scheduleLayout);
  window.addEventListener('pagehide', destroy);

  function destroy() {
    if (disposed) return;
    disposed = true;
    channel.onmessage = () => {};
    if (frame !== null) cancelAnimationFrame(frame);
    resize.disconnect();
    mutation.disconnect();
    window.removeEventListener('resize', scheduleLayout);
    window.visualViewport?.removeEventListener('resize', scheduleLayout);
    window.visualViewport?.removeEventListener('scroll', scheduleLayout);
    document.removeEventListener('visibilitychange', scheduleLayout);
    window.removeEventListener('pagehide', destroy);
    void command('remove').finally(() => channel.cleanupCallback());
  }

  return {
    navigate(url) {
      visible = true;
      layout();
      scheduleLayout();
      return command('navigate', { url });
    },
    // iOS only: renders `html` under `url`'s origin, so its site storage persists per URL host.
    loadHTML(url, html) {
      visible = true;
      layout();
      scheduleLayout();
      return command('navigate', { url, html });
    },
    action(action) {
      visible = true;
      layout();
      scheduleLayout();
      return command('action', { action });
    },
    setInteractive(value) { interactive = value; layout(); },
    show() { visible = true; scheduleLayout(); },
    hide() { visible = false; layout(); },
    destroy,
  };
}
