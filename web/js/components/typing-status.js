// CC-style status — "✢ Coding..." with typing cursor animation while CC is running
import { state } from '../state.js';

(function () {
  var FRAMES = ['·', '✢', '✦', '✶', '✻', '✽', '✻', '✶', '✦', '✢'];
  var GLYPH_MS = 120;
  var TYPING_MS = 800;
  var PAUSE_MS = 1500;
  var CURSOR = '<span class="cc-cursor"></span>';
  var VERBS = [
    'Baking','Brewing','Calculating','Churning','Clauding','Cogitating',
    'Computing','Concocting','Considering','Contemplating','Cooking',
    'Crafting','Creating','Crunching','Deliberating','Doing','Enchanting',
    'Forging','Generating','Hatching','Imagining','Inferring','Manifesting',
    'Marinating','Mulling','Musing','Noodling','Percolating','Pondering',
    'Processing','Puzzling','Ruminating','Scheming','Simmering','Spinning',
    'Synthesizing','Thinking','Tinkering','Vibing','Wandering','Working',
    'Wrangling'
  ];

  var _glyphIv = null, _typingIv = null, _pauseTimer = null;
  var _currentVerb = '';
  var _currentRuntime = '';

  function pick() {
    var v;
    do { v = VERBS[Math.floor(Math.random() * VERBS.length)]; } while (v === _currentVerb);
    return v;
  }

  function stopTimers() {
    clearInterval(_glyphIv); clearInterval(_typingIv); clearTimeout(_pauseTimer);
    _glyphIv = _typingIv = _pauseTimer = null;
  }

  function startTyping(verbEl) {
    var fixed = _currentRuntime === 'codex';
    var newVerb = fixed ? 'Working' : pick();
    var newText = newVerb + '...';
    var oldText = !fixed && _currentVerb ? _currentVerb + '...' : '';
    _currentVerb = newVerb;
    var len = newText.length, pos = 0;
    var frameMs = TYPING_MS / len;

    _typingIv = setInterval(function () {
      if (++pos > len) {
        clearInterval(_typingIv); _typingIv = null;
        verbEl.textContent = newText;
        _pauseTimer = setTimeout(function () { _pauseTimer = null; startTyping(verbEl); }, PAUSE_MS);
        return;
      }
      var right = pos < oldText.length ? oldText.slice(pos) : '';
      verbEl.innerHTML = newText.slice(0, pos) + CURSOR + right;
    }, frameMs);
  }

  window.updateSpinner = function () {
    var el = document.getElementById('cc-spinner');
    // Hide the spinner while a permission prompt is up — the user is answering, not waiting.
    var promptUp = typeof hasActivePermissionPrompt === 'function' && hasActivePermissionPrompt();
    // Hold the spinner until the skeleton clears — else it shows under the loading placeholder.
    var skeleton = !!document.querySelector('#content .skeleton-messages');
    var shouldShow = state.wsRunning && !promptUp && !skeleton;
    var runtime = state.appState.runtime === 'codex' ? 'codex' : 'claude';

    if (!shouldShow) {
      if (el) el.style.display = 'none';
      stopTimers();
      _currentVerb = '';
      _currentRuntime = '';
      return;
    }

    var content = document.getElementById('content');
    if (!el) {
      stopTimers();
      el = document.createElement('div');
      el.id = 'cc-spinner';
      el.className = 'cc-spinner';
      if (content) content.appendChild(el);
      else document.body.appendChild(el);
    }
    if (content && el.parentNode === content && el !== content.lastElementChild) {
      content.appendChild(el);
    }
    el.style.display = 'flex';

    if (_currentRuntime !== runtime) {
      stopTimers();
      _currentVerb = '';
      _currentRuntime = runtime;
    }

    if (!_glyphIv) {
      var frame = 0;
      el.innerHTML = '<span class="cc-spinner-glyph">' + FRAMES[0] + '</span><span class="cc-spinner-verb"></span>';
      var glyphEl = el.querySelector('.cc-spinner-glyph');
      var verbEl = el.querySelector('.cc-spinner-verb');

      _glyphIv = setInterval(function () {
        frame = (frame + 1) % FRAMES.length;
        glyphEl.textContent = FRAMES[frame];
      }, GLYPH_MS);

      startTyping(verbEl);
    }
  };
})();
