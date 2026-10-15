import { Channel, invoke } from '@tauri-apps/api/core';

export function supportsNativePreview() {
  return !!window.__BATON_NATIVE_MOBILE__ && !/Android/i.test(navigator.userAgent);
}

export function createNativePreview({ root, area, onState, onError }) {
  const id = crypto.randomUUID();
  let disposed = false;
  let available = true;
  let visible = false;
  let interactive = true;
  let lastBounds = '';
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
      return invoke(`plugin:preview-webview|${name}`, { id, ...args });
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
      visible: visible && !root.hidden && !document.hidden && root.isConnected,
      interactive,
    };
    const key = JSON.stringify(bounds);
    if (key === lastBounds) return;
    lastBounds = key;
    void command('layout', { bounds });
  }

  function scheduleLayout() {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; layout(); });
  }
  const resize = new ResizeObserver(scheduleLayout);
  resize.observe(area);
  const mutation = new MutationObserver(scheduleLayout);
  mutation.observe(root, { attributes: true, attributeFilter: ['style', 'hidden'] });
  window.addEventListener('resize', scheduleLayout);
  window.visualViewport?.addEventListener('resize', scheduleLayout);
  window.visualViewport?.addEventListener('scroll', scheduleLayout);
  document.addEventListener('visibilitychange', scheduleLayout);

  return {
    navigate(url) {
      visible = true;
      layout();
      return command('navigate', { url });
    },
    action(action) {
      visible = true;
      layout();
      return command('action', { action });
    },
    setInteractive(value) { interactive = value; layout(); },
    show() { visible = true; scheduleLayout(); },
    hide() { visible = false; layout(); },
    destroy() {
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
      void command('remove').finally(() => channel.cleanupCallback());
    },
  };
}
