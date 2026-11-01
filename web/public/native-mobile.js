(function () {
  var ua = navigator.userAgent || '';
  var platform = navigator.platform || '';
  var isiPadDesktopMode = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  var isMobileOS = /Android|iPhone|iPad|iPod/i.test(ua) || isiPadDesktopMode;
  // The HarmonyOS shell serves its pages from app://; its system browser shares the UA.
  var isHarmonyShell = /^app:/.test((window.location && window.location.protocol) || '');
  var isNativeMobile = (!!window.__TAURI_INTERNALS__ && isMobileOS) || isHarmonyShell;
  var isTouchBrowser = (navigator.maxTouchPoints || 0) > 0
    && !!window.matchMedia?.('(pointer: coarse)').matches;
  var isMobileLayout = isNativeMobile || isMobileOS || /Mobile|HarmonyOS|OpenHarmony/i.test(ua) || isTouchBrowser;

  // Reuse the existing mobile CSS in browsers; keep app-only behavior separate.
  document.documentElement.classList.toggle('native-mobile', isMobileLayout);
  document.documentElement.classList.toggle('native-mobile-app', isNativeMobile);
  window.__BATON_NATIVE_MOBILE__ = isNativeMobile;
  window.__BATON_MOBILE_LAYOUT__ = isMobileLayout;
})();
