// Streaming Mermaid: renderMd/renderStreamMd emit a .mermaid-block placeholder; renderMermaidBlocks fills the SVG async, only when the source changed (tagged via data-mcode), swapping just that block's SVG.
(function () {
  // Single knob: swap version/CDN here (pinned exact so the cache key is stable). Browser/WebView HTTP cache handles disk caching.
  var MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs';

  var _mermaidPromise = null;
  var _renderSeq = 0;                  // unique id per render() — mermaid needs distinct ids
  var _pending = Object.create(null);  // stable key → source currently being rendered (in-flight guard)
  var _svgCache = Object.create(null); // trimmed source → rendered SVG string (survives node swaps)
  var _svgCacheKeys = [];              // FIFO of _svgCache keys for a small LRU-ish cap
  function cacheSvg(code, svg) {
    if (!(code in _svgCache)) { _svgCacheKeys.push(code); if (_svgCacheKeys.length > 40) delete _svgCache[_svgCacheKeys.shift()]; }
    _svgCache[code] = svg;
  }

  // Offscreen render container (keeps mermaid's temp measuring nodes out of <body>). MUST keep a real width — gantt measures it to size the axis, so a 0-width sandbox renders blank (mermaid #1846); left:-99999px hides it without collapsing width.
  var _sandbox = null;
  function sandbox() {
    if (_sandbox && document.body.contains(_sandbox)) return _sandbox;
    _sandbox = document.createElement('div');
    _sandbox.id = 'mermaid-sandbox';
    _sandbox.style.cssText = 'position:absolute;left:-99999px;top:0;width:900px;overflow:hidden';
    document.body.appendChild(_sandbox);
    return _sandbox;
  }

  function loadMermaid() {
    if (_mermaidPromise) return _mermaidPromise;
    _mermaidPromise = import(/* @vite-ignore */ MERMAID_CDN).then(function (mod) {
      var mermaid = mod.default || mod;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'loose',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      });
      return mermaid;
    }).catch(function (e) { _mermaidPromise = null; throw e; });
    return _mermaidPromise;
  }

  // Stable per-block key surviving per-frame rebuilds: the streaming block id (sb-<sid>-<bid>), else a one-shot id.
  function stableKey(block) {
    var host = block.closest('[id^="sb-"]');
    return host ? host.id : (block.dataset.mkey || (block.dataset.mkey = 'm' + (++_renderSeq)));
  }

  // mermaid renders a "Syntax error" graph (not a throw) for some parseable sources; detect it to discard and keep the last good diagram.
  function isErrorSvg(svg) {
    return /aria-roledescription="error"|class="error-icon"|>Syntax error/i.test(svg);
  }

  // Gantt streams badly: a half-written task line parses OK but render() throws — so try full source, and on failure drop the last non-empty line and retry a few times.
  function renderResilient(mermaid, id, code) {
    var attempt = code, tries = 0;
    function step() {
      return mermaid.render(id + '-' + tries, attempt, sandbox()).then(function (res) {
        if (res && res.svg && !isErrorSvg(res.svg)) return res;
        throw new Error('error-svg');
      }).catch(function (e) {
        var lines = attempt.split('\n');
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        if (tries >= 3 || lines.length <= 1) throw e;
        lines.pop(); attempt = lines.join('\n'); tries++;
        return step();
      });
    }
    return step();
  }

  // Debounce failure: mid-stream failures are normal (code unfinished), so only act if the SAME source still fails after 600ms; a newer attempt or success cancels it. On failure: switch to code + tag mermaid-failed.
  var _failTimers = Object.create(null);
  function markFailed(block, code) {
    if (block.querySelector('.mermaid-svg > svg')) return; // a good SVG is already showing
    var key = stableKey(block);
    clearTimeout(_failTimers[key]);
    _failTimers[key] = setTimeout(function () {
      var srcEl = block.querySelector('.mermaid-src');
      if (!document.body.contains(block) || !srcEl || srcEl.textContent.trim() !== code) return;
      if (block.querySelector('.mermaid-svg > svg')) return; // rendered in the meantime
      block.classList.add('show-code', 'mermaid-failed');
      var tabs = block.querySelectorAll('.mermaid-tab');
      tabs.forEach(function (t) { t.classList.toggle('active', /code/i.test(t.textContent)); });
    }, 600);
  }

  // (Re)render any .mermaid-block under `container` whose source changed since its current SVG.
  window.renderMermaidBlocks = function (container) {
    if (!container) return;
    var blocks = container.matches && container.matches('.mermaid-block')
      ? [container] : container.querySelectorAll('.mermaid-block');
    if (!blocks.length) return;

    var todo = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var srcEl = block.querySelector('.mermaid-src');
      var code = (srcEl ? srcEl.textContent : '').trim();
      if (!code) continue;
      // gantt is a wide horizontal chart — flag it so CSS stretches it to the container width instead of shrinking it small + centered.
      block.classList.toggle('mermaid-wide', /^gantt\b/.test(code));
      var svgBox = block.querySelector('.mermaid-svg');
      var cur = svgBox && svgBox.firstElementChild;         // SVG already in this box (persistent node or prior render)
      if (cur && cur.getAttribute('data-mcode') === code) { // already showing this exact source → no-op
        block.classList.add('rendered');
        continue;
      }
      // Rendered this source before (e.g. streaming→authoritative swap): restore cached SVG sync, no flash.
      if ((!cur || cur.getAttribute('data-mcode') !== code) && _svgCache[code] && svgBox) {
        svgBox.innerHTML = _svgCache[code];
        if (svgBox.firstElementChild) svgBox.firstElementChild.setAttribute('data-mcode', code);
        block.classList.add('rendered');
        continue;
      }
      var key = stableKey(block);
      if (_pending[key] === code) continue;                 // a render for this source is already in flight
      _pending[key] = code;
      todo.push({ block: block, code: code, key: key });
    }
    if (!todo.length) return;

    loadMermaid().then(function (mermaid) {
      todo.forEach(function (t) {
        var renderId = 'mmd-' + (++_renderSeq);
        // parse() gates render() (mid-stream/invalid → skip); renderResilient handles gantt's half-written trailing line.
        mermaid.parse(t.code, { suppressErrors: true }).then(function (ok) {
          if (!ok) { markFailed(t.block, t.code); return; } // parse failed — if final code, mark failed
          return renderResilient(mermaid, renderId, t.code).then(function (res) {
            cacheSvg(t.code, res.svg); // remember by source so a later node swap restores it sync
            var srcEl = t.block.querySelector('.mermaid-src');
            var box = t.block.querySelector('.mermaid-svg');
            // replace this block's SVG only if it's still attached + still on this source
            if (!box || !srcEl || !document.body.contains(t.block) || srcEl.textContent.trim() !== t.code) return;
            box.innerHTML = res.svg;
            var svg = box.firstElementChild;
            if (svg) svg.setAttribute('data-mcode', t.code); // tag so unchanged frames become a no-op
            clearTimeout(_failTimers[t.key]);                // a good render cancels any pending fail switch
            t.block.classList.remove('mermaid-failed');
            t.block.classList.add('rendered');
          });
        }).catch(function () { markFailed(t.block, t.code); })
          .then(function () { if (_pending[t.key] === t.code) delete _pending[t.key]; });
      });
    }).catch(function () { /* CDN unavailable → placeholder stays (code tab still works) */ });
  };

  // Toggle a block between diagram and source view (tab buttons in the header).
  window.toggleMermaidView = function (btn, mode) {
    var block = btn.closest('.mermaid-block');
    if (!block) return;
    block.classList.toggle('show-code', mode === 'code');
    block.querySelectorAll('.mermaid-tab').forEach(function (t) { t.classList.remove('active'); });
    btn.classList.add('active');
  };

  // ---- Fullscreen viewer: zoom (wheel/pinch) + drag-pan over the rendered SVG ----
  var _fs = null; // { overlay, stage, scale, tx, ty }

  function fsApply() {
    if (!_fs) return;
    _fs.stage.style.transform = 'translate(' + _fs.tx + 'px,' + _fs.ty + 'px) scale(' + _fs.scale + ')';
  }

  function closeMermaidFullscreen() {
    if (!_fs) return;
    if (_fs.detach) _fs.detach();               // remove window-level drag listeners
    _fs.overlay.remove();
    document.removeEventListener('keydown', _fs.onKey);
    _fs = null;
  }
  window.closeMermaidFullscreen = closeMermaidFullscreen;

  window.openMermaidFullscreen = function (btn) {
    var block = btn.closest('.mermaid-block');
    if (!block) return;
    var svg = block.querySelector('.mermaid-svg > svg');
    var code = (block.querySelector('.mermaid-src') || {}).textContent || '';
    // Prefer the live SVG; fall back to the source-keyed cache (block may show code/failed).
    var svgHtml = svg ? svg.outerHTML : (_svgCache[code.trim()] || '');
    if (!svgHtml) return; // nothing rendered to show

    var overlay = document.createElement('div');
    overlay.className = 'mermaid-fs-overlay';
    overlay.innerHTML =
      '<button class="mermaid-fs-close" aria-label="Close">'
      + '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      + '</button>'
      + '<div class="mermaid-fs-stage">' + svgHtml + '</div>';
    document.body.appendChild(overlay);

    _fs = { overlay: overlay, stage: overlay.querySelector('.mermaid-fs-stage'), scale: 1, tx: 0, ty: 0 };
    _fs.onKey = function (e) { if (e.key === 'Escape') closeMermaidFullscreen(); };
    document.addEventListener('keydown', _fs.onKey);

    overlay.querySelector('.mermaid-fs-close').addEventListener('click', closeMermaidFullscreen);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeMermaidFullscreen(); });

    // Wheel / trackpad-pinch zoom, anchored at the cursor.
    overlay.addEventListener('wheel', function (e) {
      e.preventDefault();
      var rect = _fs.stage.getBoundingClientRect();
      var ox = e.clientX - (rect.left + rect.width / 2);
      var oy = e.clientY - (rect.top + rect.height / 2);
      var factor = Math.exp(-e.deltaY * 0.0015);
      var ns = Math.max(0.3, Math.min(_fs.scale * factor, 8));
      var k = ns / _fs.scale;
      _fs.tx = _fs.tx - ox * (k - 1);
      _fs.ty = _fs.ty - oy * (k - 1);
      _fs.scale = ns;
      fsApply();
    }, { passive: false });

    // Drag to pan (mouse + single-touch).
    var drag = null;
    function down(x, y) { drag = { x: x, y: y, tx: _fs.tx, ty: _fs.ty }; }
    function move(x, y) { if (!drag) return; _fs.tx = drag.tx + (x - drag.x); _fs.ty = drag.ty + (y - drag.y); fsApply(); }
    function up() { drag = null; }
    _fs.stage.addEventListener('mousedown', function (e) { e.preventDefault(); down(e.clientX, e.clientY); });
    window.addEventListener('mousemove', _fs.mm = function (e) { move(e.clientX, e.clientY); });
    window.addEventListener('mouseup', _fs.mu = function () { up(); });

    // Two-finger pinch zoom + one-finger pan for touch.
    var pinch = null;
    _fs.stage.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        var dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
        pinch = { d: Math.hypot(dx, dy), s: _fs.scale }; drag = null;
      } else if (e.touches.length === 1) { down(e.touches[0].clientX, e.touches[0].clientY); }
    }, { passive: false });
    _fs.stage.addEventListener('touchmove', function (e) {
      e.preventDefault();
      if (e.touches.length === 2 && pinch) {
        var dx = e.touches[0].clientX - e.touches[1].clientX, dy = e.touches[0].clientY - e.touches[1].clientY;
        _fs.scale = Math.max(0.3, Math.min(pinch.s * (Math.hypot(dx, dy) / pinch.d), 8)); fsApply();
      } else if (e.touches.length === 1) { move(e.touches[0].clientX, e.touches[0].clientY); }
    }, { passive: false });
    _fs.stage.addEventListener('touchend', function (e) { if (!e.touches.length) { up(); pinch = null; } });

    // closeMermaidFullscreen() calls this to drop the window-level drag listeners.
    _fs.detach = function () { window.removeEventListener('mousemove', _fs.mm); window.removeEventListener('mouseup', _fs.mu); };
    fsApply();
  };
})();
