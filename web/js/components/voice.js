// Speech-to-text dictation for the message input. The iOS app uses the native
// plugin:speech (SFSpeechRecognizer) and keeps its mic in every Session. Elsewhere
// (Android app, browsers) the mic appears only in voice mode (voice-mode.js) and
// streams to Amazon Transcribe (voice-stream.js): hold to talk, or tap to start/stop.
// Both feed the same cumulative-transcript insertion model below.
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
import { showToast } from './toast.js';
import {
  captureMicrophone, decodeEvent, encodeAudioEvent, joinTranscript, transcribeLanguage, transcriptCollector,
} from './voice-stream.js';

(function () {
  var supported = null;   // native iOS speech; resolved lazily
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
  function lang() { return navigator.language || 'en-US'; }
  function detect() { return !!window.__TAURI_INTERNALS__ && /iPad|iPhone|iPod/.test(navigator.userAgent); }

  // Mic shows when: actively recording, dictation already started this draft (sticky),
  // or the field is empty. Manual typing into an empty field hides it (send takes over);
  // clearing the field brings it back.
  function canStream() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.WebSocket
      && (window.AudioContext || window.webkitAudioContext));
  }
  function native() {
    if (supported === null) supported = detect();
    return supported;
  }
  function available() {
    return native() || (canStream() && !!(window.voiceModeActive && window.voiceModeActive()));
  }

  window.updateMicButton = function () {
    var btn = document.getElementById('mic-btn');
    if (!btn) return;
    if (!recording && !input().value.trim()) stickyMic = false;
    btn.style.display = (available() && (recording || stickyMic || !input().value.trim())) ? 'flex' : 'none';
  };
  window.initVoiceButton = function () {
    bindStreamingMic();
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

  // ---------- streaming dictation (Android app, browsers) ----------

  var HOLD_MS = 400;
  var MAX_MS = 3 * 60 * 1000;
  var live = null;        // current streaming session
  var pressAt = null;  // pointerdown time of a press that started dictation

  function beginInsertion(focus) {
    var el = input();
    if (focus) el.focus();
    anchor = (document.activeElement === el) ? el.selectionStart : el.value.length;
    base = 0;
    interimLen = 0;
    lastRecoLen = 0;
    lastValue = el.value;
    stickyMic = true;
  }

  function commitInsertion() {
    anchor += interimLen;
    interimLen = 0;
    base = 0;
    lastRecoLen = 0;
  }

  // Each dictation is one or more segments, one Transcribe stream each. With automatic language
  // identification Transcribe settles the language once per stream, so after every finished
  // utterance (a pause) the next one starts on a fresh stream; audio captured while it connects
  // is queued and sent once it opens. A fixed language keeps a single stream.
  var URL_FRESH_MS = 4 * 60 * 1000;

  function startStream() {
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    var chosen = (window.voiceSettings && window.voiceSettings().language) || 'auto';
    var session = { id: ++gen, context: null, stream: null, flush: null, segments: [], spare: null,
      language: chosen === 'system' ? transcribeLanguage(lang()) : chosen,
      closing: false, autoSend: false, timer: 0 };
    session.rotate = session.language === 'auto';
    live = session;
    beginInsertion(false);
    setRecording(true);
    var placeholder = input().placeholder;
    session.restorePlaceholder = function () { input().placeholder = placeholder; };
    input().placeholder = 'Listening…';
    try { session.context = new AudioCtx(); } catch (e) { failStream(session, 'Microphone is not available'); return; }
    var first = newSegment(session);
    Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
      fetchUrl(session),
    ]).then(function (results) {
      session.stream = results[0];
      if (session.finished || live !== session) { releaseAudio(session); return; }
      if (session.rotate) prefetchUrl(session);
      connectSegment(session, first, results[1]);
      if (session.closing) return;
      captureMicrophone(session.context, session.stream, function (chunk) { sendChunk(session, chunk); })
        .then(function (flush) {
          session.flush = flush;
          if (session.closing) releaseAudio(session);
        }, function () { failStream(session, 'Could not read the microphone'); });
    }, function (error) {
      var denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      failStream(session, denied ? 'Microphone permission is off for Baton' : 'Could not start voice input');
    });
    session.timer = setTimeout(function () { stopStream(session, false); }, MAX_MS);
  }

  function fetchUrl(session) {
    return window.apiPost('/api/voice/stt-url', { language: session.language }).then(function (r) { return r.url; });
  }

  function prefetchUrl(session) {
    var promise = fetchUrl(session);
    promise.catch(noop);
    session.spare = { promise: promise, at: Date.now() };
  }

  function takeUrl(session) {
    var spare = session.spare;
    prefetchUrl(session);
    return spare && Date.now() - spare.at < URL_FRESH_MS ? spare.promise.catch(function () { return fetchUrl(session); })
      : session.spare.promise;
  }

  function newSegment(session) {
    var segment = { socket: null, collector: transcriptCollector(), queue: [], open: false, ended: false, closed: false };
    session.segments.push(segment);
    return segment;
  }

  function currentSegment(session) { return session.segments[session.segments.length - 1]; }

  function sessionText(session) {
    return session.segments.reduce(function (text, segment) { return joinTranscript(text, segment.collector.text()); }, '');
  }

  function sendChunk(session, chunk) {
    var segment = currentSegment(session);
    if (!segment || segment.ended) return;
    var frame = encodeAudioEvent(chunk);
    if (segment.open) segment.socket.send(frame);
    else segment.queue.push(frame);
  }

  // End of audio: Transcribe sends the last results for this segment, then closes.
  function endSegment(segment) {
    segment.ended = true;
    var socket = segment.socket;
    if (!segment.open || !socket || socket.readyState !== WebSocket.OPEN) return;  // onopen finishes it
    socket.send(encodeAudioEvent(new Uint8Array(0)));
    setTimeout(function () { if (socket.readyState !== WebSocket.CLOSED) socket.close(); }, 4000);
  }

  function rotateSegment(session) {
    var previous = currentSegment(session);
    var next = newSegment(session);
    endSegment(previous);
    takeUrl(session).then(function (url) {
      if (!session.finished) connectSegment(session, next, url);
    }, function () { failStream(session, 'Voice input connection failed'); });
  }

  function connectSegment(session, segment, url) {
    var socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    segment.socket = socket;
    socket.onopen = function () {
      segment.open = true;
      segment.queue.forEach(function (frame) { socket.send(frame); });
      segment.queue = [];
      if (segment.ended) endSegment(segment);
    };
    socket.onmessage = function (event) {
      var message;
      try { message = decodeEvent(new Uint8Array(event.data)); } catch (e) { return; }
      if (message.headers[':message-type'] !== 'event') {
        console.warn('Transcribe:', message.headers[':exception-type'] || message.headers[':error-code'], message.body);
        failStream(session, 'Voice input stopped');
        return;
      }
      if (session.finished) return;
      segment.collector.apply(message.body);
      onResult(sessionText(session), false);
      if (session.rotate && !session.closing && segment === currentSegment(session) && segment.collector.settled()) {
        rotateSegment(session);
      }
    };
    socket.onerror = function () { if (!session.closing && !segment.ended) failStream(session, 'Voice input connection failed'); };
    socket.onclose = function () {
      segment.closed = true;
      if (session.closing) {
        if (session.segments.every(function (s) { return s.closed || !s.socket && !s.queue.length; })) finishStream(session);
      } else if (!segment.ended) {
        failStream(session, 'Voice input connection lost');
      }
    };
  }

  function releaseAudio(session) {
    if (session.flush) { try { session.flush(); } catch (e) {} session.flush = null; }
    if (session.stream) session.stream.getTracks().forEach(function (track) { track.stop(); });
    if (session.context && session.context.state !== 'closed') session.context.close().catch(noop);
  }

  function stopStream(session, autoSend) {
    if (!session || session.closing) return;
    releaseAudio(session);  // flushes the last partial chunk into the current segment
    session.closing = true;
    session.autoSend = !!autoSend;
    clearTimeout(session.timer);
    if (live === session) setRecording(false);
    session.restorePlaceholder();
    var segment = currentSegment(session);
    if (segment) endSegment(segment);
    if (session.segments.every(function (s) { return s.closed || !s.socket && !s.queue.length; })) finishStream(session);
    else session.timer = setTimeout(function () { finishStream(session); }, 6000);
  }

  function finishStream(session) {
    if (session.finished) return;
    session.finished = true;
    clearTimeout(session.timer);
    releaseAudio(session);
    session.segments.forEach(function (segment) {
      if (segment.socket && segment.socket.readyState <= WebSocket.OPEN) segment.socket.close();
    });
    if (live !== session) return;
    live = null;
    setRecording(false);
    session.restorePlaceholder();
    var text = sessionText(session);
    if (text) onResult(text, false);
    commitInsertion();
    if (session.autoSend && text && window.voiceSettings && window.voiceSettings().autoSend
        && typeof window.onSendBtnClick === 'function') {
      setTimeout(window.onSendBtnClick, 0);
    }
  }

  function failStream(session, message) {
    if (session.finished) return;
    session.closing = true;
    finishStream(session);
    if (message) showToast(message);
  }

  var micBound = false;
  function bindStreamingMic() {
    var btn = document.getElementById('mic-btn');
    if (!btn || micBound) return;
    micBound = true;
    btn.addEventListener('contextmenu', function (event) { if (!native()) event.preventDefault(); });
    btn.addEventListener('pointerdown', function (event) {
      if (native() || event.button > 0) return;
      event.preventDefault();  // keep focus (and the soft keyboard) where it is
      if (live && !live.closing) { stopStream(live, true); pressAt = null; return; }
      pressAt = Date.now();
      startStream();
    });
    var release = function (cancelled) {
      if (native() || pressAt === null) return;
      var held = Date.now() - pressAt;
      pressAt = null;
      if (live && !live.closing && (cancelled || held >= HOLD_MS)) stopStream(live, !cancelled);
    };
    btn.addEventListener('pointerup', function () { release(false); });
    btn.addEventListener('pointercancel', function () { release(true); });
  }

  // Called by the send path so sending also ends dictation.
  window.stopDictation = function () {
    if (live) stopStream(live, false);
    else if (recording) stop();
  };

  window.toggleDictation = function () {
    if (!native()) return;  // streaming mic is driven by pointer events
    if (recording) stop(); else start();
  };
})();
