import { attachZoomShortcuts, pageZoomShortcut } from './page-zoom.js';

const ZOOM_KEY = 'baton-macos-zoom';
const ZOOM_LEVELS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
let controller;

export function isNativeMac(win) {
  return !!win.__TAURI_INTERNALS__
    && /Mac/.test(win.navigator.platform)
    && (win.navigator.maxTouchPoints || 0) < 2;
}

export function normalizeZoom(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  const bounded = Math.max(0.75, Math.min(2, number));
  return ZOOM_LEVELS.reduce((nearest, level) =>
    Math.abs(level - bounded) < Math.abs(nearest - bounded) ? level : nearest);
}

export function zoomShortcut(event) {
  return pageZoomShortcut(event, { allowControl: false });
}

export function createZoomController(win, invoke) {
  let stored;
  try { stored = win.localStorage.getItem(ZOOM_KEY); } catch {}
  let zoom = normalizeZoom(stored);
  let appliedZoom = 1;
  let queue = Promise.resolve();
  let disposed = false;

  function notify() {
    win.dispatchEvent(new win.CustomEvent('baton-macos-zoom-change', { detail: { scale: zoom } }));
  }

  function apply(value, persist = true) {
    if (disposed) return queue;
    zoom = normalizeZoom(value);
    const requested = zoom;
    notify();
    queue = queue.then(async () => {
      if (disposed) return;
      await invoke('macos_set_zoom', { scale: requested });
      if (disposed) return;
      appliedZoom = requested;
      if (persist) {
        try { win.localStorage.setItem(ZOOM_KEY, String(requested)); } catch {}
      }
      win.dispatchEvent(new win.Event('resize'));
    }).catch(error => {
      if (zoom === requested) zoom = appliedZoom;
      notify();
      win.console.warn('Baton could not change zoom', error);
    });
    return queue;
  }

  function changeZoom(action) {
    if (!['in', 'out', 'reset'].includes(action)) return queue;
    const index = ZOOM_LEVELS.indexOf(zoom) + (action === 'in' ? 1 : -1);
    return apply(action === 'reset' ? 1 : ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index))]);
  }

  function storage(event) {
    if (event.storageArea && event.storageArea !== win.localStorage) return;
    if (event.key === ZOOM_KEY || event.key === null) {
      apply(event.key === null ? 1 : event.newValue, false);
    }
  }

  function restore() {
    let value;
    try { value = win.localStorage.getItem(ZOOM_KEY); } catch {}
    return apply(value, false);
  }

  const detachShortcuts = attachZoomShortcuts(win, { changeZoom }, { allowControl: false });
  win.addEventListener('storage', storage);
  apply(zoom, false);
  return {
    enabled: true,
    levels: ZOOM_LEVELS.map(scale => ({ id: String(scale), scale })),
    get: () => String(zoom),
    scale: () => zoom,
    set: value => apply(value),
    restore,
    changeZoom,
    settled: () => queue,
    dispose() {
      disposed = true;
      detachShortcuts();
      win.removeEventListener('storage', storage);
    },
  };
}

export function initMacosZoom(win = window) {
  if (!isNativeMac(win)) return null;
  if (!controller) {
    win.document.documentElement.classList.add('macos-page-zoom');
    const native = import('@tauri-apps/api/core');
    controller = createZoomController(win, (command, args) =>
      native.then(({ invoke }) => invoke(command, args)));
    win.addEventListener('pagehide', event => {
      if (!event.persisted) controller?.dispose();
    });
    win.addEventListener('pageshow', event => {
      if (event.persisted) controller?.restore();
    });
  }
  return controller;
}
