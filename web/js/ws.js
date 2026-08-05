// Fit mobile layout to the visual viewport throughout keyboard transitions.
import { state } from './state.js';
import { ReorderBuffer } from './reorder.js';

var _vpBaseHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
var _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
// Gate keyboard adaptation to touch devices: on desktop visualViewport also fires resize (scrollbar/chrome shifts, mermaid render), and the Android branch below would wrongly rewrite body height → input bar jumps.
var _isMobile = /Mobi|Android/i.test(navigator.userAgent) || _isIOS;
var _wsSendQueue = []; // payloads queued while socket not OPEN, flushed in order on connect

if (window.visualViewport && _isMobile) {
  var _wasKbUp = false;
  var syncMobileViewport = function () {
    var vv = window.visualViewport;
    _vpBaseHeight = Math.max(_vpBaseHeight, vv.height, window.innerHeight);
    var kbUp = vv.height < _vpBaseHeight * 0.75;
    var chromeHeight = 0;
    if (_isIOS && kbUp) {
      var topBar = document.querySelector('.top-bar');
      var breadcrumb = document.getElementById('breadcrumb');
      if (topBar) chromeHeight += topBar.offsetHeight;
      if (breadcrumb && getComputedStyle(breadcrumb).display !== 'none') {
        chromeHeight += breadcrumb.offsetHeight;
      }
    }
    document.body.style.bottom = 'auto';
    document.body.style.top = (_isIOS ? vv.offsetTop : 0) + 'px';
    document.body.style.height = (vv.height + chromeHeight) + 'px';
    document.body.style.transform = chromeHeight ? 'translateY(-' + chromeHeight + 'px)' : '';
    if (_isIOS) {
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.toggle('kb-up', kbUp);
    }
    if (window.positionScrollBtn) window.positionScrollBtn();
    if (kbUp !== _wasKbUp) {
      var c = document.getElementById('content');
      [50, 200, 400].forEach(function (d) {
        setTimeout(function () {
          if (window.positionScrollBtn) window.positionScrollBtn();
          if (c && state.appState.session) c.scrollTop = c.scrollHeight;
        }, d);
      });
    }
    _wasKbUp = kbUp;
  };
  window.visualViewport.addEventListener('resize', syncMobileViewport);
  if (_isIOS) window.visualViewport.addEventListener('scroll', syncMobileViewport);
  syncMobileViewport();
}

// Foreground resume: reconnect on hidden→visible only (not focus — desktop fires it on every click-back). See CLAUDE.md.
function handleForegroundResume() {
  if (document.visibilityState !== 'visible') return;
  if (!state.appState.session || state.appState.session === '__new__') return;
  if (!state.WS_URL) return;
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING) return;
  connectWs();
}
document.addEventListener('visibilitychange', handleForegroundResume);
window.addEventListener('pageshow', handleForegroundResume);

// Mirrors CC's SKIP_FIRST_PROMPT_PATTERN — kept in sync with bridge/session.mjs.
var SKIP_FIRST_PROMPT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

function extractFirstPromptFromMsg(msg) {
  if (msg.type !== 'user') return '';
  var c = msg.content;
  var texts = [];
  if (typeof c === 'string') texts = [c];
  else if (Array.isArray(c)) {
    for (var i = 0; i < c.length; i++) {
      if (c[i] && c[i].type === 'text' && c[i].text) texts.push(c[i].text);
    }
  }
  for (var j = 0; j < texts.length; j++) {
    var t = texts[j].replace(/\n/g, ' ').trim();
    if (!t) continue;
    var bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(t);
    if (bash) return '! ' + bash[1].trim();
    if (SKIP_FIRST_PROMPT.test(t)) continue;
    return t.length > 200 ? t.slice(0, 200).trim() + '…' : t;
  }
  return '';
}

function updateTitleFromMessages() {
  var customTitle = '', aiTitle = '', lastPrompt = '', firstUser = '';
  for (var i = 0; i < state.wsAllMessages.length; i++) {
    var m = state.wsAllMessages[i];
    if (m.type === 'custom-title' && m.content) customTitle = m.content;
    if (m.type === 'ai-title' && m.content) aiTitle = m.content;
    if (m.type === 'last-prompt' && m.content) lastPrompt = m.content;
    if (!firstUser) {
      var fp = extractFirstPromptFromMsg(m);
      if (fp) firstUser = fp;
    }
  }
  var tier = customTitle ? 4 : aiTitle ? 3 : lastPrompt ? 2 : firstUser ? 1 : 0;
  if (tier === 0) return;
  if (tier < (state._titleTier || 0)) return;
  var title = customTitle || aiTitle || lastPrompt || firstUser;
  if (title === state.appState.sessionPreview) return;
  state.appState.sessionPreview = title;
  state._titleTier = tier;
  updateBreadcrumb();
  saveNav();
}

// Skeleton → empty state + stop spinner, when a synced session has no real messages. Never wipe mid-send/stream: a fresh session has 0 DDB rows but a live bubble on screen.
function showEmptyMessages() {
  if (state.pendingSentMessages.length || state.wsRunning) return;
  var content = document.getElementById('content');
  if (content && !state.wsAllMessages.length) content.innerHTML = '<div class="empty">No messages</div>';
  state.wsRunning = false;
  updateSendBtn();
}

function connectWs(_, projectHash) {
  if (!state.WS_URL) {
    // First launch + no cached _wsurl: fetch config, then retry once
    var args = [_, projectHash];
    api('/api/bridge/config').then(function (cfg) {
      if (cfg.wsUrl) {
        state.WS_URL = cfg.wsUrl;
        localStorage.setItem('_wsurl', cfg.wsUrl);
        connectWs.apply(null, args);
      }
    }).catch(function () {});
    return;
  }
  if (projectHash) {
    state.wsProjectHash = projectHash;
    state.wsRequestId = crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  state.ws = new WebSocket(state.WS_URL + '?apiKey=' + state.KEY + '&role=app');

  state.ws.onopen = function () {
    setWsStatus('connected');
    if (state.wsSessionId) {
      subscribeSession(state.wsSessionId);
      if (state.wsLastTimestamp) recoverMissing();
    }
    if (_wsSendQueue.length) {
      var queued = _wsSendQueue;
      _wsSendQueue = [];
      for (var qi = 0; qi < queued.length; qi++) wsSend(queued[qi]);
    }
    if (window.prefetchCommands) window.prefetchCommands();
  };

  state.ws.onmessage = function (e) { handleWsMessage(JSON.parse(e.data)); };

  state.ws.onclose = function () {
    setWsStatus('disconnected');
    if (state.appState.session) {
      setWsStatus('reconnecting');
      setTimeout(function () { if (state.appState.session) connectWs(); }, 3000);
    }
  };

  state.ws.onerror = function () {};
}

// WS message dispatch — extracted from onmessage so the jsdom test harness can replay a captured WS sequence through the exact same handling (test/README.md).
function handleWsMessage(msg) {
    if (msg.action === 'messages' && msg.sessionId === state.wsSessionId) {
      if (state._wsBuffer !== null) {
        // Buffering during initial load — collect, don't render yet
        state._wsBuffer.push.apply(state._wsBuffer, msg.messages);
        return;
      }
      for (var i = 0; i < msg.messages.length; i++) {
        var m = msg.messages[i];
        if (m.uuid && state.wsAllMessages.some(function (x) { return x.uuid === m.uuid; })) continue;
        if (msg.streamId) m._streamId = msg.streamId; // ties row to its send (placement/dedup by identity)
        state.wsAllMessages.push(m);
        state.wsMessageCount++;
        if (m.timestamp) state.wsLastTimestamp = m.timestamp;
      }
      updateLastTurn();
      showStats(state.wsMessageCount + ' messages (' + msg.messages.length + ' new via WS)');
    } else if (msg.action === 'permission_request') {
      if (msg.sessionId === state.wsSessionId) showPermissionPrompt(msg);
    } else if (msg.action === 'send_message_result') {
      // Match the ack to its exact bubble by clientId (round-tripped through the
      // bridge). Fall back to "first undelivered" only for acks from an older
      // bridge that doesn't echo clientId yet.
      if (state.pendingSentMessages.length) {
        var pending = null;
        if (msg.clientId) {
          pending = findPending(msg.clientId);
        } else {
          for (var pi = 0; pi < state.pendingSentMessages.length; pi++) {
            if (!state.pendingSentMessages[pi].delivered) { pending = state.pendingSentMessages[pi]; break; }
          }
        }
        if (pending && !pending.delivered) resolvePending(pending, msg.ok, msg.error);
      }
      // Bind this turn's streamId to the sending bubble → live preview places under it.
      if (msg.streamId && msg.clientId) state.streamAnchors[msg.streamId] = msg.clientId;
      // New session: bridge spawned CC (headless), returned sessionId
      if (msg.sessionId && state.appState.session === '__new__' && (!msg.requestId || msg.requestId === state.wsRequestId)) {
        state.appState.session = msg.sessionId;
        state.appState.sessionPreview = 'New Session';
        updateBreadcrumb();
        saveNav();
        state.wsRequestId = null;
        subscribeSession(msg.sessionId);
        // Fold fetched rows in incrementally (updateLastTurn), never innerHTML-rebuild — a rebuild renders only wsAllMessages and wipes other in-flight optimistic bubbles.
        bufferAndFetch(msg.sessionId, '').then(function () {
          var container = document.querySelector('.messages');
          if (!container || !state.wsAllMessages.length) return;
          updateLastTurn();
          loadImages(container);
          clampOverflow(container);
          if (window.renderMermaidBlocks) renderMermaidBlocks(container);
          if (window.renderKatexBlocks) renderKatexBlocks(container);
          container.parentElement.scrollTop = container.parentElement.scrollHeight;
          updateTitleFromMessages();
        }).catch(function () {});
      }
    } else if (msg.action === 'sync_complete') {
      if (msg.sessionId !== state.wsSessionId) return;
      // No real messages (not_found / synced 0) → clear skeleton, don't hang.
      if (msg.status === 'not_found' || msg.count === 0) { showEmptyMessages(); return; }
      if (state._syncedOnce === msg.sessionId) return;
      state._syncedOnce = msg.sessionId;
      // Re-fetch + render once. Don't call loadMessages — that resets sessionPreview/_titleTier
      // and re-triggers needSync, causing a render-loop with title flicker.
      bufferAndFetch(msg.sessionId, '').then(function () {
        if (state.wsAllMessages.length === 0) { showEmptyMessages(); return; }
        var content = document.getElementById('content');
        content.innerHTML = '<div class="messages">' + renderMessages(state.wsAllMessages) + '</div>';
        state.wsRenderedCount = state.wsAllMessages.length;
        state.wsRunning = deriveRunning(state.wsAllMessages, state.wsOpenStatus);
        updateTitleFromMessages();
        updateSendBtn();
        loadImages(content);
        clampOverflow(content.querySelector('.messages'));
        if (window.renderMermaidBlocks) renderMermaidBlocks(content);
        if (window.renderKatexBlocks) renderKatexBlocks(content);
        content.scrollTop = content.scrollHeight;
      }).catch(function () {});
    } else if (msg.action === 'file_ready') {
      if (window.handleFileReady) window.handleFileReady(msg);
    } else if (msg.action === 'file_progress') {
      if (window.handleFileProgress) window.handleFileProgress(msg);
    } else if (msg.action === 'commands_list') {
      if (window.handleCommandsList) window.handleCommandsList(msg);
    } else if (msg.action === 'stream_delta') {
      if (msg.sessionId === state.wsSessionId) pushStreamFrame(msg.streamId, { t: 'delta', seq: msg.seq, blockId: msg.blockId, chunk: msg.chunk });
    } else if (msg.action === 'stream_tool_input') {
      if (msg.sessionId === state.wsSessionId) pushStreamFrame(msg.streamId, { t: 'input', seq: msg.seq, blockId: msg.blockId, chunk: msg.chunk });
    } else if (msg.action === 'stream_block_start') {
      if (msg.sessionId === state.wsSessionId) pushStreamFrame(msg.streamId, { t: 'start', seq: msg.seq, blockId: msg.blockId, kind: msg.kind, name: msg.name });
    } else if (msg.action === 'stream_block_stop') {
      if (msg.sessionId === state.wsSessionId) pushStreamFrame(msg.streamId, { t: 'stop', seq: msg.seq, blockId: msg.blockId });
    } else if (msg.action === 'stream_end') {
      if (msg.sessionId === state.wsSessionId) handleStreamEnd(msg.streamId, msg.finalSeq, msg.error);
    } else if (msg.action === 'delete_files_result') {
      var r = window._deleteFilesResolvers && window._deleteFilesResolvers[msg.requestId];
      if (r) { delete window._deleteFilesResolvers[msg.requestId]; r(msg); }
    } else if (msg.action === 'create_project_result') {
      if (state._pendingCreatePath && msg.projectPath === state._pendingCreatePath) {
        state._pendingCreatePath = null;
        if (msg.ok) {
          closeNewProjectModal();
          // Empty project isn't in the list yet (no session) — go straight to its
          // new-session input; the first message creates the session + PROJ#/SESS#.
          // Set project so the breadcrumb shows its name (we arrive from device level, not the list).
          // Fallback to the hash's trailing segment (…-test3 → test3) if projectName is absent.
          var pname = msg.projectName || (msg.projectHash || '').split('-').filter(Boolean).pop() || msg.projectHash;
          state.appState.project = { hash: msg.projectHash, name: pname };
          startNewSession(msg.projectHash, msg.asAgent);
        } else {
          disconnectWs();
          // Show error in modal, reset button
          var err = document.getElementById('newProjectError');
          var input = document.getElementById('newProjectInput');
          var btn = document.querySelector('#newProjectModal .modal-btn.confirm');
          if (err) err.textContent = msg.error || 'Unknown error';
          if (input) input.disabled = false;
          if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || 'Create'; }
        }
      }
    }
}

function subscribeSession(sessionId) {
  if (state.wsSessionId && state.wsSessionId !== sessionId) {
    wsSend({ action: 'unsubscribe', sessionId: state.wsSessionId });
    clearStreamPreviews();
    _streamEnded = {}; // switching sessions: drop ended-turn guards from the old one
    state.streamAnchors = {}; // anchors are per-session (old bubbles are gone)
    _lastStreamEndAt = 0;
  }
  state.wsSessionId = sessionId;
  wsSend({ action: 'subscribe', sessionId: sessionId });
  // Ask the bridge to re-push any control_request still awaiting an answer (refresh/reconnect re-shows the prompt).
  wsSend({ action: 'reveal_agent', sessionId: sessionId, device: state.appState.device || '' });
}

function wsSend(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(data));
}

// Non-OPEN → queue + reconnect (onopen flushes); use for user actions that must not drop.
function wsSendReliable(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
    return;
  }
  _wsSendQueue.push(data);
  if (!state.ws || state.ws.readyState === WebSocket.CLOSING || state.ws.readyState === WebSocket.CLOSED) {
    connectWs();
  }
}

function setWsStatus(status) {
  state.wsStatusText = status;
  showWsBanner(status);
}

function disconnectWs() {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
    state.wsSessionId = null;
    state.wsRunning = false;
    updateSpinner();
    setWsStatus('');
  }
}

function ensureWsAndSend(data) {
  wsSendReliable(data);
}

/**
 * Find insertion point: scan from end, return first element with data-ts > timestamp.
 * Skips elements without data-ts (pending messages). Returns null = insert at end of real messages.
 */
function findInsertBefore(container, timestamp) {
  if (!timestamp) return null;
  var kids = container.children;
  var result = null;
  for (var i = kids.length - 1; i >= 0; i--) {
    var ts = kids[i].dataset.ts;
    if (!ts) continue; // skip pending (no data-ts)
    if (ts > timestamp) {
      result = kids[i];
    } else {
      break; // found ts <= ours, stop
    }
  }
  return result;
}

// streamId → clientId → the question bubble that started this turn: returns the node to place the reply after (bubble, or its reply turn); null if no anchor (external/terminal send).
// Skip the transient stream-preview container — authoritative rows appended there get wiped by clearStreamPreviews.
function anchorForStream(container, streamId) {
  var clientId = state.streamAnchors[streamId];
  if (!clientId) return null;
  var bubble = container.querySelector('[data-anchor="' + clientId + '"]');
  if (!bubble) return null;
  var sib = bubble.nextElementSibling;
  return (sib && sib.classList.contains('assistant-turn') && !sib.classList.contains('stream-preview')) ? sib : bubble;
}

/** Insert html at correct timestamp position, before any pending messages. */
function insertAtTimestamp(container, html, timestamp) {
  var before = findInsertBefore(container, timestamp);
  if (before) {
    before.insertAdjacentHTML('beforebegin', html);
  } else {
    // Append after all real messages, before pending
    var firstPending = container.querySelector('[data-pending]');
    if (firstPending) firstPending.insertAdjacentHTML('beforebegin', html);
    else container.insertAdjacentHTML('beforeend', html);
  }
}

var _rb = {};          // streamId → ReorderBuffer (seq-ordered committed content)
var _ui = {};          // "streamId:blockId" → display-local reveal/animation state
var _streamEnded = {};
var _lastThinkSecs = 0; // seconds the live preview measured for the latest thinking block
var _streamRaf = null;
var _streamLastTick = 0;
// Last headless stream_end time; while fresh, trust it over deriveRunning (trailing rows are stop=null).
var _lastStreamEndAt = 0;
// Cumulative authoritative assistant block count for the in-flight turn = its preview supersede watermark. Accumulates across batches; reset per turn.
var _turnAuthBlocks = 0;

function blockKey(streamId, blockId) { return streamId + ':' + (blockId == null ? 0 : blockId); }

// One-line preview of a tool's input (best-effort; input may be partial JSON).
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command);                 // Bash
  if (input.file_path || input.path) return String(input.file_path || input.path); // Read/Write/Edit
  if (input.pattern) return String(input.pattern);                 // Grep/Glob
  if (input.url) return String(input.url);                         // WebFetch
  if (input.prompt) return String(input.prompt).slice(0, 200);     // Task/agent
  try { return JSON.stringify(input).slice(0, 200); } catch (e) { return ''; }
}

// Decode \uXXXX / \n etc. from a (possibly incomplete) JSON fragment for readable streaming preview.
function decodeJsonEscapes(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// One-line header desc from partial JSON: decoded fragment, matching the final card's truncated-JSON desc.
function previewPartialInput(partial) {
  return decodeJsonEscapes(partial).slice(0, 200);
}

function uiState(sid, bid) {
  var k = blockKey(sid, bid);
  return _ui[k] || (_ui[k] = { shown: 0, rendered: -1, thinkStart: 0, thinkMs: null, labelDone: false, inHash: '' });
}

// All preview frames funnel through here: reorder by seq, then animate the
// ordered result. Ordering lives in ReorderBuffer; the UI only reads its output.
function pushStreamFrame(streamId, frame) {
  if (!streamId || _streamEnded[streamId]) return; // ignore late frames after turn end
  var rb = _rb[streamId] || (_rb[streamId] = new ReorderBuffer());
  rb.push(frame);
  state.wsRunning = true; updateSendBtn();
  if (_streamRaf == null) _streamRaf = requestAnimationFrame(tickStreams);
}

function insertOrdered(turn, el, bid) {
  var kids = turn.children, ref = null;
  for (var i = 0; i < kids.length; i++) {
    var kb = parseInt(kids[i].dataset.bid, 10);
    if (!isNaN(kb) && kb > bid) { ref = kids[i]; break; }
  }
  turn.insertBefore(el, ref);
}

function tickStreams(now) {
  _streamRaf = requestAnimationFrame(tickStreams);
  if (now - _streamLastTick < 33) return;
  _streamLastTick = now;
  var container = document.querySelector('.messages');
  var content = document.getElementById('content');
  var active = false;
  var dirty = false; // any DOM mutation this frame → only then re-pin scroll (avoids a per-frame reflow)

  // One .assistant-turn per streamId; blocks come pre-ordered from the reorder buffer.
  for (var sid in _rb) {
    var rb = _rb[sid];
    var blocks = rb.orderedBlocks();
    // A gap holding back arrived frames → keep animating, don't let a block finalize early.
    var gap = rb.hasGap();
    // Stream ended (turn done or interrupted) → freeze timers; blocks may never get a stop frame.
    var ended = !!_streamEnded[sid];
    var turnId = 'stream-turn-' + sid;
    var turn = document.getElementById(turnId);
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var u = uiState(sid, b.blockId);
      var wantKind = b.kind === 'thinking' ? 'thinking' : (b.kind === 'tool_use' ? 'tool' : 'text');
      // Empty text block (start/stop, no delta) has nothing to show — skip it.
      if (wantKind === 'text' && b.committed.length === 0) continue;
      // Lazily create the turn only when there's a real block to show — a lone
      // start/stop frame must NOT leave an empty .assistant-turn (spurious connector line).
      if (container && !turn) {
        turn = document.createElement('div');
        turn.className = 'assistant-turn stream-preview';
        turn.id = turnId;
        // streamId → clientId → the exact question bubble; no anchor (external reply) → append at end.
        var anchorNode = anchorForStream(container, sid);
        if (anchorNode) anchorNode.insertAdjacentElement('afterend', turn);
        else container.appendChild(turn);
        markTurnAdjacency(container); // only on turn creation, not per frame
      }
      var elId = 'sb-' + sid + '-' + b.blockId;
      var el = document.getElementById(elId);
      if (turn && (!el || el.dataset.kind !== wantKind)) {
        if (el) el.remove();
        el = document.createElement('div');
        el.id = elId; el.dataset.kind = wantKind; el.dataset.bid = String(b.blockId);
        if (wantKind === 'thinking') {
          el.className = 'tl-item thinking-tl';
          var bodyId = 'tb-' + sid + '-' + b.blockId;
          el.innerHTML = '<div class="thinking-block"><div class="thinking-toggle" onclick="this.classList.toggle(\'open\');var x=document.getElementById(\'' + bodyId + '\');x.style.display=x.style.display===\'block\'?\'none\':\'block\'"><span class="think-label">Thinking</span> <span class="thinking-chevron">&#8250;</span></div><div class="thinking-body" id="' + bodyId + '"></div></div>';
        } else if (wantKind === 'tool') {
          el.className = 'tl-item tool-node tool-running';
        } else {
          el.className = 'tl-item assistant-text';
        }
        insertOrdered(turn, el, b.blockId);
        dirty = true;
      }
      if (!el) continue;

      if (wantKind === 'tool') {
        // Rebuild the live tool card only when its input JSON changed — parse/stringify/esc +
        // full innerHTML rewrite every frame on an unchanging input is pure waste.
        var raw = b.inputJson || '';
        if (raw !== u.inHash) {
          u.inHash = raw;
          var label = b.name || 'Tool';
          var desc = '', inRaw = '';
          if (raw) {
            try { var parsed = JSON.parse(raw); desc = summarizeToolInput(parsed); inRaw = JSON.stringify(parsed, null, 2).slice(0, 1000); }
            catch (e) { desc = previewPartialInput(raw).slice(0, 80); inRaw = decodeJsonEscapes(raw).slice(0, 1000); } // partial — decode \uXXXX live
          }
          el.innerHTML = '<div class="tool-header"><span class="tool-name">' + esc(label) + '</span>'
            + '<span class="tool-desc">' + esc(desc) + '</span>'
            + '<span class="tool-status">running</span></div>'
            // Clamp the preview IN to the final card's height (5.2em) so the authoritative row landing doesn't shrink it → no page jump.
            + (inRaw ? '<div class="tool-body"><div class="tool-body-content"><div class="tool-grid"><div class="tool-row"><div class="tool-label">IN</div><div class="tool-value clamp">' + esc(inRaw) + '</div></div></div></div></div>' : '');
          dirty = true;
        }
        if (!ended && (!b.stopped || gap)) active = true;
      } else if (wantKind === 'thinking') {
        if (!u.thinkStart) u.thinkStart = now;
        var lbl = el.querySelector('.think-label');
        var chars = Array.from(b.committed);
        if (chars.length) {
          u.shown += Math.max(3, Math.ceil((chars.length - u.shown) / 4));
          if (u.shown > chars.length) u.shown = chars.length;
          if (u.shown !== u.rendered) {
            var bd = el.querySelector('.thinking-body');
            if (bd) bd.textContent = chars.slice(0, u.shown).join('');
            u.rendered = u.shown; dirty = true;
          }
          if (u.shown < chars.length) active = true;
        }
        var elapsed = Math.max(1, Math.round((now - u.thinkStart) / 1000));
        _lastThinkSecs = elapsed; // update every tick so an authoritative row landing any time keeps the measured seconds
        var thinkDone = ended || (b.stopped && !gap && u.shown >= chars.length);
        if (!thinkDone) {
          if (lbl) lbl.textContent = 'Thinking ' + elapsed + 's';
          active = true;
        } else if (!u.labelDone && lbl) {
          lbl.textContent = 'Thought for ' + elapsed + 's';
          u.labelDone = true;
        }
      } else {
        var tchars = Array.from(b.committed);
        u.shown += Math.max(3, Math.ceil((tchars.length - u.shown) / 4));
        if (u.shown > tchars.length) u.shown = tchars.length;
        var caughtUp = u.shown >= tchars.length;
        // Only re-render markdown when the revealed length changed — renderMd (marked + hljs
        // + regex) is the frame's heaviest op; re-running it on an unchanged string is waste.
        if (u.shown !== u.rendered && window.renderMd) {
          // renderStreamMd reconciles in place: mermaid blocks are persistent nodes (no flicker), text rebuilds each frame.
          window.renderStreamMd(el, tchars.slice(0, u.shown).join(''));
          u.rendered = u.shown; dirty = true;
          if (window.renderMermaidBlocks && el.querySelector('.mermaid-block')) renderMermaidBlocks(el);
          if (window.renderKatexBlocks) renderKatexBlocks(el);
        }
        // Keep animating until caught up AND the block is truly done (stopped, no gap).
        // A stream that ended (interrupt) may never send stop → don't wait past caught-up.
        if (!caughtUp || (!ended && (!b.stopped || gap))) active = true;
      }
    }
  }
  if (dirty && state.stickBottom && content) content.scrollTop = content.scrollHeight;
  if (!active) { cancelAnimationFrame(_streamRaf); _streamRaf = null; }
}

function handleStreamEnd(streamId, finalSeq, error) {
  if (!streamId) return;
  var rb = _rb[streamId];
  if (rb) rb.end(finalSeq); // reconcile: turn ends only once ordered region reaches finalSeq
  _streamEnded[streamId] = true;
  _lastStreamEndAt = Date.now();
  if (error) {
    var t = document.getElementById('stream-turn-' + streamId);
    if (t) t.classList.add('stream-error');
  }
  // Keep streamAnchors[streamId]: the authoritative row arrives AFTER stream_end and still needs the anchor (deleting here stranded it → reply fell to bottom). Cleared on session switch.
  _turnAuthBlocks = 0; // turn boundary — next turn's supersede count starts fresh
  state.wsRunning = false;
  updateSendBtn();
}

function clearStreamPreviews(coverCount) {
  if (_streamRaf != null) { cancelAnimationFrame(_streamRaf); _streamRaf = null; }
  _ui = {};
  // A turn can flush an authoritative row mid-stream yet keep emitting later blocks under
  // the SAME streamId. Wiping the buffer would restart nextSeq at 0 and strand continuing
  // frames. So: fully drop ended streams; soft-reset live ones (supersede only covered blocks).
  var kept = {};
  for (var sid in _rb) {
    if (_streamEnded[sid]) continue; // ended → discard
    _rb[sid].softReset(coverCount);
    kept[sid] = _rb[sid];
  }
  _rb = kept;
  var previews = document.querySelectorAll('[id^="stream-turn-"]');
  var container = null;
  for (var i = 0; i < previews.length; i++) {
    if (!container) container = previews[i].parentNode;
    previews[i].remove();
  }
  markTurnAdjacency(container || document.querySelector('.messages'));
}

// Cross-turn connector adjacency via explicit classes — replaces :has(+)/+ which WebKit (Safari) won't re-invalidate on live inserts. Call only when a turn is added/removed, never per frame.
function markTurnAdjacency(container) {
  if (!container) return;
  var kids = container.children;
  for (var i = 0; i < kids.length; i++) {
    var el = kids[i];
    if (!el.classList || !el.classList.contains('assistant-turn')) continue;
    var next = el.nextElementSibling;
    el.classList.toggle('has-next-turn', !!(next && next.classList.contains('assistant-turn')));
    var prev = el.previousElementSibling;
    el.classList.toggle('follows-turn', !!(prev && prev.classList.contains('assistant-turn')));
  }
}
window.markTurnAdjacency = markTurnAdjacency;

// Authoritative thinking has no duration; use the seconds the live preview measured.
function applyThinkSecs(html) {
  if (!_lastThinkSecs || html.indexOf('thinking-toggle') === -1) return html;
  return html.replace(/(<div class="thinking-toggle"[^>]*>)Thinking( <span)/, '$1Thought for ' + _lastThinkSecs + 's$2');
}

function updateLastTurn() {
  var container = document.querySelector('.messages');
  if (!container) return;

  var newMessages = state.wsAllMessages.slice(state.wsRenderedCount);
  state.wsRenderedCount = state.wsAllMessages.length;
  if (!newMessages.length) return;

  var el = document.getElementById('content');

  // Sort batch by timestamp
  if (newMessages.length > 1) {
    newMessages.sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? -1 : (a.timestamp || '') > (b.timestamp || '') ? 1 : 0; });
  }

  // Supersede preview blocks the authoritative rows cover. Headless splits one turn's thinking/text into separate rows (each len 1), so a per-batch count strands later blocks → a trailing tick revives them (duplicate); accumulate across batches instead. Reset on stream_end.
  for (var ai = 0; ai < newMessages.length; ai++) {
    if (newMessages[ai].type === 'assistant' && Array.isArray(newMessages[ai].content)) {
      _turnAuthBlocks += newMessages[ai].content.length;
    }
  }
  if (_turnAuthBlocks > 0) clearStreamPreviews(_turnAuthBlocks);

  var sawToolResult = false;
  for (var i = 0; i < newMessages.length; i++) {
    var msg = newMessages[i];
    // tool_result → update matching tool_use node
    if (isToolResultOnly(msg)) {
      sawToolResult = true;
      if (Array.isArray(msg.content)) {
        for (var ri = 0; ri < msg.content.length; ri++) {
          var rb = msg.content[ri];
          if (rb.type !== 'tool_result' || !rb.tool_use_id) continue;
          var node = container.querySelector('[data-tool-id="' + rb.tool_use_id + '"]');
          if (!node) continue;
          var toolUseBlock = null;
          for (var mi = 0; mi < state.wsAllMessages.length; mi++) {
            var am = state.wsAllMessages[mi];
            if (!Array.isArray(am.content)) continue;
            for (var bi = 0; bi < am.content.length; bi++) {
              if (am.content[bi].type === 'tool_use' && am.content[bi].id === rb.tool_use_id) { toolUseBlock = am.content[bi]; break; }
            }
            if (toolUseBlock) break;
          }
          if (!toolUseBlock) continue;
          if (msg.toolUseResult) rb._agentMeta = msg.toolUseResult;
          window._lastToolState = '';
          node.innerHTML = renderToolNode(toolUseBlock, rb);
          var toolStateClass = window._lastToolState || '';
          node.className = 'tl-item tool-node' + (toolStateClass ? ' ' + toolStateClass : '');
        }
      }
      continue;
    }

    // Local command stdout (e.g. /compact result): render as cmd-output.
    if (window.isLocalCommandStdout && window.isLocalCommandStdout(msg)) {
      if (tryDedup(msg)) continue;
      var stdoutHtml = window.renderLocalCommandStdout(msg);
      if (stdoutHtml) insertAtTimestamp(container, stdoutHtml, msg.timestamp);
      continue;
    }

    // User message
    if (msg.type === 'user' && !isInterruptMsg(msg)) {
      if (tryDedup(msg)) { updateTitleFromMessages(); continue; }
      var userHtml = renderUserBubble(msg);
      if (userHtml) insertAtTimestamp(container, userHtml, msg.timestamp);
      // Trivial-first-message sessions get no ai-title (last-prompt lands only on shutdown) → fall title back to first user prompt (idempotent; tier won't downgrade).
      updateTitleFromMessages();
      continue;
    }

    // Metadata types: update title only, don't render
    if (msg.type === 'ai-title' || msg.type === 'custom-title' || msg.type === 'last-prompt') {
      updateTitleFromMessages();
      continue;
    }

    // Assistant message
    if (msg.type !== 'assistant' && !isInterruptMsg(msg)) continue;

    var html = renderSingleMessage(msg, state.wsAllMessages);
    if (!html) continue;
    html = applyThinkSecs(html); // carry live-measured thinking seconds into the empty authoritative node

    // Primary: place under the exact question via streamId→clientId→[data-anchor] (identity, not timestamp).
    var anchor = msg._streamId ? anchorForStream(container, msg._streamId) : null;
    if (anchor) {
      if (anchor.classList.contains('assistant-turn')) {
        // Order within the turn by data-ts — rows can arrive out of order (an interrupt row
        // reaches the app before the turn's authoritative full-text row it precedes visually).
        var before = null, kids = anchor.children;
        for (var ci = 0; ci < kids.length; ci++) {
          if (kids[ci].dataset && kids[ci].dataset.ts && kids[ci].dataset.ts > msg.timestamp) { before = kids[ci]; break; }
        }
        if (before) before.insertAdjacentHTML('beforebegin', html);
        else { anchor.insertAdjacentHTML('beforeend', html); if (msg.timestamp) anchor.dataset.ts = msg.timestamp; }
      } else {
        // Anchor is the question bubble (no real reply turn yet). If a live stream preview for this turn is still on screen (thinking-only interrupt → no authoritative row ever cleared it), the row belongs AFTER the preview, not between bubble and preview.
        var after = anchor;
        var preview = document.getElementById('stream-turn-' + msg._streamId);
        if (preview && preview.previousElementSibling === anchor) after = preview;
        after.insertAdjacentHTML('afterend', '<div class="assistant-turn" data-ts="' + (msg.timestamp || '') + '">' + html + '</div>');
      }
      continue;
    }

    // Fallback (external/historical rows, no streamId): insert before the first later-timestamped node, else append.
    var allItems = container.querySelectorAll('[data-ts]');
    var target = null;
    for (var j = allItems.length - 1; j >= 0; j--) {
      if (allItems[j].dataset.ts > msg.timestamp) target = allItems[j];
      else break;
    }
    if (target) target.insertAdjacentHTML('beforebegin', html);
    else container.insertAdjacentHTML('beforeend', '<div class="assistant-turn" data-ts="' + (msg.timestamp || '') + '">' + html + '</div>');
  }
  markTurnAdjacency(container); // turns may have been added this batch
  // Pure metadata frames (ai-title/last-prompt) arrive at a new turn's start before
  // the first real reply; deriveRunning skips them and scans back to the prior
  // end_turn → idle, flickering the spinner off. Only let real assistant/user frames
  // downgrade a running spinner; metadata-only batches keep the current state.
  var derived = deriveRunning(state.wsAllMessages);
  var hasTurnFrame = newMessages.some(function (m) {
    return m.type === 'assistant' || m.type === 'user';
  });
  // A real turn frame supersedes the open-time snapshot — from here the live
  // stream is authoritative (per the "initial load only" trust decision).
  if (hasTurnFrame) state.wsOpenStatus = null;
  // A fresh stream_end means the turn is over; don't let stop=null trailing rows re-light the spinner.
  var streamEndFresh = _lastStreamEndAt && (Date.now() - _lastStreamEndAt < 4000);
  if (!streamEndFresh && (derived || hasTurnFrame)) state.wsRunning = derived;
  updateSendBtn();

  // Don't dismiss a prompt still awaiting the user's answer (prompts are bridge-driven).
  var promptEl = document.getElementById('permission-prompt');
  if (promptEl && !(typeof hasActivePermissionPrompt === 'function' && hasActivePermissionPrompt())) {
    dismissPermissionPrompt();
  } else if (promptEl && sawToolResult) {
    dismissPermissionPrompt(); // OUT arrived → another device (or this turn) answered; drop our stale prompt
  } else if (promptEl && promptEl !== container.lastElementChild) {
    container.appendChild(promptEl); // keep the prompt pinned below the AskUserQuestion card that just landed
  }
  if (typeof maybeRevealStuckAgent === 'function') maybeRevealStuckAgent(state.wsSessionId);

  // turnEnded (real frame brought CC to idle) → clean queued msgs that never echoed.
  reconcileEchoedPending(hasTurnFrame && !derived);

  // Clamp before scrolling so scrollTop uses the collapsed final height.
  loadImages(container);
  clampOverflow(container);
  if (window.renderMermaidBlocks) renderMermaidBlocks(container);
  if (window.renderKatexBlocks) renderKatexBlocks(container);
  if (state.stickBottom) {
    el.scrollTop = el.scrollHeight;
  }
  showStats(state.wsMessageCount + ' messages (live)');
}

function startWs(sessionId) {
  state.wsSessionId = sessionId;
  state._syncedOnce = null;
  if (!state.ws) connectWs();
  else subscribeSession(sessionId);
  // Prefetch slash commands. When ws already exists this sends now; on a fresh
  // connect the socket isn't OPEN yet so this no-ops and onopen handles it.
  if (window.prefetchCommands) window.prefetchCommands();
}

/**
 * Buffer WS → fetch DDB → merge + dedup → return merged messages.
 * Used by both initial load (after='') and reconnect recovery (after=wsLastTimestamp).
 */
async function bufferAndFetch(sessionId, after) {
  state._wsBuffer = [];
  try {
    var params = { session: sessionId };
    if (after) params.after = after;
    if (state.appState.device) params.device = state.appState.device;
    var data = await api('/api/bridge/messages', params);
    // User navigated to another session while this was in flight — drop the stale response.
    if (state.wsSessionId !== sessionId) return { added: 0, needSync: false };
    var all = (data.messages || []).concat(state._wsBuffer || []);
    state._wsBuffer = null;
    // Dedup against existing wsAllMessages
    var existing = {};
    for (var i = 0; i < state.wsAllMessages.length; i++) existing[state.wsAllMessages[i].uuid] = 1;
    var added = 0;
    for (var i = 0; i < all.length; i++) {
      if (!existing[all[i].uuid]) {
        state.wsAllMessages.push(all[i]);
        state.wsMessageCount++;
        added++;
      }
    }
    if (added > 0) {
      state.wsAllMessages.sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? -1 : (a.timestamp || '') > (b.timestamp || '') ? 1 : 0; });
    }
    state.wsLastTimestamp = state.wsAllMessages.length ? state.wsAllMessages[state.wsAllMessages.length - 1].timestamp || '' : '';
    // Save pagination state from initial load
    if (!after && data.hasMore !== undefined) {
      state.wsHasMore = data.hasMore;
      state.wsOldestTimestamp = data.oldestTimestamp || '';
    }
    return { added: added, needSync: data.needSync };
  } catch (e) { state._wsBuffer = null; throw e; }
}

/**
 * Load older messages (triggered by scroll-to-top).
 * Prepends to wsAllMessages and returns the loaded messages for DOM prepend.
 */
async function loadOlderMessages(sessionId) {
  if (state.wsLoadingOlder || !state.wsHasMore || !state.wsOldestTimestamp) return null;
  state.wsLoadingOlder = true;
  try {
    var data = await api('/api/bridge/messages', { session: sessionId, before: state.wsOldestTimestamp });
    var msgs = data.messages || [];
    state.wsHasMore = data.hasMore;
    state.wsOldestTimestamp = data.oldestTimestamp || '';
    // Dedup and prepend
    var existing = {};
    for (var i = 0; i < state.wsAllMessages.length; i++) existing[state.wsAllMessages[i].uuid] = 1;
    var newMsgs = [];
    for (var i = 0; i < msgs.length; i++) {
      if (!existing[msgs[i].uuid]) {
        newMsgs.push(msgs[i]);
        state.wsMessageCount++;
      }
    }
    if (newMsgs.length) {
      state.wsAllMessages = newMsgs.concat(state.wsAllMessages);
      state.wsRenderedCount += newMsgs.length;
    }
    return newMsgs;
  } finally {
    state.wsLoadingOlder = false;
  }
}

// Reconnect recovery
async function recoverMissing() {
  try {
    var result = await bufferAndFetch(state.wsSessionId, state.wsLastTimestamp);
    if (!result.added) return;
    var container = document.querySelector('.messages');
    if (container) {
      clearStreamPreviews();
      container.innerHTML = renderMessages(state.wsAllMessages);
      state.wsRenderedCount = state.wsAllMessages.length;
      state.wsRunning = deriveRunning(state.wsAllMessages);
      updateSendBtn();
      loadImages(container);
      clampOverflow(container);
      if (window.renderMermaidBlocks) renderMermaidBlocks(container);
      if (window.renderKatexBlocks) renderKatexBlocks(container);
      container.parentElement.scrollTop = container.parentElement.scrollHeight;
    }
    showStats(state.wsMessageCount + ' messages (' + result.added + ' recovered)');
  } catch (e) {}
}

function sendMessage() {
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var images = state.stagedImages.slice();

  if (!text && !images.length) return;
  if (!text && images.length) text = 'Please review the attached image';
  // Allow sending without wsSessionId for new sessions (projectHash is used)
  if (!state.wsSessionId && state.appState.session !== '__new__') return;
  // Agent sessions require at least 4 characters for the task description
  var agentCb = document.getElementById('newAsAgent');
  if (state.appState.session === '__new__' && agentCb && agentCb.checked && text.length < 4) return;

  // Images already uploaded — just assemble refs.
  // Keep image markdown refs on the SAME line as text (separated by spaces) — putting `!`
  // at line start triggers Ink's shell-out mode in CC, causing bash syntax errors.
  var readyImages = images.filter(function (img) { return img.uploaded && img.key; });
  if (readyImages.length) {
    var refs = readyImages.map(function (img) { return '![](claude-bridge:' + img.key + ')'; }).join(' ');
    doSend(text + ' ' + refs, text, readyImages);
  } else {
    doSend(text, text, []);
  }

  state.stagedImages = [];
  renderStagedImages();
  input.value = '';
  input.style.height = 'auto';
  if (typeof stopDictation === 'function') stopDictation();  // sending ends dictation too
  if (!/Mobi|Android/i.test(navigator.userAgent)) input.focus();
}

// Textarea: Enter sends, Shift+Enter newline, auto-grow, toggle send/stop button
var _stopSvg = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/></svg>';
var _sendSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
function updateSendBtn() {
  var btn = document.getElementById('send-btn');
  var textLen = document.getElementById('msg-input').value.trim().length;
  var agentCb = document.getElementById('newAsAgent');
  var isNewAgent = state.appState.session === '__new__' && agentCb && agentCb.checked;
  var hasText = textLen >= (isNewAgent ? 4 : 1);
  var cls = hasText ? 'has-text' : (state.wsRunning ? 'is-stop' : '');
  var icon = cls === 'is-stop' ? 'stop' : 'send';
  // Only rewrite innerHTML when the icon actually changes. Rewriting it every stream frame
  // detaches the SVG mid-tap, dropping a click that landed on it (had to tap 2-3×).
  if (btn.dataset.icon !== icon) { btn.innerHTML = icon === 'stop' ? _stopSvg : _sendSvg; btn.dataset.icon = icon; }
  if (btn.className !== cls) btn.className = cls;
  btn.disabled = !hasText && !state.wsRunning;
  if (typeof updateSpinner === 'function') updateSpinner();
  if (typeof updateMicButton === 'function') updateMicButton();
}
function onSendBtnClick() {
  var input = document.getElementById('msg-input');
  var isMobile = /Mobi|Android/i.test(navigator.userAgent);
  var kbWasUp = isMobile && window.visualViewport && window.visualViewport.height < _vpBaseHeight * 0.75;
  // New-session first send: dismiss keyboard before the centered→bottom swap
  var isFirstNewSessionSend = document.body.classList.contains('new-session');

  if (input.value.trim()) {
    if (isMobile && kbWasUp && isFirstNewSessionSend) {
      input.blur();
      var doSendAfterKbDown = function () { sendMessage(); updateSendBtn(); };
      if (window.visualViewport) {
        var onResize = function () {
          if (window.visualViewport.height >= _vpBaseHeight * 0.95) {
            window.visualViewport.removeEventListener('resize', onResize);
            doSendAfterKbDown();
          }
        };
        window.visualViewport.addEventListener('resize', onResize);
        setTimeout(function () {
          window.visualViewport.removeEventListener('resize', onResize);
          doSendAfterKbDown();
        }, 350);
      } else {
        setTimeout(doSendAfterKbDown, 250);
      }
      return;
    }

    sendMessage();
    updateSendBtn();
    // Keep keyboard open on mobile after sending
    if (isMobile && kbWasUp) input.focus();
  } else if (state.wsRunning) {
    interruptSession();
  }

  if (isMobile && !kbWasUp) input.blur();
}
function interruptSession() {
  if (!state.wsSessionId) return;
  // A permission prompt owns the interrupt: cancelling it denies+interrupts CC, so don't also send a bare interrupt.
  if (typeof hasActivePermissionPrompt === 'function' && hasActivePermissionPrompt()) {
    cancelPermissionPrompt();
    return;
  }
  wsSendReliable({ action: 'interrupt', sessionId: state.wsSessionId, device: state.appState.device || '' });
  state.wsRunning = false;
  updateSendBtn();
}
(function () {
  var el = document.getElementById('msg-input');
  el.addEventListener('keydown', function (e) {
    // IME composition: Enter confirms the candidate, not a send. Sending here
    // clears the input, then compositionend re-fills it → duplicate send + leftover text.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); updateSendBtn(); }
  });
  el.addEventListener('input', function () {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
    updateSendBtn();
  });
})();
// Global Esc → interrupt the running turn, like CC. Bubble phase so overlays
// that own Esc (slash popup handles it in capture phase; file/image viewers
// close first) keep priority — we only act when nothing else claimed the key.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (e.isComposing || e.keyCode === 229) return;
  // Yield to open overlays/modals that give Esc its own meaning.
  if (document.getElementById('permission-prompt')) return;
  var fileO = document.getElementById('fileOverlay');
  if (fileO && fileO.style.display === 'flex') return;
  var imgO = document.getElementById('imgOverlay');
  if (imgO && imgO.style.display === 'flex') return;
  var newP = document.getElementById('newProjectModal');
  if (newP && newP.style.display === 'flex') return;
  if (!state.wsRunning) return;
  e.preventDefault();
  interruptSession();
});

var _clientIdSeq = 0;

function doSend(fullText, displayText, images) {
  state.wsRunning = true;
  _lastStreamEndAt = 0; // new turn starting — drop any stale stream_end freshness
  updateSendBtn();
  var device = state.appState.device || '';
  // Unique per-send id, round-tripped through the bridge in send_message_result
  // so the ack maps back to THIS exact bubble (not "the first pending", which
  // mis-pairs when several sends are in flight). Doubles as the DOM element id.
  var seq = _clientIdSeq++;
  var msgId = 'sent-' + Date.now() + '-' + seq;
  if (state.appState.session === '__new__' && state.wsProjectHash) {
    var asAgent = !!(document.getElementById('newAsAgent') && document.getElementById('newAsAgent').checked);
    wsSendReliable({ action: 'send_message', projectHash: state.wsProjectHash, requestId: state.wsRequestId, clientId: msgId, text: fullText, device: device, asAgent: asAgent });
  } else {
    // projectHash lets the bridge resolve cwd even if the jsonl is gone (deleted session).
    var ph = state.appState.project && state.appState.project.hash;
    wsSendReliable({ action: 'send_message', sessionId: state.wsSessionId, projectHash: ph, clientId: msgId, text: fullText, device: device });
  }

  // Empty session has no .messages yet; create one or the bubble + preview have nowhere to render.
  var empty = document.querySelector('.empty');
  if (empty) empty.remove();
  var contentEl = document.getElementById('content');
  if (contentEl && !contentEl.querySelector('.messages')) {
    contentEl.insertAdjacentHTML('beforeend', '<div class="messages"></div>');
  }

  // Exit new-session centered layout once the user sends the first message
  if (document.body.classList.contains('new-session')) {
    document.body.classList.remove('new-session');
    var hero = document.querySelector('.new-session-hero');
    if (hero) hero.remove();
    var msgs = document.querySelector('.messages');
    if (msgs) msgs.removeAttribute('hidden');
    // Restore input-bar to body (it was moved into #content for centered layout)
    var bar = document.getElementById('input-bar');
    if (bar && bar.parentElement !== document.body) document.body.appendChild(bar);
  }

  // Keep fullText (with image refs) so a retry re-sends the exact same payload;
  // sessionId pins the message to its session so a timeout that fires after the
  // user navigated away doesn't self-heal against the wrong conversation.
  // echoScanFrom: only user rows arriving AFTER this send count as its echo (else a historical same-text row false-retires the bubble — kills short/repeated sends).
  state.pendingSentMessages.push({ id: msgId, seq: seq, text: displayText, fullText: fullText, images: images, isImage: images.length > 0, sessionId: state.wsSessionId, sentAt: Date.now(), echoScanFrom: state.wsAllMessages.length });
  var container = document.querySelector('.messages');
  if (container) {
    var imgHtml = images.map(function (img) {
      return '<div class="img-placeholder loaded"><img src="' + img.dataUrl + '" onclick="viewImage(this.src)" /></div>';
    }).join('');
    var attachHtml = imgHtml ? '<div class="msg-attachments">' + imgHtml + '</div>' : '';
    // data-anchor is the durable placement id: survives echo promotion (unlike data-pending) so the reply lands here.
    container.insertAdjacentHTML('beforeend',
      '<div class="msg-user" id="' + msgId + '" data-pending="1" data-anchor="' + msgId + '">' + attachHtml
      + '<div class="msg-text" onclick="toggleExpand(this)">' + esc(displayText) + '</div>'
      + '<div class="msg-meta"><span class="msg-time sending-status">sending...</span></div></div>');
    clampOverflow(container);
    state.stickBottom = true; // sending a message = follow the incoming reply
    document.getElementById('content').scrollTo({ top: 99999, behavior: 'smooth' });
  }
  scheduleSendTimeout(msgId);
}

// If neither the send_message_result ack nor the echoed-message dedup clears a
// pending bubble within this window, reconcile against the server: the message
// may well have reached CC and only the ack/echo was lost.
var SEND_TIMEOUT_MS = 12000;

function scheduleSendTimeout(msgId) {
  setTimeout(function () { reconcilePendingSend(msgId); }, SEND_TIMEOUT_MS);
}

function findPending(msgId) {
  for (var i = 0; i < state.pendingSentMessages.length; i++) {
    if (state.pendingSentMessages[i].id === msgId) return state.pendingSentMessages[i];
  }
  return null;
}

function removePending(pending) {
  var idx = state.pendingSentMessages.indexOf(pending);
  if (idx !== -1) state.pendingSentMessages.splice(idx, 1);
}

// Single terminal state for an ack. Success: stamp the bubble with a time and
// mark delivered — the bubble stays as the timestamped anchor; when the echoed
// copy arrives, tryDedup finds this delivered pending and drops the duplicate
// (see tryDedup). Failure: red "Not delivered · Retry" and stop the spinner.
function resolvePending(pending, ok, error) {
  pending.delivered = true;
  if (ok) {
    bumpDeliveredSeq(pending.seq);
    markPendingTime(pending);
  } else {
    markPendingFailed(pending, error);
    state.wsRunning = false;
    updateSendBtn();
  }
}

// Loose match: the echoed user message may differ from what we typed (CC can
// rewrite slash commands), so accept containment rather than strict equality.
// Compares against stripped text (no image refs).
function messageEchoed(pending) {
  var needle = stripImageRefs((pending.text || '').trim());
  if (!needle) return false;
  // Scan only rows after this send (echoScanFrom); a historical same-text row isn't its echo.
  var from = pending.echoScanFrom || 0;
  for (var i = from; i < state.wsAllMessages.length; i++) {
    var m = state.wsAllMessages[i];
    if (m.type !== 'user') continue;
    var hay = stripImageRefs(extractMsgText(m).trim());
    if (hay && (hay === needle || hay.indexOf(needle) !== -1 || needle.indexOf(hay) !== -1)) return true;
  }
  return false;
}

// Raise the delivered-seq watermark when a send is confirmed reached CC (echo
// matched, or ack ok). Persists across pending removal, so orphan detection works
// even after the confirmed pending itself is gone.
function bumpDeliveredSeq(seq) {
  if (typeof seq === 'number' && seq > state.lastDeliveredSeq) state.lastDeliveredSeq = seq;
}

// Retire orphaned optimistic bubbles. Drop a pending when: echo present; OR a later
// send was confirmed first (seq < watermark); OR turnEnded — CC came to rest yet it
// never echoed, i.e. a running-time queued msg logged as queue-operation not a user
// entry (docs/headless-streaming.md §12), covering the tail case seq can't. Images kept.
function reconcileEchoedPending(turnEnded) {
  for (var j = 0; j < state.pendingSentMessages.length; j++) {
    var p = state.pendingSentMessages[j];
    if (!p.isImage && messageEchoed(p)) bumpDeliveredSeq(p.seq);
  }
  for (var i = state.pendingSentMessages.length - 1; i >= 0; i--) {
    var pending = state.pendingSentMessages[i];
    if (pending.isImage) continue; // image bubbles carry no matchable text
    var echoed = messageEchoed(pending);
    // Orphan = an unacked earlier send whose echo never comes (a later one confirmed first). Exclude delivered bubbles — those just have a lagging jsonl echo, clearing them makes them flash out.
    var orphaned = !pending.delivered && pending.seq < state.lastDeliveredSeq;
    // 3s grace: a normal idle-send's echo can lag an unrelated idle frame — don't clean too early.
    var idleStale = turnEnded && !pending.delivered && (Date.now() - (pending.sentAt || 0) > 3000);
    if (!echoed && !orphaned && !idleStale) continue;
    // idleStale + no echo/orphan = synthetic slash cmd (/status, /usage…): reached CC, replied, but writes no user echo → no jsonl bubble to dedup. Settle in place (don't remove — that's the "question vanishes" bug).
    if (idleStale && !echoed && !orphaned) {
      resolvePending(pending, true, null);
      continue;
    }
    var el = document.getElementById(pending.id);
    if (el) el.remove();
    state.pendingSentMessages.splice(i, 1);
  }
}

function markPendingTime(pending) {
  var el = document.getElementById(pending.id);
  if (!el) return;
  var status = el.querySelector('.sending-status');
  if (status) { status.innerHTML = new Date().toLocaleTimeString(); status.style.color = '#6e7681'; }
}

function markPendingFailed(pending, error) {
  var el = document.getElementById(pending.id);
  if (!el) return;
  var status = el.querySelector('.sending-status');
  if (!status) return;
  var label = error ? esc(error) : 'Not delivered';
  status.innerHTML = label + ' · <span class="send-retry" onclick="retryPendingSend(\'' + pending.id + '\')">Retry</span>';
  status.style.color = '#f85149';
}

// Timeout reconciliation: only acts if the bubble is still pending (ack/dedup
// didn't already resolve it). Pulls latest messages from DDB, then either
// self-heals (message arrived, ack/echo was just lost) or flags for retry.
async function reconcilePendingSend(msgId) {
  var pending = findPending(msgId);
  if (!pending || pending.delivered) return;               // already resolved
  if (pending.sessionId !== state.wsSessionId) return;     // user navigated away; leave it
  try { await bufferAndFetch(state.wsSessionId, state.wsLastTimestamp); } catch (e) {}
  pending = findPending(msgId);
  if (!pending || pending.delivered) return;               // ack/dedup fired during the fetch
  // Message actually landed (ack/echo just lost) → success; else flag for retry.
  resolvePending(pending, messageEchoed(pending), null);
}

// Manual retry: re-check the server first (avoid double-send if it actually
// landed), then re-send the exact original payload as a fresh pending bubble.
async function retryPendingSend(msgId) {
  var pending = findPending(msgId);
  if (!pending) return;
  try { await bufferAndFetch(state.wsSessionId, state.wsLastTimestamp); } catch (e) {}
  if (messageEchoed(pending)) { resolvePending(pending, true, null); return; }
  // Remove the failed bubble + its pending record, then re-send from scratch.
  var el = document.getElementById(pending.id);
  if (el) el.remove();
  removePending(pending);
  doSend(pending.fullText, pending.text, pending.images || []);
}

// ---- Message dedup utilities ----

/** Extract plain text from a message's content field */
function extractMsgText(msg) {
  if (!msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    var tb = msg.content.find(function (c) { return c.type === 'text'; });
    return tb ? (tb.text || '') : '';
  }
  return '';
}

/** Strip ![](…) image references from text for comparison */
function stripImageRefs(text) {
  return text.replace(/!\[.*?\]\([^)]+\)/g, '').trim();
}

/** Match a user echo to its pending bubble and promote in place. Returns true when handled (caller skips insert). */
function tryDedup(msg) {
  if (msg.type !== 'user') return false;

  // Primary: identity match — echo's streamId → clientId → the exact pending bubble (no text guessing).
  if (msg._streamId) {
    var clientId = state.streamAnchors[msg._streamId];
    var byId = clientId ? findPending(clientId) : null;
    if (byId) { promoteEchoedBubble(byId, msg); return true; }
  }

  // Fallback: no streamId (external echo) → loose text containment + slash-command rewrite match.
  var text = extractMsgText(msg).trim();
  if (!text) return false;
  var stripped = stripImageRefs(text);
  var cmdMatch = text.match(/<command-name>\/?([\w:-]+)<\/command-name>/);
  var cmdName = cmdMatch ? cmdMatch[1] : null; // e.g. "document-skills:pdf"

  for (var i = 0; i < state.pendingSentMessages.length; i++) {
    var pending = state.pendingSentMessages[i];
    var pendingText = pending.text.trim();
    var isTextMatch = !!pendingText && (
      pendingText === stripped || pendingText === text ||
      stripped.indexOf(pendingText) !== -1 || pendingText.indexOf(stripped) !== -1);
    var isCmdMatch = cmdName && pendingText.charAt(0) === '/' &&
      (('/' + cmdName) === pendingText || cmdName.split(':').pop() === pendingText.slice(1));
    if (!isTextMatch && !isCmdMatch) continue;
    promoteEchoedBubble(pending, msg);
    return true;
  }
  return false;
}

// Promote the optimistic bubble in place (never remove+re-insert): its [data-anchor] must survive so anchorForStream still finds it.
function promoteEchoedBubble(pending, msg) {
  bumpDeliveredSeq(pending.seq); // echo landed → confirms delivery
  var idx = state.pendingSentMessages.indexOf(pending);
  if (idx !== -1) state.pendingSentMessages.splice(idx, 1);
  var el = document.getElementById(pending.id);
  if (el) {
    if (msg.timestamp) el.dataset.ts = msg.timestamp;
    el.removeAttribute('data-pending');
  }
}

// Function bridges for inline HTML handlers + IIFE consumers.
// All shared state lives in state.js, not on window.
Object.assign(window, {
  updateTitleFromMessages,
  connectWs, subscribeSession, wsSend, wsSendReliable, setWsStatus, disconnectWs, ensureWsAndSend,
  startWs, bufferAndFetch, loadOlderMessages, recoverMissing,
  findInsertBefore, insertAtTimestamp, updateLastTurn,
  sendMessage, updateSendBtn, onSendBtnClick, interruptSession, doSend,
  extractMsgText, stripImageRefs, tryDedup, retryPendingSend,
});

// Test-only hooks for the jsdom stream-render harness (test/). Gated on __APEEK_TEST__
// so production never sees them. Exposes the internal stream fns + reorder-buffer state
// so tests can replay a WS event sequence through the REAL render code. See test/README.md.
if (typeof window !== 'undefined' && window.__APEEK_TEST__) {
  window.__wsTest = {
    handleWsMessage: handleWsMessage,
    pushStreamFrame: pushStreamFrame,
    handleStreamEnd: handleStreamEnd,
    clearStreamPreviews: clearStreamPreviews,
    updateLastTurn: updateLastTurn,
    rbState: function () {
      return Object.keys(_rb).map(function (k) {
        return { sid: k, blocks: _rb[k].blocks.size, nextSeq: _rb[k].nextSeq, superseded: _rb[k].supersededThrough, ended: !!_streamEnded[k] };
      });
    },
  };
}
