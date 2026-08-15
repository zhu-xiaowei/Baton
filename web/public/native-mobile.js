(function () {
  var ua = navigator.userAgent || '';
  var platform = navigator.platform || '';
  var isiPadDesktopMode = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  var isMobileOS = /Android|iPhone|iPad|iPod/i.test(ua) || isiPadDesktopMode;
  var isNativeMobile = !!window.__TAURI_INTERNALS__ && isMobileOS;

  document.documentElement.classList.toggle('native-mobile', isNativeMobile);
  window.__BATON_NATIVE_MOBILE__ = isNativeMobile;
})();
