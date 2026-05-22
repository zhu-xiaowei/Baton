// Keyboard handling. Android: shrink body so flex matches visible area
// (prevents input-bar drag). iOS: toggle kb-up to drop redundant safe-area
// padding when keyboard covers home indicator. Both: re-pin #content to
// bottom across the keyboard animation.
import { state } from './state.js';

var _vpBaseHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
var _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
var _pendingWsSend = null; // queued message to send on WS open

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
    if (kbUp !== _wasKbUp) {
      var c = document.getElementById('content');
      if (c && state.appState.session) {
        [50, 200, 400].forEach(function (d) {
          setTimeout(function () { c.scrollTop = c.scrollHeight; }, d);
        });
      }
    }
    _wasKbUp = kbUp;
  });
}

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
    if (_pendingWsSend) {
      wsSend(_pendingWsSend);
      _pendingWsSend = null;
    }
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
      // Mark first undelivered pending message as delivered (or failed)
      if (state.pendingSentMessages.length) {
        var pending = null;
        for (var pi = 0; pi < state.pendingSentMessages.length; pi++) {
          if (!state.pendingSentMessages[pi].delivered) { pending = state.pendingSentMessages[pi]; break; }
        }
        if (pending) {
          pending.delivered = true;
          var el = document.getElementById(pending.id);
          if (el) {
            var status = el.querySelector('.sending-status');
            if (status) {
              if (msg.ok) {
                status.innerHTML = new Date().toLocaleTimeString();
                status.style.color = '#6e7681';
              } else {
                status.innerHTML = msg.error || 'Send failed';
                status.style.color = '#f85149';
              }
            }
          }
        }
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
            loadImages(container);
            clampOverflow(container);
            container.parentElement.scrollTop = container.parentElement.scrollHeight;
            updateTitleFromMessages();
          }
        }).catch(function () {});
      }
    } else if (msg.action === 'sync_complete') {
      if (msg.sessionId !== state.wsSessionId) return;
      // Re-fetch + render once. Don't call loadMessages — that resets sessionPreview/_titleTier
      // and re-triggers needSync, causing a render-loop with title flicker.
      bufferAndFetch(msg.sessionId, '').then(function () {
        if (state.wsAllMessages.length === 0) return;
        var content = document.getElementById('content');
        content.innerHTML = '<div class="messages">' + renderMessages(state.wsAllMessages) + '</div>';
        state.wsRenderedCount = state.wsAllMessages.length;
        state.wsLoadCompleteTs = state.wsLastTimestamp || '';
        updateTitleFromMessages();
        loadImages(content);
        clampOverflow(content.querySelector('.messages'));
        content.scrollTop = content.scrollHeight;
      }).catch(function () {});
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
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    wsSend(data);
  } else {
    _pendingWsSend = data;
    connectWs();
  }
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

    // User message
    if (msg.type === 'user' && !isInterruptMsg(msg)) {
      if (msg.timestamp && msg.timestamp > (state.wsLoadCompleteTs || '')) state.wsRunning = true;
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

    if (msg.timestamp && msg.timestamp > (state.wsLoadCompleteTs || '')) {
      state.wsRunning = msg.type === 'assistant' && msg.stopReason !== 'end_turn';
    }

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

  updateSendBtn();

  // New messages arrived — dismiss stale permission prompt; checkPendingPrompts will re-show if needed
  if (document.getElementById('permission-prompt')) {
    dismissPermissionPrompt();
  }
  checkPendingPrompts(state.wsAllMessages);

  if (wasNearBottom) {
    el.scrollTop = el.scrollHeight;
  }
  loadImages(container);
  clampOverflow(container);
  showStats(state.wsMessageCount + ' messages (live)');
}

function startWs(sessionId) {
  state.wsSessionId = sessionId;
  if (!state.ws) connectWs();
  else subscribeSession(sessionId);
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
    var data = await api('/api/bridge/messages', params);
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
  if (!/Mobi|Android/i.test(navigator.userAgent)) input.focus();
}

// Textarea: Enter sends, Shift+Enter newline, auto-grow, toggle send/stop button
var _stopSvg = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/></svg>';
var _sendSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
function updateSendBtn() {
  var btn = document.getElementById('send-btn');
  var hasText = document.getElementById('msg-input').value.trim().length > 0;
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
  wsSend({ action: 'interrupt', sessionId: state.wsSessionId, device: state.appState.device || '' });
  state.wsRunning = false;
  updateSendBtn();
}
(function () {
  var el = document.getElementById('msg-input');
  el.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); updateSendBtn(); }
  });
  el.addEventListener('input', function () {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
    updateSendBtn();
  });
})();

function doSend(fullText, displayText, images) {
  state.wsRunning = true;
  updateSendBtn();
  var device = state.appState.device || '';
  if (state.appState.session === '__new__' && state.wsProjectHash) {
    wsSend({ action: 'send_message', projectHash: state.wsProjectHash, requestId: state.wsRequestId, text: fullText, device: device });
  } else {
    wsSend({ action: 'send_message', sessionId: state.wsSessionId, text: fullText, device: device });
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

  var msgId = 'sent-' + Date.now();
  state.pendingSentMessages.push({ id: msgId, text: displayText, isImage: images.length > 0 });
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
  for (var i = 0; i < state.pendingSentMessages.length; i++) {
    var pendingText = state.pendingSentMessages[i].text.trim();
    if (pendingText === stripped || pendingText === text) {
      var el = document.getElementById(state.pendingSentMessages[i].id);
      if (el) el.remove(); // remove optimistic element; real one is inserted at correct ts
      state.pendingSentMessages.splice(i, 1);
      return false; // return false so caller inserts the real message
    }
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
  extractMsgText, stripImageRefs, tryDedup,
});
