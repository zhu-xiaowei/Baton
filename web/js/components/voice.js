// Speech-to-text dictation for the message input. iOS only — uses the native
// plugin:speech (SFSpeechRecognizer). The browser Web Speech API performs poorly,
// so the mic is hidden everywhere except the iOS app.
//
// Native contract (SpeechPlugin.swift): each recognition session emits CUMULATIVE
// text per event { text, isFinal }. iOS auto-ends the task on isFinal, so to keep
// dictating we re-arm — but ONLY at that clean boundary. Restarting mid-stream
// (cancelling a live task) trips iOS's recognizer throttle, whose error lands on the
// live channel and used to flip recording off — the "mic closes the moment I edit"
// bug. So edits NEVER restart; they only advance `base`.
//
// Insertion model — one continuous session, cumulative text, edit-safe:
//   anchor      - field index where the current session's preview is inserted
//   base        - chars at the START of the cumulative transcript already committed
//                 to the field; the live preview is text.slice(base). An edit/caret
//                 move freezes the shown preview and advances base, so only speech
//                 NEW since the edit is inserted — without dropping the live session.
//   interimLen  - length of the live preview currently in the field (= shown - base)
//   lastRecoLen - cumulative length we last displayed; an edit freezes everything up
//                 to here (NOT up to the triggering event, which may run ahead of the
//                 display and would otherwise drop not-yet-shown words).
//   lastValue   - the field value we last wrote (anything else === a manual edit)
//   gen         - session generation; channel callbacks capture their own gen and
//                 ignore events once it's stale (after stop / isFinal re-arm).
//   stickyMic   - once dictation starts, mic stays available through any keyboard
//                 editing; resets only when the field is cleared.
(function () {
  var supported = null;   // resolved lazily: iOS app only
  var recording = false;
  var stickyMic = false;
  var anchor = 0;
  var base = 0;
  var interimLen = 0;
  var lastRecoLen = 0;
  var lastValue = '';
  var gen = 0;
  var errRetry = 0;
  var core = null;        // @tauri-apps/api/core (or window.__TAURI__.core)
  function noop() {}

  function input() { return document.getElementById('msg-input'); }
  // Recognition locale follows the iOS system language (navigator.language in WKWebView).
  function lang() { return navigator.language || 'zh-CN'; }
  function detect() { return !!window.__TAURI_INTERNALS__ && /iPad|iPhone|iPod/.test(navigator.userAgent); }

  // Mic shows when: actively recording, dictation already started this draft (sticky),
  // or the field is empty. Manual typing into an empty field hides it (send takes over);
  // clearing the field brings it back.
  window.updateMicButton = function () {
    var btn = document.getElementById('mic-btn');
    if (!btn) return;
    if (!recording && !input().value.trim()) stickyMic = false;
    btn.style.display = (supported && (recording || stickyMic || !input().value.trim())) ? 'flex' : 'none';
  };
  window.initVoiceButton = function () {
    if (supported === null) supported = detect();
    window.updateMicButton();
  };

  // Apply one recognition event. `text` is the session's cumulative transcript.
  function onResult(text, isFinal) {
    errRetry = 0;  // a real result means the session is healthy
    var el = input();
    var focused = document.activeElement === el;
    var caret = el.selectionStart;
    var edited = (el.value !== lastValue) || (focused && caret !== anchor + interimLen);

    if (interimLen > 0 && edited) {
      // User edited the field or moved the caret while a preview was live. Freeze the
      // shown preview in place (it becomes permanent) and re-anchor at the caret.
      // base jumps to lastRecoLen — everything ALREADY DISPLAYED is frozen; only
      // cumulative chars beyond it count as fresh speech. No restart: the session
      // keeps running, so the mic stays on.
      base = lastRecoLen;
      anchor = focused ? caret : el.value.length;
      interimLen = 0;  // leave the old preview untouched (committed); don't delete it
    } else if (interimLen === 0) {
      // No live preview — follow the caret so the next insertion lands where the user is.
      if (focused) anchor = caret;
    }
    if (anchor > el.value.length) anchor = el.value.length;

    if (text) {
      var preview = text.slice(base);  // only the not-yet-committed tail
      var v = el.value.slice(0, anchor) + el.value.slice(anchor + interimLen); // drop old preview
      v = v.slice(0, anchor) + preview + v.slice(anchor);                       // insert fresh tail
      el.value = v;
      interimLen = preview.length;
      var c = anchor + interimLen;
      el.setSelectionRange(c, c);
      el.dispatchEvent(new Event('input')); // auto-grow + updateSendBtn (+ updateMicButton)
      lastRecoLen = text.length;
    }
    lastValue = el.value;  // accept current field state (incl. any manual edit) as our baseline

    if (isFinal) {
      // Utterance ended (silence). Commit the preview, reset session offsets, and
      // re-arm at this clean boundary so dictation continues across sentences.
      anchor += interimLen;
      interimLen = 0;
      base = 0;
      lastRecoLen = 0;
      if (recording) restart();
    }
  }

  function setRecording(on) {
    recording = on;
    var btn = document.getElementById('mic-btn');
    if (btn) btn.classList.toggle('recording', on);
    window.updateMicButton();
  }

  function loadCore(cb) {
    if (core) return cb();
    if (window.__TAURI__ && window.__TAURI__.core) { core = window.__TAURI__.core; return cb(); }
    import('@tauri-apps/api/core').then(function (m) { core = m; cb(); }).catch(function () { stop(); });
  }

  function begin() {
    var myGen = gen;
    var ch = new core.Channel();
    ch.onmessage = function (e) {
      if (myGen !== gen || !recording) return;  // stale session or already stopped → ignore
      if (e.error) {
        // A clean-boundary re-arm can occasionally hiccup; retry silently a couple
        // times (reset by any good result) before giving up, rather than killing the mic.
        if (errRetry < 2) { errRetry++; gen++; begin(); } else stop();
        return;
      }
      onResult(e.text || '', !!e.isFinal);
    };
    core.invoke('plugin:speech|start_recognition', { locale: lang(), onEvent: ch })
      .catch(function () { if (myGen === gen) stop(); });
  }

  // Re-arm recognition at the clean isFinal boundary (old task already ended). Bump
  // the generation so the old channel goes stale, then start a fresh session. Called
  // ONLY from isFinal — never on edits (mid-stream restarts throttle/error on iOS).
  function restart() {
    gen++;
    if (recording) begin();
  }

  function start() {
    var el = input();
    el.focus();
    anchor = (document.activeElement === el) ? el.selectionStart : el.value.length;
    el.setSelectionRange(anchor, anchor);
    base = 0;
    interimLen = 0;
    lastRecoLen = 0;
    errRetry = 0;
    lastValue = el.value;
    stickyMic = true;
    setRecording(true);
    loadCore(function () {
      core.invoke('plugin:speech|request_permission')
        .then(function (r) { if (r && r.granted) begin(); else stop(); })
        .catch(function () { stop(); });
    });
  }

  function stop() {
    gen++;  // invalidate any in-flight channel so its trailing/cancel event is ignored
    setRecording(false);
    if (core) core.invoke('plugin:speech|stop_recognition').catch(noop);
  }

  // Called by the send path so sending also ends dictation.
  window.stopDictation = function () { if (recording) stop(); };

  window.toggleDictation = function () {
    if (supported === null) supported = detect();
    if (!supported) return;
    if (recording) stop(); else start();
  };
})();
