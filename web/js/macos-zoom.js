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
  if (!event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.defaultPrevented) return null;
  if (event.key === '=' || event.key === '+') return 'in';
  if (!event.shiftKey && event.key === '-') return 'out';
  if (!event.shiftKey && event.key === '0') return 'reset';
  return null;
}

export function createZoomController(win, invoke) {
  let stored;
  try { stored = win.localStorage.getItem(ZOOM_KEY); } catch {}
  let zoom = normalizeZoom(stored);
  let appliedZoom = 1;
  let queue = Promise.resolve();
  let disposed = false;

  function apply(value, persist = true) {
    if (disposed) return queue;
    zoom = normalizeZoom(value);
    const requested = zoom;
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
      win.console.warn('Baton could not change zoom', error);
    });
    return queue;
  }

  function changeZoom(action) {
    if (!['in', 'out', 'reset'].includes(action)) return queue;
    const index = ZOOM_LEVELS.indexOf(zoom) + (action === 'in' ? 1 : -1);
    return apply(action === 'reset' ? 1 : ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index))]);
  }

  function keydown(event) {
    const action = zoomShortcut(event);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    changeZoom(action);
  }

  function storage(event) {
    if (event.storageArea && event.storageArea !== win.localStorage) return;
    if (event.key === ZOOM_KEY || event.key === null) {
      apply(event.key === null ? 1 : event.newValue, false);
    }
  }

  win.addEventListener('keydown', keydown, true);
  win.addEventListener('storage', storage);
  apply(zoom, false);
  return {
    changeZoom,
    settled: () => queue,
    dispose() {
      disposed = true;
      win.removeEventListener('keydown', keydown, true);
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
  }
  return controller;
}
