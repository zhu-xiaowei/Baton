// Lazy KaTeX (CDN, same on-demand pattern as mermaid.js). markdown.js's math extension calls
// katexHtml() at parse time; if katex isn't loaded yet it emits a .katex-ph placeholder, then
// renderKatexBlocks() backfills once the CDN module lands (and every stream tick after).
(function () {
  var KATEX_VER = '0.18.1';
  var KATEX_JS = 'https://cdn.jsdelivr.net/npm/katex@' + KATEX_VER + '/dist/katex.mjs';
  var KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@' + KATEX_VER + '/dist/katex.min.css';

  var _promise = null;
  var _katex = null;

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function loadKatex() {
    if (_promise) return _promise;
    _promise = import(/* @vite-ignore */ KATEX_JS).then(function (mod) {
      _katex = mod.default || mod;
      if (!document.querySelector('link[data-katex]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet'; link.href = KATEX_CSS; link.setAttribute('data-katex', '');
        document.head.appendChild(link);
      }
      return _katex;
    }).catch(function (e) { _promise = null; throw e; });
    return _promise;
  }

  // Render one formula to an HTML string. katex ready → real SVG-ish HTML; not ready → a placeholder
  // span carrying the raw tex (base64 to survive HTML) that renderKatexBlocks fills in later.
  window.katexHtml = function (tex, display) {
    if (_katex) {
      try { return _katex.renderToString(tex, { throwOnError: false, displayMode: display }); }
      catch (e) { return escHtml(tex); }
    }
    loadKatex();
    var enc = (window.btoa ? btoa(unescape(encodeURIComponent(tex))) : escHtml(tex));
    return '<span class="katex-ph" data-tex="' + enc + '" data-d="' + (display ? 1 : 0) + '">'
      + escHtml(tex) + '</span>';
  };

  // Fill any .katex-ph placeholders under `container` once katex is available. Idempotent.
  window.renderKatexBlocks = function (container) {
    if (!container) return;
    var phs = container.querySelectorAll ? container.querySelectorAll('.katex-ph') : [];
    if (!phs.length) return;
    loadKatex().then(function (katex) {
      container.querySelectorAll('.katex-ph').forEach(function (ph) {
        var tex = decodeURIComponent(escape(atob(ph.getAttribute('data-tex') || '')));
        try {
          ph.outerHTML = katex.renderToString(tex, { throwOnError: false, displayMode: ph.getAttribute('data-d') === '1' });
        } catch (e) { ph.classList.remove('katex-ph'); }
      });
    }).catch(function () {});
  };
})();
