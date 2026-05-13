// Baseline viewport height (no keyboard) for keyboard detection
var _vpBaseHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;

// iOS: viewport-fit=cover handles keyboard avoidance natively.
// Do NOT set body.style.height here — it breaks the flex layout when keyboard opens.

function updateTitleFromMessages() {
  for (var i = wsAllMessages.length - 1; i >= 0; i--) {
    if (wsAllMessages[i].type === 'ai-title' && wsAllMessages[i].content) {
      appState.sessionPreview = typeof wsAllMessages[i].content === 'string' ? wsAllMessages[i].content : '';
      updateBreadcrumb(); saveNav();
      return;
    }
  }
}

// WebSocket connection management
var ws = null;
var wsSessionId = null;
var wsMessageCount = 0;
var wsStatusText = '';
var wsAllMessages = []; // track all messages for tool pairing
var wsLastTimestamp = ''; // track for reconnect recovery
var _wsBuffer = null; // null = normal mode, [] = buffering during initial load
var wsProjectHash = null; // for new session creation
var wsRequestId = null; // unique ID per new-session creation flow
var wsRunning = false; // track if session is actively running
var _pendingWsSend = null; // queued message to send on WS open
var _pendingCreatePath = null; // projectPath for create_project matching

function connectWs(_, projectHash) {
  if (!WS_URL) return;
  if (projectHash) {
    wsProjectHash = projectHash;
    wsRequestId = crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  ws = new WebSocket(WS_URL + '?apiKey=' + KEY + '&role=app');

  ws.onopen = function () {
    setWsStatus('connected');
    if (wsSessionId) {
      subscribeSession(wsSessionId);
      if (wsLastTimestamp) recoverMissing();
    }
    if (_pendingWsSend) {
      wsSend(_pendingWsSend);
      _pendingWsSend = null;
    }
  };

  ws.onmessage = function (e) {
    var msg = JSON.parse(e.data);
    if (msg.action === 'messages' && msg.sessionId === wsSessionId) {
      if (_wsBuffer !== null) {
        // Buffering during initial load — collect, don't render yet
        _wsBuffer.push.apply(_wsBuffer, msg.messages);
        return;
      }
      for (var i = 0; i < msg.messages.length; i++) {
        var m = msg.messages[i];
        wsAllMessages.push(m);
        wsMessageCount++;
        if (m.timestamp) wsLastTimestamp = m.timestamp;
      }
      updateLastTurn();
      showStats(wsMessageCount + ' messages (' + msg.messages.length + ' new via WS)');
    } else if (msg.action === 'permission_request') {
      if (msg.sessionId === wsSessionId) showPermissionPrompt(msg);
    } else if (msg.action === 'send_message_result') {
      // Mark first undelivered pending message as delivered (or failed)
      if (pendingSentMessages.length) {
        var pending = null;
        for (var pi = 0; pi < pendingSentMessages.length; pi++) {
          if (!pendingSentMessages[pi].delivered) { pending = pendingSentMessages[pi]; break; }
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
      if (msg.sessionId && appState.session === '__new__' && (!msg.requestId || msg.requestId === wsRequestId)) {
        appState.session = msg.sessionId;
        appState.sessionPreview = 'New Session';
        updateBreadcrumb();
        saveNav();
        wsRequestId = null;
        subscribeSession(msg.sessionId);
        // Fetch missed messages, then replace pending bubbles with real data
        bufferAndFetch(msg.sessionId, '').then(function () {
          var container = document.querySelector('.messages');
          if (container && wsAllMessages.length) {
            container.innerHTML = renderMessages(wsAllMessages);
            wsRenderedCount = wsAllMessages.length;
            pendingSentMessages = [];
            loadImages(container);
            clampOverflow(container);
            container.parentElement.scrollTop = container.parentElement.scrollHeight;
            updateTitleFromMessages();
          }
        }).catch(function () {});
      }
    } else if (msg.action === 'sync_complete') {
      if (msg.sessionId === wsSessionId) loadMessages(msg.sessionId);
    } else if (msg.action === 'create_project_result') {
      if (_pendingCreatePath && msg.projectPath === _pendingCreatePath) {
        _pendingCreatePath = null;
        disconnectWs();
        if (msg.ok) {
          closeNewProjectModal();
          loadProjects(appState.device);
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

  ws.onclose = function () {
    setWsStatus('disconnected');
    if (appState.session) {
      setWsStatus('reconnecting');
      setTimeout(function () { if (appState.session) connectWs(); }, 3000);
    }
  };

  ws.onerror = function () {};
}

function subscribeSession(sessionId) {
  if (wsSessionId && wsSessionId !== sessionId) {
    wsSend({ action: 'unsubscribe', sessionId: wsSessionId });
  }
  wsSessionId = sessionId;
  wsSend({ action: 'subscribe', sessionId: sessionId });
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function setWsStatus(status) {
  wsStatusText = status;
  showWsBanner(status);
}

function disconnectWs() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
    wsSessionId = null;
    wsRunning = false;
    updateSpinner();
    setWsStatus('');
  }
}

function ensureWsAndSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsSend(data);
  } else {
    _pendingWsSend = data;
    connectWs();
  }
}

// Track last rendered message index
var wsRenderedCount = 0;
var wsHasMore = false; // server says there are older messages
var wsOldestTimestamp = ''; // cursor for loading older messages
var wsLoadingOlder = false; // prevent concurrent older-message fetches

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

  var newMessages = wsAllMessages.slice(wsRenderedCount);
  wsRenderedCount = wsAllMessages.length;
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
          for (var mi = 0; mi < wsAllMessages.length; mi++) {
            var am = wsAllMessages[mi];
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
          var state = window._lastToolState || '';
          node.className = 'tl-item tool-node' + (state ? ' ' + state : '');
        }
      }
      continue;
    }

    // User message
    if (msg.type === 'user' && !isInterruptMsg(msg)) {
      wsRunning = true;
      if (tryDedup(msg)) continue;
      var userHtml = renderUserBubble(msg);
      if (userHtml) insertAtTimestamp(container, userHtml, msg.timestamp);
      continue;
    }

    // ai-title
    if (msg.type === 'ai-title') {
      updateTitleFromMessages();
      continue;
    }

    // Assistant message
    if (msg.type !== 'assistant' && !isInterruptMsg(msg)) continue;

    wsRunning = msg.type === 'assistant' && msg.stopReason !== 'end_turn';

    var html = renderSingleMessage(msg, wsAllMessages);
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
    _toolApproveMode = 'auto';
  }
  checkPendingPrompts(wsAllMessages);

  if (wasNearBottom) {
    el.scrollTop = el.scrollHeight;
  }
  loadImages(container);
  clampOverflow(container);
  showStats(wsMessageCount + ' messages (live)');
}

function startWs(sessionId) {
  wsSessionId = sessionId;
  if (!ws) connectWs();
  else subscribeSession(sessionId);
}

/**
 * Buffer WS → fetch DDB → merge + dedup → return merged messages.
 * Used by both initial load (after='') and reconnect recovery (after=wsLastTimestamp).
 */
async function bufferAndFetch(sessionId, after) {
  _wsBuffer = [];
  try {
    var params = { session: sessionId };
    if (after) params.after = after;
    var data = await api('/api/bridge/messages', params);
    var all = (data.messages || []).concat(_wsBuffer || []);
    _wsBuffer = null;
    // Dedup against existing wsAllMessages
    var existing = {};
    for (var i = 0; i < wsAllMessages.length; i++) existing[wsAllMessages[i].uuid] = 1;
    var added = 0;
    for (var i = 0; i < all.length; i++) {
      if (!existing[all[i].uuid]) {
        wsAllMessages.push(all[i]);
        wsMessageCount++;
        added++;
      }
    }
    if (added > 0) {
      wsAllMessages.sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? -1 : (a.timestamp || '') > (b.timestamp || '') ? 1 : 0; });
    }
    wsLastTimestamp = wsAllMessages.length ? wsAllMessages[wsAllMessages.length - 1].timestamp || '' : '';
    // Save pagination state from initial load
    if (!after && data.hasMore !== undefined) {
      wsHasMore = data.hasMore;
      wsOldestTimestamp = data.oldestTimestamp || '';
    }
    return { added: added, needSync: data.needSync };
  } catch (e) { _wsBuffer = null; throw e; }
}

/**
 * Load older messages (triggered by scroll-to-top).
 * Prepends to wsAllMessages and returns the loaded messages for DOM prepend.
 */
async function loadOlderMessages(sessionId) {
  if (wsLoadingOlder || !wsHasMore || !wsOldestTimestamp) return null;
  wsLoadingOlder = true;
  try {
    var data = await api('/api/bridge/messages', { session: sessionId, before: wsOldestTimestamp });
    var msgs = data.messages || [];
    wsHasMore = data.hasMore;
    wsOldestTimestamp = data.oldestTimestamp || '';
    // Dedup and prepend
    var existing = {};
    for (var i = 0; i < wsAllMessages.length; i++) existing[wsAllMessages[i].uuid] = 1;
    var newMsgs = [];
    for (var i = 0; i < msgs.length; i++) {
      if (!existing[msgs[i].uuid]) {
        newMsgs.push(msgs[i]);
        wsMessageCount++;
      }
    }
    if (newMsgs.length) {
      wsAllMessages = newMsgs.concat(wsAllMessages);
      wsRenderedCount += newMsgs.length;
    }
    return newMsgs;
  } finally {
    wsLoadingOlder = false;
  }
}

// Reconnect recovery
async function recoverMissing() {
  try {
    var result = await bufferAndFetch(wsSessionId, wsLastTimestamp);
    if (!result.added) return;
    var container = document.querySelector('.messages');
    if (container) {
      container.innerHTML = renderMessages(wsAllMessages);
      wsRenderedCount = wsAllMessages.length;
      loadImages(container);
      clampOverflow(container);
      checkPendingPrompts(wsAllMessages);
      container.parentElement.scrollTop = container.parentElement.scrollHeight;
    }
    showStats(wsMessageCount + ' messages (' + result.added + ' recovered)');
  } catch (e) {}
}

// Track pending (optimistically rendered) messages for dedup
var pendingSentMessages = [];

function sendMessage() {
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var images = stagedImages.slice();

  if (!text && !images.length) return;
  if (!text && images.length) text = 'Please review the attached image';
  // Allow sending without wsSessionId for new sessions (projectHash is used)
  if (!wsSessionId && appState.session !== '__new__') return;

  // Images already uploaded — just assemble refs
  var readyImages = images.filter(function (img) { return img.uploaded && img.key; });
  if (readyImages.length) {
    var refs = readyImages.map(function (img) { return '![](claude-bridge:' + img.key + ')'; }).join('\n');
    doSend(text + '\n' + refs, text, readyImages);
  } else {
    doSend(text, text, []);
  }

  stagedImages = [];
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
  } else if (wsRunning) {
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

  if (input.value.trim()) {
    sendMessage();
    updateSendBtn();
    // Keep keyboard open on mobile after sending
    if (isMobile && kbWasUp) input.focus();
  } else if (wsRunning) {
    interruptSession();
  }

  if (isMobile && !kbWasUp) input.blur();
}
function interruptSession() {
  if (!wsSessionId) return;
  wsSend({ action: 'interrupt', sessionId: wsSessionId, device: appState.device || '' });
  wsRunning = false;
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
  wsRunning = true;
  updateSendBtn();
  var device = appState.device || '';
  if (appState.session === '__new__' && wsProjectHash) {
    wsSend({ action: 'send_message', projectHash: wsProjectHash, requestId: wsRequestId, text: fullText, device: device });
  } else {
    wsSend({ action: 'send_message', sessionId: wsSessionId, text: fullText, device: device });
  }

  // Remove placeholder text
  var empty = document.querySelector('.empty');
  if (empty) empty.remove();

  var msgId = 'sent-' + Date.now();
  pendingSentMessages.push({ id: msgId, text: displayText, isImage: images.length > 0 });
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
  for (var i = 0; i < pendingSentMessages.length; i++) {
    var pendingText = pendingSentMessages[i].text.trim();
    if (pendingText === stripped || pendingText === text) {
      var el = document.getElementById(pendingSentMessages[i].id);
      if (el) el.remove(); // remove optimistic element; real one is inserted at correct ts
      pendingSentMessages.splice(i, 1);
      return false; // return false so caller inserts the real message
    }
  }
  return false;
}
