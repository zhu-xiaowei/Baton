// Keyboard handling. Android: shrink body so flex matches visible area
// (prevents input-bar drag). iOS: toggle kb-up to drop redundant safe-area
// padding when keyboard covers home indicator. Both: re-pin #content to
// bottom across the keyboard animation.
import { state } from './state.js';

var _vpBaseHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
var _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
var _wsSendQueue = []; // payloads queued while socket not OPEN, flushed in order on connect

if (window.visualViewport) {
  var _wasKbUp = false;
  window.visualViewport.addEventListener('resize', function () {
    var vv = window.visualViewport;
    var kbUp = vv.height < _vpBaseHeight * 0.75;
    if (!_isIOS) {
      document.body.style.bottom = 'auto';
      document.body.style.height = vv.height + 'px';
    } else {
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
  });
}

// iOS foreground: force reconnect (resumed socket may be a dead zombie). See CLAUDE.md.
function handleForegroundResume() {
  if (document.visibilityState !== 'visible') return;
  if (!state.appState.session || state.appState.session === '__new__') return;
  if (!state.WS_URL) return;
  if (state.ws && state.ws.readyState === WebSocket.CONNECTING) return;
  connectWs();
}
document.addEventListener('visibilitychange', handleForegroundResume);
window.addEventListener('pageshow', handleForegroundResume);
window.addEventListener('focus', handleForegroundResume);

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

// Skeleton → empty state + stop spinner, when a synced session has no real messages.
function showEmptyMessages() {
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

  state.ws.onmessage = function (e) {
    var msg = JSON.parse(e.data);
    if (msg.action === 'messages' && msg.sessionId === state.wsSessionId) {
      if (state._wsBuffer !== null) {
        // Buffering during initial load — collect, don't render yet
        state._wsBuffer.push.apply(state._wsBuffer, msg.messages);
        return;
      }
      for (var i = 0; i < msg.messages.length; i++) {
        var m = msg.messages[i];
        if (m.uuid && state.wsAllMessages.some(function (x) { return x.uuid === m.uuid; })) continue;
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
      // New session: bridge created tmux + CC, returned sessionId
      if (msg.sessionId && state.appState.session === '__new__' && (!msg.requestId || msg.requestId === state.wsRequestId)) {
        state.appState.session = msg.sessionId;
        state.appState.sessionPreview = 'New Session';
        updateBreadcrumb();
        saveNav();
        state.wsRequestId = null;
        subscribeSession(msg.sessionId);
        // Fetch missed messages, then replace pending bubbles with real data
        bufferAndFetch(msg.sessionId, '').then(function () {
          var container = document.querySelector('.messages');
          if (container && state.wsAllMessages.length) {
            container.innerHTML = renderMessages(state.wsAllMessages);
            state.wsRenderedCount = state.wsAllMessages.length;
            state.pendingSentMessages = [];
            state.lastDeliveredSeq = -1;
            loadImages(container);
            clampOverflow(container);
            container.parentElement.scrollTop = container.parentElement.scrollHeight;
            updateTitleFromMessages();
          }
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
        content.scrollTop = content.scrollHeight;
      }).catch(function () {});
    } else if (msg.action === 'file_ready') {
      if (window.handleFileReady) window.handleFileReady(msg);
    } else if (msg.action === 'file_progress') {
      if (window.handleFileProgress) window.handleFileProgress(msg);
    } else if (msg.action === 'commands_list') {
      if (window.handleCommandsList) window.handleCommandsList(msg);
    } else if (msg.action === 'command_output') {
      if (msg.sessionId === state.wsSessionId && window.appendCommandOutput) {
        state.wsRunning = false; // local command done; stop the spinner
        window.appendCommandOutput(msg.ansi);
      }
    } else if (msg.action === 'create_project_result') {
      if (state._pendingCreatePath && msg.projectPath === state._pendingCreatePath) {
        state._pendingCreatePath = null;
        disconnectWs();
        if (msg.ok) {
          closeNewProjectModal();
          loadProjects(state.appState.device);
        } else {
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
  };

  state.ws.onclose = function () {
    setWsStatus('disconnected');
    if (state.appState.session) {
      setWsStatus('reconnecting');
      setTimeout(function () { if (state.appState.session) connectWs(); }, 3000);
    }
  };

  state.ws.onerror = function () {};
}

function subscribeSession(sessionId) {
  if (state.wsSessionId && state.wsSessionId !== sessionId) {
    wsSend({ action: 'unsubscribe', sessionId: state.wsSessionId });
  }
  state.wsSessionId = sessionId;
  wsSend({ action: 'subscribe', sessionId: sessionId });
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

function updateLastTurn() {
  var container = document.querySelector('.messages');
  if (!container) return;

  var newMessages = state.wsAllMessages.slice(state.wsRenderedCount);
  state.wsRenderedCount = state.wsAllMessages.length;
  if (!newMessages.length) return;

  var el = document.getElementById('content');
  var wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 300;

  // Sort batch by timestamp
  if (newMessages.length > 1) {
    newMessages.sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? -1 : (a.timestamp || '') > (b.timestamp || '') ? 1 : 0; });
  }

  for (var i = 0; i < newMessages.length; i++) {
    var msg = newMessages[i];
    // tool_result → update matching tool_use node
    if (isToolResultOnly(msg)) {
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
      if (tryDedup(msg)) continue;
      var userHtml = renderUserBubble(msg);
      if (userHtml) insertAtTimestamp(container, userHtml, msg.timestamp);
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

    // Scan all elements with data-ts to find insertion position
    var allItems = container.querySelectorAll('[data-ts]');
    var target = null;
    for (var j = allItems.length - 1; j >= 0; j--) {
      if (allItems[j].dataset.ts > msg.timestamp) {
        target = allItems[j];
      } else {
        break;
      }
    }

    if (target) {
      // Insert before target, inside its parent turn
      target.insertAdjacentHTML('beforebegin', html);
    } else {
      // Latest message — append to last turn or create new one
      var firstPending = container.querySelector('[data-pending]');
      var lastReal = firstPending ? firstPending.previousElementSibling : container.lastElementChild;
      if (lastReal && lastReal.classList.contains('assistant-turn')) {
        lastReal.insertAdjacentHTML('beforeend', html);
        if (msg.timestamp) lastReal.dataset.ts = msg.timestamp;
        continue;
      }
      var turnHtml = '<div class="assistant-turn" data-ts="' + (msg.timestamp || '') + '">' + html + '</div>';
      if (firstPending) firstPending.insertAdjacentHTML('beforebegin', turnHtml);
      else container.insertAdjacentHTML('beforeend', turnHtml);
    }
  }

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
  if (derived || hasTurnFrame) state.wsRunning = derived;
  updateSendBtn();

  // New messages arrived — dismiss stale permission prompt; checkPendingPrompts will re-show if needed
  if (document.getElementById('permission-prompt')) {
    dismissPermissionPrompt();
  }
  checkPendingPrompts(state.wsAllMessages);
  if (typeof maybeRevealStuckAgent === 'function') maybeRevealStuckAgent(state.wsSessionId);

  reconcileEchoedPending();

  // Clamp before scrolling so scrollTop uses the collapsed final height.
  loadImages(container);
  clampOverflow(container);
  if (wasNearBottom) {
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
      container.innerHTML = renderMessages(state.wsAllMessages);
      state.wsRenderedCount = state.wsAllMessages.length;
      state.wsRunning = deriveRunning(state.wsAllMessages);
      updateSendBtn();
      loadImages(container);
      clampOverflow(container);
      checkPendingPrompts(state.wsAllMessages);
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
  if (hasText) {
    btn.innerHTML = _sendSvg;
    btn.className = 'has-text';
    btn.disabled = false;
  } else if (state.wsRunning) {
    btn.innerHTML = _stopSvg;
    btn.className = 'is-stop';
    btn.disabled = false;
  } else {
    btn.innerHTML = _sendSvg;
    btn.className = '';
    btn.disabled = true;
  }
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
    wsSendReliable({ action: 'send_message', sessionId: state.wsSessionId, clientId: msgId, text: fullText, device: device });
  }

  // Remove placeholder text
  var empty = document.querySelector('.empty');
  if (empty) empty.remove();

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
  state.pendingSentMessages.push({ id: msgId, seq: seq, text: displayText, fullText: fullText, images: images, isImage: images.length > 0, sessionId: state.wsSessionId });
  var container = document.querySelector('.messages');
  if (container) {
    var imgHtml = images.map(function (img) {
      return '<div class="img-placeholder loaded"><img src="' + img.dataUrl + '" onclick="viewImage(this.src)" /></div>';
    }).join('');
    var attachHtml = imgHtml ? '<div class="msg-attachments">' + imgHtml + '</div>' : '';
    container.insertAdjacentHTML('beforeend',
      '<div class="msg-user" id="' + msgId + '" data-pending="1">' + attachHtml
      + '<div class="msg-text" onclick="toggleExpand(this)">' + esc(displayText) + '</div>'
      + '<div class="msg-meta"><span class="msg-time sending-status">sending...</span></div></div>');
    clampOverflow(container);
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
// rewrite slash commands, tmux may normalize newlines), so accept containment
// rather than strict equality. Compares against stripped text (no image refs).
function messageEchoed(pending) {
  var needle = stripImageRefs((pending.text || '').trim());
  if (!needle) return false;
  for (var i = 0; i < state.wsAllMessages.length; i++) {
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

// Retire orphaned optimistic bubbles. Two rules: (1) drop any pending whose echo is
// present (tryDedup missed it — e.g. echo arrived via bufferAndFetch); (2) drop any
// pending sent BEFORE a confirmed-delivered one (seq < watermark) that still has no
// echo — CC processes FIFO, so an earlier message a later one overtook was skipped
// (busy-send swallowed it, never reached jsonl, echo never comes). Images kept.
function reconcileEchoedPending() {
  for (var j = 0; j < state.pendingSentMessages.length; j++) {
    var p = state.pendingSentMessages[j];
    if (!p.isImage && messageEchoed(p)) bumpDeliveredSeq(p.seq);
  }
  for (var i = state.pendingSentMessages.length - 1; i >= 0; i--) {
    var pending = state.pendingSentMessages[i];
    if (pending.isImage) continue; // image bubbles carry no matchable text
    var echoed = messageEchoed(pending);
    var orphaned = pending.seq < state.lastDeliveredSeq; // a later send was confirmed first
    if (!echoed && !orphaned) continue;
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

/** Match incoming user message against pending. Remove pending DOM element; real message is inserted by timestamp. */
function tryDedup(msg) {
  if (msg.type !== 'user') return false;
  var text = extractMsgText(msg).trim();
  if (!text) return false;

  var stripped = stripImageRefs(text);
  // CC rewrites a sent "/pdf" into "<command-name>/document-skills:pdf</command-name>".
  // Extract the command name so it matches the optimistic "/pdf" we already show.
  var cmdMatch = text.match(/<command-name>\/?([\w:-]+)<\/command-name>/);
  var cmdName = cmdMatch ? cmdMatch[1] : null; // e.g. "document-skills:pdf"

  for (var i = 0; i < state.pendingSentMessages.length; i++) {
    var pending = state.pendingSentMessages[i];
    var pendingText = pending.text.trim();
    // Loose match (containment either way), matching reconcile's messageEchoed:
    // tmux newline normalization or CC rewrites can make the echo differ from
    // what we typed by a few chars, and strict equality there is exactly what
    // orphaned the optimistic bubble (→ stuck "sending..." + a duplicate).
    var isTextMatch = !!pendingText && (
      pendingText === stripped || pendingText === text ||
      stripped.indexOf(pendingText) !== -1 || pendingText.indexOf(stripped) !== -1);
    // Command match: pending "/pdf" vs CC's "/document-skills:pdf" (share the
    // bare name after the optional plugin namespace).
    var isCmdMatch = cmdName && pendingText.charAt(0) === '/' &&
      (('/' + cmdName) === pendingText || cmdName.split(':').pop() === pendingText.slice(1));
    if (!isTextMatch && !isCmdMatch) continue;
    bumpDeliveredSeq(pending.seq); // this send's echo just landed → confirms delivery
    state.pendingSentMessages.splice(i, 1);
    var el = document.getElementById(pending.id);
    if (isCmdMatch && !isTextMatch) {
      // Keep our "/pdf" bubble (drop CC's namespaced dup), but promote it to a
      // real timestamped anchor so the assistant reply sorts below it, not above.
      // (Time text is set separately by the send_message_result handler.)
      if (el && msg.timestamp) {
        el.dataset.ts = msg.timestamp;
        el.removeAttribute('data-pending');
      }
      return true;
    }
    if (el) el.remove(); // remove optimistic element; real one is inserted at correct ts
    return false; // caller inserts the real message
  }
  return false;
}

// Function bridges for inline HTML handlers + IIFE consumers.
// All shared state lives in state.js, not on window.
Object.assign(window, {
  updateTitleFromMessages,
  connectWs, subscribeSession, wsSend, setWsStatus, disconnectWs, ensureWsAndSend,
  startWs, bufferAndFetch, loadOlderMessages, recoverMissing,
  findInsertBefore, insertAtTimestamp, updateLastTurn,
  sendMessage, updateSendBtn, onSendBtnClick, interruptSession, doSend,
  extractMsgText, stripImageRefs, tryDedup, retryPendingSend,
});
