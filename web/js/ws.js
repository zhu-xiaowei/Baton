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
  var el = document.getElementById('stats');
  if (el.style.display !== 'none') {
    var span = el.querySelector('span');
    showStats(span ? span.textContent : '');
  }
}

function disconnectWs() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
    wsSessionId = null;
    wsRunning = false;
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
      if (tryDedup(msg)) continue;
      var userHtml = renderUserBubble(msg);
      if (userHtml) insertAtTimestamp(container, userHtml, msg.timestamp);
      continue;
    }

    // ai-title
    if (msg.type === 'ai-title') {
      var title = typeof msg.content === 'string' ? msg.content : '';
      if (title) { appState.sessionPreview = title; updateBreadcrumb(); saveNav(); }
      continue;
    }

    // Assistant message
    if (msg.type !== 'assistant' && !isInterruptMsg(msg)) continue;

    wsRunning = msg.type === 'assistant' && msg.stopReason !== 'end_turn';
    updateSendBtn();

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

  // Prompt check: per-tool_use detection, no global mode cache
  checkPendingPrompts(wsAllMessages);

  if (wasNearBottom) {
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setTimeout(function () { el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, 150);
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
    return { added: added, needSync: data.needSync };
  } catch (e) { _wsBuffer = null; throw e; }
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
  if (!text && images.length) text = '请查看这张图片';
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
}
function onSendBtnClick() {
  if (document.getElementById('msg-input').value.trim()) {
    sendMessage();
    updateSendBtn();
  } else if (wsRunning) {
    interruptSession();
  }
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

// ---- Permission Prompt ----

function showPermissionPrompt(msg) {
  // Remove any existing prompt
  dismissPermissionPrompt();

  // Disable bottom input bar while prompt is active
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = true;
    inputBar.querySelectorAll('.input-row button').forEach(function(b) { b.disabled = true; });
    inputBar.querySelector('#msg-input').placeholder = 'Please respond to the prompt above...';
  }

  var container = document.querySelector('.messages');
  if (!container) return;

  var html = '<div class="permission-prompt" id="permission-prompt">';
  html += '<div class="permission-header"><div class="permission-title">' + esc(msg.title || 'Confirm?') + '</div>'
    + '<button class="permission-close" onclick="cancelPermissionPrompt()" title="Cancel (Esc)">&times;</button></div>';
  if (msg.description) {
    html += '<pre class="permission-desc">' + esc(msg.description) + '</pre>';
  }
  html += '<div class="permission-options">';
  var options = msg.options || [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }];
  for (var i = 0; i < options.length; i++) {
    var opt = options[i];
    var btnClass = opt.value === 'n' || opt.value === 'no' ? 'permission-btn deny' : 'permission-btn allow';
    html += '<button class="' + btnClass + '" data-value="' + esc(opt.value) + '" '
      + 'data-has-input="' + (opt.hasInput ? '1' : '0') + '" '
      + 'onclick="handlePermissionOption(this)">'
      + (opt.key ? '<span class="permission-key">' + esc(opt.key) + '</span> ' : '')
      + '<span class="permission-label">' + esc(opt.label) + '</span>'
      + (opt.description ? '<span class="permission-desc-inline">' + esc(opt.description) + '</span>' : '')
      + '</button>';
    if (opt.hasInput) {
      html += '<div class="permission-input-wrap" id="perm-input-' + i + '" style="display:none">'
        + '<input class="permission-input" placeholder="' + esc(opt.placeholder || '') + '" '
        + 'onkeydown="if(event.key===\'Enter\')submitPermissionWithInput(this,\'' + esc(opt.value) + '\')" />'
        + '<button class="permission-submit" onclick="submitPermissionWithInput(this.previousElementSibling,\'' + esc(opt.value) + '\')">Send</button>'
        + '</div>';
    }
  }
  html += '</div></div>';

  container.insertAdjacentHTML('beforeend', html);
  var el = document.getElementById('content');
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

function handlePermissionOption(btn) {
  var value = btn.getAttribute('data-value');
  var hasInput = btn.getAttribute('data-has-input') === '1';

  if (hasInput) {
    // Toggle input field
    var wrap = btn.nextElementSibling;
    if (wrap && wrap.classList.contains('permission-input-wrap')) {
      var visible = wrap.style.display !== 'none';
      wrap.style.display = visible ? 'none' : 'flex';
      if (!visible) wrap.querySelector('input').focus();
      return;
    }
  }

  // Direct action — send value as keystroke
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, device: appState.device || '', approved: value });
  dismissPermissionPrompt();
}

function submitPermissionWithInput(input, value) {
  var text = input.value.trim();
  if (!text) return; // require input
  // Send as type:N:text — bridge navigates to option, types text, Enter
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, device: appState.device || '', approved: value + ':' + text });
  dismissPermissionPrompt();
}

function cancelPermissionPrompt() {
  // Send Escape to Claude Code
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, device: appState.device || '', approved: 'escape' });
  dismissPermissionPrompt();
}

function dismissPermissionPrompt() {
  if (_pendingToolTimer) { clearTimeout(_pendingToolTimer); _pendingToolTimer = null; }
  _pendingToolUseId = null;
  var el = document.getElementById('permission-prompt');
  if (el) el.remove();
  // Re-enable bottom input bar
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = false;
    inputBar.querySelectorAll('.input-row button').forEach(function(b) { b.disabled = false; });
    inputBar.querySelector('#msg-input').placeholder = 'Send a message...';
  }
}

// ---- Client-side prompt detection ----

/** Build prompt info from a tool_use block. Returns null if not a user-facing prompt. */
function buildClientPrompt(toolName, toolInput) {
  if (toolName === 'AskUserQuestion') {
    var q = (toolInput.questions && toolInput.questions[0]) || toolInput;
    var question = q.question || q.text || '';
    var header = q.header || '';
    var rawOptions = q.options || [];
    var options = rawOptions.map(function (opt, i) {
      return {
        label: opt.label,
        description: opt.description || '',
        value: 'arrow:' + i,
        key: String(i + 1)
      };
    });
    // "Type something" — navigate to the option after the last real option, then type
    var typeIdx = rawOptions.length; // Claude Code adds "Type something" right after options
    options.push({
      label: 'Type something...',
      value: 'type:' + typeIdx,
      key: String(rawOptions.length + 1),
      hasInput: true,
      placeholder: 'Type your response...'
    });
    return {
      type: 'ask_user',
      title: header ? '[' + header + '] ' + question : question,
      options: options
    };
  }
  if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') {
    return {
      type: 'plan_approval',
      title: 'Accept this plan?',
      options: [
        { label: 'Yes, and auto-accept', value: 'arrow:0', key: '1' },
        { label: 'Yes, and manually approve edits', value: 'arrow:1', key: '2' },
        { label: 'No, keep planning', value: 'type:2', key: '3', hasInput: true, placeholder: 'Tell Claude what to do instead...' }
      ]
    };
  }
  // Bash / shell commands
  if (toolName === 'Bash' || toolName === 'bash') {
    var cmd = toolInput.command || toolInput.cmd || JSON.stringify(toolInput);
    return {
      type: 'tool_permission',
      title: 'Run command?',
      description: cmd,
      options: [
        { label: 'Yes', value: 'arrow:0', key: '1' },
        { label: 'Yes, always', value: 'arrow:1', key: '2' },
        { label: 'No', value: 'arrow:2', key: '3' }
      ]
    };
  }
  // File operations
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    var fp = toolInput.file_path || toolInput.path || '';
    return {
      type: 'tool_permission',
      title: toolName + ': ' + fp,
      description: toolName === 'Write' ? 'Create/overwrite file' : 'Edit file',
      options: [
        { label: 'Yes', value: 'arrow:0', key: '1' },
        { label: 'Yes, allow all edits', value: 'arrow:1', key: '2' },
        { label: 'No', value: 'arrow:2', key: '3' }
      ]
    };
  }
  // Not a user-facing prompt tool
  return null;
}

// Tool approval mode detection: in-memory only, reset on page refresh
// null = not yet detected, 'auto' = auto-approved, 'manual' = needs confirmation
var _toolApproveMode = null;
var _pendingToolUseId = null;
var _pendingToolTimer = null;
var TOOL_PROMPT_DELAY = 5000; // 5s — first-time detection wait

/** Check if the last message has an unresolved tool_use that needs user approval. */
function checkPendingPrompts(messages) {
  if (!messages.length) return;
  var last = messages[messages.length - 1];
  if (last.type !== 'assistant' || !Array.isArray(last.content)) return;

  // Find the last tool_use in the last assistant message
  var toolUse = null;
  for (var i = last.content.length - 1; i >= 0; i--) {
    if (last.content[i].type === 'tool_use') { toolUse = last.content[i]; break; }
  }
  if (!toolUse) return;

  // Check if tool_result already arrived
  var hasResult = messages.some(function (m) {
    return Array.isArray(m.content) && m.content.some(function (c) {
      return c.type === 'tool_result' && c.tool_use_id === toolUse.id;
    });
  });
  if (hasResult) {
    // tool_result arrived → dismiss any visible prompt
    if (_pendingToolTimer) { clearTimeout(_pendingToolTimer); _pendingToolTimer = null; }
    _pendingToolUseId = null;
    dismissPermissionPrompt();
    if (!_toolApproveMode) _toolApproveMode = 'auto';
    return;
  }

  var prompt = buildClientPrompt(toolUse.name, toolUse.input);
  if (!prompt) return;

  // AskUserQuestion / ExitPlanMode → always show immediately
  if (prompt.type === 'ask_user' || prompt.type === 'plan_approval') {
    if (_pendingToolTimer) { clearTimeout(_pendingToolTimer); _pendingToolTimer = null; }
    _pendingToolUseId = null;
    showPermissionPrompt(prompt);
    return;
  }

  // Bash/Edit/Write — mode already detected → instant decision
  if (_toolApproveMode === 'auto') return;
  if (_toolApproveMode === 'manual') {
    showPermissionPrompt(prompt);
    return;
  }

  // First time: wait 5s for tool_result to detect mode
  if (_pendingToolUseId === toolUse.id) return; // already waiting on this one
  if (_pendingToolTimer) { clearTimeout(_pendingToolTimer); _pendingToolTimer = null; }
  _pendingToolUseId = toolUse.id;
  _pendingToolTimer = setTimeout(function () {
    _pendingToolTimer = null;
    // Re-check: tool_result might have arrived during the wait
    var resolved = wsAllMessages.some(function (m) {
      return Array.isArray(m.content) && m.content.some(function (c) {
        return c.type === 'tool_result' && c.tool_use_id === _pendingToolUseId;
      });
    });
    if (resolved) {
      _toolApproveMode = 'auto';
    } else {
      _toolApproveMode = 'manual';
      showPermissionPrompt(prompt);
    }
    _pendingToolUseId = null;
  }, TOOL_PROMPT_DELAY);
}

// ---- Image Staging & Sending ----

var stagedImages = []; // { dataUrl, key, uploaded }

function onImagePicked(input) {
  if (!input.files) return;
  for (var i = 0; i < input.files.length; i++) stageImageFile(input.files[i]);
  input.value = '';
}

function onInputPaste(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  var hasImage = false;
  for (var i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image/') === 0) {
      hasImage = true;
      stageImageFile(items[i].getAsFile());
    }
  }
  if (hasImage) e.preventDefault();
}

function stageImageFile(file) {
  if (!file) return;
  var entry = { dataUrl: '', key: '', uploaded: false };
  stagedImages.push(entry);
  renderStagedImages();

  var reader = new FileReader();
  reader.onload = function () {
    var img = new Image();
    img.onload = function () {
      // Compress
      var scale = Math.min(1, 720 / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      var base64 = dataUrl.split(',')[1];
      var raw = atob(base64);
      var hashStr = raw.slice(0, 8192) + String(raw.length);
      var h = 0;
      for (var hi = 0; hi < hashStr.length; hi++) { h = ((h << 5) - h + hashStr.charCodeAt(hi)) | 0; }
      var key = Math.abs(h).toString(16).padStart(8, '0') + raw.length.toString(16) + '.jpg';

      entry.dataUrl = dataUrl;
      entry.key = key;
      renderStagedImages();

      // Upload immediately
      fetch(SERVER + '/api/bridge/upload-image', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, data: base64 })
      }).then(function (res) {
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
      }).then(function () {
        entry.uploaded = true;
        renderStagedImages();
      }).catch(function () {
        // Remove failed entry
        var fi = stagedImages.indexOf(entry);
        if (fi >= 0) stagedImages.splice(fi, 1);
        renderStagedImages();
      });
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function renderStagedImages() {
  var row = document.getElementById('img-preview-row');
  if (!stagedImages.length) { row.style.display = 'none'; row.innerHTML = ''; return; }
  row.style.display = 'flex';
  row.innerHTML = stagedImages.map(function (img, i) {
    var overlay = img.uploaded ? '' : '<div class="img-upload-overlay"><svg class="img-spinner" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="3"/><circle cx="18" cy="18" r="16" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="100" stroke-dashoffset="' + (img.dataUrl ? '25' : '90') + '" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1s" repeatCount="indefinite"/></circle></svg></div>';
    var src = img.dataUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    return '<div class="img-thumb" onclick="viewStagedImage(' + i + ')">'
      + '<img src="' + src + '">' + overlay
      + '<button class="img-remove" onclick="event.stopPropagation();removeStagedImage(' + i + ')">&times;</button></div>';
  }).join('');
}

function removeStagedImage(i) {
  stagedImages.splice(i, 1);
  renderStagedImages();
}

var galleryIndex = 0;
function viewStagedImage(i) {
  galleryIndex = i;
  showGallery();
}

function showGallery() {
  var img = stagedImages[galleryIndex];
  if (!img || !img.dataUrl) return;
  var overlay = document.getElementById('imgOverlay');
  var overlayImg = document.getElementById('imgOverlayImg');
  overlayImg.src = img.dataUrl;
  overlay.style.display = 'flex';
  overlay.onclick = null;
  // Build nav buttons if multiple
  var nav = overlay.querySelector('.gallery-nav');
  if (nav) nav.remove();
  if (stagedImages.length > 1) {
    var navHtml = '<div class="gallery-nav">'
      + '<button onclick="event.stopPropagation();galleryPrev()"' + (galleryIndex <= 0 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>'
      + '<span>' + (galleryIndex + 1) + ' / ' + stagedImages.length + '</span>'
      + '<button onclick="event.stopPropagation();galleryNext()"' + (galleryIndex >= stagedImages.length - 1 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg></button>'
      + '</div>';
    overlay.insertAdjacentHTML('beforeend', navHtml);
  }
  overlay.onclick = function (e) { if (e.target === overlay) { overlay.style.display = 'none'; } };
}

function galleryPrev() { if (galleryIndex > 0) { galleryIndex--; showGallery(); } }
function galleryNext() { if (galleryIndex < stagedImages.length - 1) { galleryIndex++; showGallery(); } }

document.addEventListener('keydown', function (e) {
  var overlay = document.getElementById('imgOverlay');
  if (!overlay || overlay.style.display !== 'flex') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); galleryPrev(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); galleryNext(); }
  else if (e.key === 'Escape') overlay.style.display = 'none';
});

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
