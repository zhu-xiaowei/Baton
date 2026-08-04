// Markdown rendering via marked.js + highlight.js
(function () {
  marked.setOptions({ breaks: true, gfm: true });

  // marked v12 dropped the `highlight` option; highlight code tokens up front
  // with our existing hljs so fenced blocks render colored (zero extra deps).
  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function mermaidCodeHtml(code) {
    try { return hljs.highlight(code, { language: 'mermaid' }).value; }
    catch (e) { return escHtml(code); }
  }

  // Inner HTML of a .mermaid-block, shared by walkTokens + the streaming reconciler (identical structure).
  window.mermaidInnerHtml = function (code) {
    return '<div class="mermaid-head">'
      + '<button class="mermaid-tab active" onclick="toggleMermaidView(this,\'diagram\')">diagram</button>'
      + '<button class="mermaid-tab" onclick="toggleMermaidView(this,\'code\')">code</button>'
      + '<button class="mermaid-zoom" title="Fullscreen" onclick="openMermaidFullscreen(this)" aria-label="Fullscreen">'
      + '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>'
      + '</button>'
      + '</div>'
      + '<div class="mermaid-src" hidden>' + escHtml(code) + '</div>'
      + '<div class="mermaid-svg"></div>'
      + '<pre class="mermaid-code"><code class="hljs">' + mermaidCodeHtml(code) + '</code></pre>';
  };

  // Update a block's source (code tab + hidden src) WITHOUT touching .mermaid-svg (re-rendered async elsewhere).
  window.setMermaidSource = function (block, code) {
    var srcEl = block.querySelector('.mermaid-src');
    if (srcEl) srcEl.textContent = code;
    var codeEl = block.querySelector('.mermaid-code code');
    if (codeEl) codeEl.innerHTML = mermaidCodeHtml(code);
  };

  marked.use({
    walkTokens: function (token) {
      if (token.type !== 'code') return;
      var code = token.text || '';
      // Mermaid: emit a placeholder (mermaid.js fills the SVG async). Works mid-stream — marked tokenizes an unclosed ```mermaid fence as lang:'mermaid'.
      if ((token.lang || '').toLowerCase() === 'mermaid') {
        token.type = 'html';
        token.text = '<div class="mermaid-block">' + window.mermaidInnerHtml(code) + '</div>';
        return;
      }
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

  // Split streamed text at ```mermaid fences (counts even while unclosed) → [{type:'text'|'mermaid', text}].
  function splitMermaid(text) {
    var re = /(^|\n)```[ \t]*mermaid[ \t]*(?:\n|$)/gi;
    var segs = [], last = 0, m;
    while ((m = re.exec(text)) !== null) {
      var fenceStart = m.index + m[1].length;       // start of the ``` line
      var bodyStart = m.index + m[0].length;         // first char after the fence line
      if (fenceStart > last) segs.push({ type: 'text', text: text.slice(last, fenceStart) });
      // Body runs until the closing ``` (on its own line) or end-of-text (still streaming).
      var close = text.slice(bodyStart).search(/\n```[ \t]*(?:\n|$)/);
      var code, next;
      if (close === -1) { code = text.slice(bodyStart); next = text.length; }
      else {
        code = text.slice(bodyStart, bodyStart + close);
        var afterFence = text.indexOf('\n', bodyStart + close + 1);
        next = afterFence === -1 ? text.length : afterFence + 1;
      }
      segs.push({ type: 'mermaid', text: code });
      last = next; re.lastIndex = next;
    }
    if (last < text.length) segs.push({ type: 'text', text: text.slice(last) });
    return segs;
  }

  // Streaming reconciler: text segments rebuild each call, but each mermaid segment is a persistent .mermaid-block reused across calls (SVG layer never torn down). No fence → plain innerHTML.
  window.renderStreamMd = function (host, text) {
    var segs = splitMermaid(text || '');
    var hasMermaid = false;
    for (var i = 0; i < segs.length; i++) if (segs[i].type === 'mermaid') { hasMermaid = true; break; }
    if (!hasMermaid) { host.innerHTML = window.renderMd(text); return; }

    var children = host.childNodes;
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      var node = children[s];
      if (seg.type === 'text') {
        var html = window.renderMd(seg.text);
        if (!node || node.nodeType !== 1 || node.className !== 'md-seg') { // insert/replace a text wrapper
          var w = document.createElement('div');
          w.className = 'md-seg'; w.innerHTML = html; w.dataset.h = html;
          if (node) host.replaceChild(w, node); else host.appendChild(w);
        } else if (node.dataset.h !== html) { // reuse in place, rewrite only on change
          node.innerHTML = html; node.dataset.h = html;
        }
      } else {
        if (!node || node.nodeType !== 1 || !node.classList || !node.classList.contains('mermaid-block')) { // insert a fresh block
          var b = document.createElement('div');
          b.className = 'mermaid-block';
          b.innerHTML = window.mermaidInnerHtml(seg.text);
          if (node) host.replaceChild(b, node); else host.appendChild(b);
        } else { // reuse the live block, only update its source
          var curSrc = node.querySelector('.mermaid-src');
          if (!curSrc || curSrc.textContent !== seg.text) window.setMermaidSource(node, seg.text);
        }
      }
    }
    while (host.childNodes.length > segs.length) host.removeChild(host.lastChild); // drop trailing stale nodes
  };
})();
