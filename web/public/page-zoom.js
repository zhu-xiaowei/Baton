(function () {
  var mobile = !!window.__BATON_MOBILE_LAYOUT__ || !!window.__BATON_NATIVE_MOBILE__
    || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var nativeMac = !!window.__TAURI_INTERNALS__ && /Mac/.test(navigator.platform || '')
    && (navigator.maxTouchPoints || 0) < 2;
  var enabled = !nativeMac;
  var key = mobile ? 'baton-text-size' : 'baton-browser-zoom';
  var levels = mobile ? [
    { id: 'small', scale: 0.9 },
    { id: 'standard', scale: 1 },
    { id: 'large', scale: 1.1 },
    { id: 'extra-large', scale: 1.2 },
    { id: 'double-extra-large', scale: 1.3 },
    { id: 'triple-extra-large', scale: 1.4 },
  ] : [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map(function (scale) {
    return { id: String(scale), scale: scale };
  });
  var standard = levels.find(function (level) { return level.scale === 1; });
  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent || '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var nativeIOS = enabled && mobile && ios && typeof window.__TAURI_INTERNALS__?.invoke === 'function';
  var current = standard;
  var queue = Promise.resolve();
  var root = document.documentElement;

  if (enabled) {
    // Keep raw insets on html for native updates. Normalize inherited values once
    // for body and root-level overlays, so existing safe-area CSS stays unchanged.
    var insets = document.createElement('style');
    insets.textContent = 'html[data-page-zoom] > :not(head){'
      + '--sat:var(--page-safe-top);--sab:var(--page-safe-bottom);'
      + '--sal:var(--page-safe-left);--sar:var(--page-safe-right)}';
    document.head.appendChild(insets);
  }

  function paint() {
    if (!enabled) return;
    root.style.setProperty('--page-zoom', String(current.scale));
    root.dataset.pageZoom = current.id;
    root.style.zoom = String(current.scale);
    ['top', 'bottom', 'left', 'right'].forEach(function (side, index) {
      var inset = ['sat', 'sab', 'sal', 'sar'][index];
      root.style.setProperty('--page-safe-' + side,
        'calc(var(--' + inset + ', env(safe-area-inset-' + side + ', 0px)) / ' + current.scale + ')');
    });
  }

  function notify() {
    window.dispatchEvent(new CustomEvent('baton-page-zoom-change', {
      detail: { value: current.id, scale: enabled ? current.scale : 1 },
    }));
    if (enabled) window.dispatchEvent(new Event('resize'));
  }

  function apply(value, persist) {
    current = levels.find(function (level) { return level.id === value; }) || standard;
    paint();
    if (persist) {
      try { window.localStorage.setItem(key, current.id); } catch (_) {}
    }
    notify();
  }

  var saved;
  try { saved = window.localStorage.getItem(key); } catch (_) {}
  apply(saved, false);

  if (nativeIOS) {
    queue = queue.then(async function () {
      try {
        // iOS pageZoom scales the fixed layout viewport without reflowing its width.
        // Reset zoom left by older pages; use CSS zoom in both apps and browsers.
        await window.__TAURI_INTERNALS__.invoke('mobile_set_zoom', { scale: 1 });
      } catch (error) {
        window.console.warn('Could not reset native page zoom', error);
      }
      notify();
    });
  }

  window.batonPageZoom = {
    enabled: enabled,
    levels: levels,
    get: function () { return current.id; },
    scale: function () { return enabled ? current.scale : 1; },
    cssScale: function () { return enabled ? current.scale : 1; },
    settled: function () { return queue; },
    set: function (value) { apply(value, true); },
    changeZoom: function (action) {
      if (!['in', 'out', 'reset'].includes(action)) return;
      var index = levels.indexOf(current) + (action === 'in' ? 1 : -1);
      apply(action === 'reset' ? standard.id : levels[Math.max(0, Math.min(levels.length - 1, index))].id, true);
    },
  };
  window.addEventListener('storage', function (event) {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key === key || event.key === null) apply(event.newValue, false);
  });
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    var value;
    try { value = window.localStorage.getItem(key); } catch (_) {}
    apply(value, false);
  });
})();
