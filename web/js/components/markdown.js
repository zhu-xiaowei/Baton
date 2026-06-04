// Markdown rendering via marked.js + highlight.js
(function () {
  marked.setOptions({ breaks: true, gfm: true });

  // marked v12 dropped the `highlight` option; highlight code tokens up front
  // with our existing hljs so fenced blocks render colored (zero extra deps).
  marked.use({
    walkTokens: function (token) {
      if (token.type !== 'code') return;
      var code = token.text || '';
      var html;
      if (token.lang && hljs.getLanguage(token.lang)) {
        try { html = hljs.highlight(code, { language: token.lang }).value; } catch (e) {}
      }
      if (html == null) { try { html = hljs.highlightAuto(code).value; } catch (e) {} }
      if (html != null) { token.type = 'html'; token.text = '<pre><code class="hljs">' + html + '</code></pre>'; }
    },
  });

  function rewriteFileLinks(html) {
    return html.replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, function (m, href, label) {
      // External link: new tab in browser; app.js intercepts .ext-link under Tauri.
      if (/^https?:/i.test(href)) {
        return '<a href="' + href + '" class="ext-link" target="_blank" rel="noopener noreferrer">' + label + '</a>';
      }
      if (/^(mailto:|#|\/\/|tel:|data:)/i.test(href)) return m;
      var hash = (href.match(/#L?(\d+(?:[-,]L?\d+)?)/) || [])[1] || '';
      var path = href.replace(/#.*$/, '');
      var colon = path.match(/^(.*?):(\d+(?:-\d+)?)$/);
      if (colon) { path = colon[1]; hash = hash || colon[2]; }
      if (!path) return m;
      var line = hash.replace(/L/g, '').replace(',', '-');
      var safe = path.replace(/'/g, "\\'");
      var base = (path.split('/').pop() || path).replace(/'/g, "\\'");
      return '<span class="file-link" onclick="openFile(\'' + safe + '\',\'' + base + '\',\'' + line + '\')">' + label + '</span>';
    });
  }

  window.renderMd = function (text) {
    if (!text || !text.trim()) return '';
    return rewriteFileLinks(marked.parse(text));
  };
})();
