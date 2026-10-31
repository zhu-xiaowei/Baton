(function () {
  var key = 'baton-theme';
  function valid(value) { return value === 'light' || value === 'dark'; }
  function apply(value, save) {
    var mode = valid(value) ? value : 'dark';
    var root = document.documentElement;
    var changed = root.dataset.theme !== mode;
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
    if (save) { try { localStorage.setItem(key, mode); } catch (_) {} }
    if (changed) window.dispatchEvent(new CustomEvent('themechange', { detail: mode }));
    return mode;
  }
  var initial;
  try { initial = localStorage.getItem(key); } catch (_) {}
  if (!valid(initial)) {
    initial = window.__BATON_NATIVE_THEME__;
    try { if (window.BatonAndroid) initial = window.BatonAndroid.getTheme(); } catch (_) {}
  }
  window.batonTheme = {
    get: function () { return document.documentElement.dataset.theme || 'dark'; },
    set: function (value) { return apply(value, true); },
    receive: function (value) { return apply(value, true); },
    color: function (token) { return getComputedStyle(document.documentElement).getPropertyValue('--' + token).trim(); },
  };
  apply(initial, false);
  window.addEventListener('storage', function (event) {
    if (event.key === key) apply(event.newValue, false);
  });
})();
