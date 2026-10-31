(function () {
  var key = 'baton-theme';
  var root = document.documentElement;
  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var preference = 'dark';
  function valid(value) { return value === 'system' || value === 'light' || value === 'dark'; }
  function resolve(value) { return value === 'system' ? (media && !media.matches ? 'light' : 'dark') : value; }
  function apply(value, save) {
    var next = valid(value) ? value : 'dark';
    var mode = resolve(next);
    var changed = root.dataset.theme !== mode || preference !== next;
    preference = next;
    root.dataset.themePreference = next;
    root.dataset.theme = mode;
    root.style.colorScheme = mode;
    if (save) { try { localStorage.setItem(key, next); } catch (_) {} }
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
    get: function () { return root.dataset.theme || 'dark'; },
    preference: function () { return preference; },
    set: function (value) { return apply(value, true); },
    receive: function (value) { return apply(value, true); },
    color: function (token) { return getComputedStyle(root).getPropertyValue('--' + token).trim(); },
  };
  apply(initial, false);
  if (media) {
    var follow = function () { if (preference === 'system') apply('system', false); };
    if (media.addEventListener) media.addEventListener('change', follow); else if (media.addListener) media.addListener(follow);
  }
  window.addEventListener('storage', function (event) {
    if (event.key === key) apply(event.newValue, false);
  });
})();
