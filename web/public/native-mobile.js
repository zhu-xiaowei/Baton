(function () {
  function sync() {
    var ua = navigator.userAgent || '';
    var platform = navigator.platform || '';
    var protocol = (window.location && window.location.protocol) || '';
    var isiPadDesktopMode = platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    var isMobileOS = /Android|iPhone|iPad|iPod/i.test(ua) || isiPadDesktopMode;
    // HarmonyOS NEXT shell (harmony/): app:// is the scheme that shell registers
    // for its own bundled page, so it identifies the shell on every page,
    // including setup.html which installs no native facade. The user agent also
    // matches the HarmonyOS system browser, hence the origin check there too.
    var isHarmonyShell = /^app:/.test(protocol)
      || (/OpenHarmony|HarmonyOS|ArkWeb/i.test(ua) && !/^https?:/.test(protocol))
      || !!window.harmonyBridge;
    var isNativeMobile = (!!window.__TAURI_INTERNALS__ && isMobileOS) || isHarmonyShell;

    document.documentElement.classList.toggle('native-mobile', isNativeMobile);
    window.__BATON_NATIVE_MOBILE__ = isNativeMobile;
  }

  // The declarative javaScriptProxy may not be injected yet when this head
  // script runs, so harmony-bridge.js re-runs detection once it holds the facade.
  window.__batonSyncNativeMobile = sync;
  sync();
})();
