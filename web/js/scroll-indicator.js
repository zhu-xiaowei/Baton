(function () {
  // Modern iOS can color the native indicator without replacing its behavior.
  if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return;
  if (window.CSS && CSS.supports('scrollbar-color', '#3a4049 transparent')) return;

  var THUMB_MIN_HEIGHT = 24;
  var FADE_DELAY_MS = 800;
  var EDGE_INSET = 2;

  function attach(target) {
    if (!target || target._siAttached) return;
    target._siAttached = true;

    var track = document.createElement('div');
    track.className = 'si-track';
    var thumb = document.createElement('div');
    thumb.className = 'si-thumb';
    track.appendChild(thumb);

    var parent = target.parentElement || document.body;
    var cs = getComputedStyle(parent);
    if (cs.position === 'static') parent.style.position = 'relative';
    parent.appendChild(track);

    var fadeTimer = null;
    var visible = false;

    function show() {
      if (!visible) { track.classList.add('si-visible'); visible = true; }
      if (fadeTimer) clearTimeout(fadeTimer);
      fadeTimer = setTimeout(hide, FADE_DELAY_MS);
    }
    function hide() {
      track.classList.remove('si-visible');
      visible = false;
    }

    function update() {
      var sh = target.scrollHeight;
      var ch = target.clientHeight;
      if (sh <= ch) { track.style.display = 'none'; return; }
      track.style.display = 'block';

      var rect = target.getBoundingClientRect();
      var parentRect = parent.getBoundingClientRect();
      track.style.top = (rect.top - parentRect.top) + 'px';
      track.style.height = ch + 'px';
      track.style.right = Math.max(0, parentRect.right - rect.right) + 'px';

      var trackH = ch - EDGE_INSET * 2;
      var thumbH = Math.max(THUMB_MIN_HEIGHT, trackH * (ch / sh));
      var maxTop = trackH - thumbH;
      var ratio = target.scrollTop / (sh - ch);
      var top = EDGE_INSET + maxTop * Math.min(1, Math.max(0, ratio));
      thumb.style.height = thumbH + 'px';
      thumb.style.transform = 'translateY(' + top + 'px)';
    }

    target.addEventListener('scroll', function () { update(); show(); }, { passive: true });

    var ro = new ResizeObserver(update);
    ro.observe(target);
    if (target.firstElementChild) ro.observe(target.firstElementChild);

    var mo = new MutationObserver(update);
    mo.observe(target, { childList: true, subtree: true });

    window.addEventListener('resize', update);
    update();
  }

  // Expose so other views (e.g. the file preview overlay) can opt in.
  window.attachScrollIndicator = attach;

  function init() { attach(document.getElementById('content')); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
