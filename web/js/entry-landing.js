import './theme.js';
// Entry for landing.html — first sign-in with a Start URL (the form: v2/start-url-form.js).
import { defaultServer, state } from './state.js';
import { initMacosTabs, setNativeTabTitle } from './macos-tabs.js';
import { parseLink } from './v2/pairing.js';
import { initPageZoomShortcuts } from './page-zoom.js';
import { exchangeToken, isNativeApp, mountStartUrlForm, routeAfterLogin } from './v2/start-url-form.js';
import { routeExternalLinks } from './native-shell.js';
import { startEntry } from './v2/entry.js';

initMacosTabs();
initPageZoomShortcuts();
routeExternalLinks();
setNativeTabTitle('Baton');

(function () {
  function releaseNativeSkeleton() {
    var nextFrame = window.requestAnimationFrame || function (fn) { setTimeout(fn, 0); };
    nextFrame(function () {
      nextFrame(function () {
        window.__skelReady = 1;
      });
    });
  }

  var form = mountStartUrlForm(document.querySelector('.start-url-form'));
  // Signed out: the entry is chosen while the code is scanned (the App, knowing no server yet, chooses with the link's).
  if (!state.KEY && /^https:/.test(state.SERVER)) startEntry();
  var urlParams = new URLSearchParams(location.search);
  var urlToken = urlParams.get('t');
  var urlKey = urlParams.get('key');

  // A pairing link opened in a browser (a phone camera, a pasted link) is handled at once.
  var pageLink = parseLink(location.href);
  if (pageLink) {
    history.replaceState(null, '', location.pathname + location.search);
    releaseNativeSkeleton();
    form.attempt(function () { return form.applyLink(pageLink, !!state.KEY); });
    return;
  }

  // Browser auto-login from a Start URL pointing at this origin.
  if (!isNativeApp && (urlToken || urlKey)) {
    var browserServer = defaultServer();
    form.attempt(function () {
      return urlToken
        ? exchangeToken(browserServer, urlToken).then(function (k) { return routeAfterLogin(k, browserServer); })
        : routeAfterLogin(urlKey, browserServer);
    });
    releaseNativeSkeleton();
    return;
  }

  // Already signed in — for native we additionally need a saved server URL. An older Add device
  // link (?add=1) opens it over Settings.
  if (state.KEY && (!isNativeApp || localStorage.getItem('_as'))) {
    if (urlParams.has('add')) location.replace('setup.html#add');
    else location.replace('index.html');
    return;
  }

  releaseNativeSkeleton();
})();
