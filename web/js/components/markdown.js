// Markdown rendering via marked.js + highlight.js
(function () {
  marked.setOptions({
    highlight: function (code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value; } catch(e) {}
      }
      return hljs.highlightAuto(code).value;
    },
    breaks: true,
    gfm: true,
  });

  window.renderMd = function (text) {
    if (!text || !text.trim()) return '';
    return marked.parse(text);
  };
})();
