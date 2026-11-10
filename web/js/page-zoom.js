// CSS zoom scales client coordinates, while scroll offsets and explicit CSS
// dimensions stay in layout pixels. Native pageZoom needs no conversion.
export function layoutPixels(value) {
  return value / (typeof window !== 'undefined' ? window.batonPageZoom?.cssScale() || 1 : 1);
}

export function layoutRect(element) {
  const rect = element.getBoundingClientRect();
  return Object.fromEntries(['top', 'right', 'bottom', 'left', 'width', 'height']
    .map(key => [key, layoutPixels(rect[key])]));
}

export function pageZoomShortcut(event, { allowControl = true } = {}) {
  if (event.altKey || event.isComposing || event.defaultPrevented) return null;
  if ((!event.metaKey && !event.ctrlKey) || (event.metaKey && event.ctrlKey)) return null;
  if (event.ctrlKey && !allowControl) return null;
  if (event.key === '=' || event.key === '+') return 'in';
  if (!event.shiftKey && event.key === '-') return 'out';
  if (!event.shiftKey && event.key === '0') return 'reset';
  return null;
}

export function attachZoomShortcuts(win, controller, options) {
  const keydown = event => {
    const action = pageZoomShortcut(event, options);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    controller.changeZoom(action);
  };
  win.addEventListener('keydown', keydown, true);
  return () => win.removeEventListener('keydown', keydown, true);
}

const shortcuts = new WeakMap();

export function initPageZoomShortcuts(win = window) {
  if (!win.batonPageZoom?.enabled) return null;
  if (shortcuts.has(win)) return shortcuts.get(win);
  const detach = attachZoomShortcuts(win, win.batonPageZoom);
  const dispose = () => {
    detach();
    shortcuts.delete(win);
  };
  shortcuts.set(win, dispose);
  return dispose;
}
