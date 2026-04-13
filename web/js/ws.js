// WebSocket connection management
var ws = null;
var wsSessionId = null;
var wsMessageCount = 0;
var wsStatusText = '';
var wsAllMessages = []; // track all messages for tool pairing
var wsLastTimestamp = ''; // track for reconnect recovery
var _wsBuffer = null; // null = normal mode, [] = buffering during initial load
var wsProjectHash = null; // for new session creation
var wsRunning = false; // track if session is actively running

function connectWs(_, projectHash) {
  if (!WS_URL) return;
  if (projectHash) wsProjectHash = projectHash;
  if (ws) { ws.close(); ws = null; }
  ws = new WebSocket(WS_URL + '?apiKey=' + KEY + '&role=app');

  ws.onopen = function () {
    setWsStatus('connected');
    if (wsSessionId) {
      subscribeSession(wsSessionId);
      if (wsLastTimestamp) recoverMissing();
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
        wsAllMessages.push(msg.messages[i]);
        wsMessageCount++;
        if (msg.messages[i].timestamp) wsLastTimestamp = msg.messages[i].timestamp;
      }
      updateLastTurn();
      showStats(wsMessageCount + ' messages (' + msg.messages.length + ' new via WS)');
    } else if (msg.action === 'permission_request') {
      if (msg.sessionId === wsSessionId) showPermissionPrompt(msg);
    } else if (msg.action === 'send_message_result') {
      // Mark pending messages as delivered (but keep in list for tryDedup)
      if (msg.ok && pendingSentMessages.length) {
        var pending = pendingSentMessages[0];
        var el = document.getElementById(pending.id);
        if (el) {
          var status = el.querySelector('.sending-status');
          if (status) {
            var ts = new Date().toLocaleTimeString();
            status.innerHTML = '<span style="color:#3fb950">&#10003;</span> ' + ts;
            setTimeout(function () { status.innerHTML = ts; status.style.color = '#6e7681'; }, 2000);
          }
        }
      }
      // New session: bridge created tmux + CC, returned sessionId
      if (msg.sessionId && appState.session === '__new__') {
        appState.session = msg.sessionId;
        appState.sessionPreview = 'New Session';
        updateBreadcrumb();
        saveNav();
        wsSessionId = msg.sessionId;
        subscribeSession(msg.sessionId);
      }
    } else if (msg.action === 'sync_complete') {
      if (msg.sessionId === wsSessionId) loadMessages(msg.sessionId);
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

// Track last rendered message index to only append new ones
var wsRenderedCount = 0;

/** Sort new messages by timestamp within the same batch. */
function reorderIfNeeded(newMessages) {
  if (newMessages.length > 1) {
    newMessages.sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? -1 : 1; });
  }
  return newMessages;
}

/** Find the first child element with data-ts > timestamp. Returns null if none (append to end). */
function findInsertBefore(container, timestamp) {
  if (!timestamp) return null;
  var kids = container.children;
  var result = null;
  for (var i = kids.length - 1; i >= 0; i--) {
    if (kids[i].dataset.ts && kids[i].dataset.ts > timestamp) {
      result = kids[i];
    } else if (kids[i].dataset.ts && kids[i].dataset.ts <= timestamp) {
      break;
    }
  }
  return result;
}

function updateLastTurn() {
  var container = document.querySelector('.messages');
  if (!container) return;

  // Only render messages that haven't been rendered yet
  var newMessages = wsAllMessages.slice(wsRenderedCount);
  wsRenderedCount = wsAllMessages.length;

  // Ensure timestamp order within batch
  newMessages = reorderIfNeeded(newMessages);

  // Stop any running agent timers when new messages arrive
  if (newMessages.length > 0) {
    container.querySelectorAll('.agent-timer:not([data-stopped])').forEach(function (t) {
      t.dataset.stopped = '1';
      var meta = null;
      // Try to find toolUseResult metadata from tool_result messages
      for (var j = 0; j < newMessages.length; j++) {
        if (newMessages[j].toolUseResult) { meta = newMessages[j].toolUseResult; break; }
      }
      if (meta) {
        var secs = Math.round((meta.totalDurationMs || 0) / 1000);
        t.textContent = (meta.totalToolUseCount || 0) + ' tool calls, ' + secs + 's';
      }
    });
  }

  for (var i = 0; i < newMessages.length; i++) {
    var msg = newMessages[i];

    // tool_result → re-render matching tool_use node with full result (same as history)
    if (isToolResultOnly(msg)) {
      if (Array.isArray(msg.content)) {
        for (var ri = 0; ri < msg.content.length; ri++) {
          var rb = msg.content[ri];
          if (rb.type !== 'tool_result' || !rb.tool_use_id) continue;
          var node = container.querySelector('[data-tool-id="' + rb.tool_use_id + '"]');
          if (!node) continue;
          // Find original tool_use block from message history
          var toolUseBlock = null;
          for (var mi = 0; mi < wsAllMessages.length; mi++) {
            var am = wsAllMessages[mi];
            if (!Array.isArray(am.content)) continue;
            for (var bi = 0; bi < am.content.length; bi++) {
              if (am.content[bi].type === 'tool_use' && am.content[bi].id === rb.tool_use_id) {
                toolUseBlock = am.content[bi];
                break;
              }
            }
            if (toolUseBlock) break;
          }
          if (!toolUseBlock) continue;
          // Attach Agent metadata if present
          if (msg.toolUseResult) rb._agentMeta = msg.toolUseResult;
          window._lastToolState = '';
          node.innerHTML = renderToolNode(toolUseBlock, rb);
          // Update state class (error/warning)
          var state = window._lastToolState || '';
          node.className = 'tl-item tool-node' + (state ? ' ' + state : '');
        }
      }
      continue;
    }
    // User message (but not interrupt — interrupt falls through to assistant render path)
    if (msg.type === 'user' && !isInterruptMsg(msg)) {
      if (tryDedup(msg)) continue;
      var userHtml = renderUserBubble(msg);
      if (userHtml) {
        var userInsert = findInsertBefore(container, msg.timestamp);
        if (userInsert) userInsert.insertAdjacentHTML('beforebegin', userHtml);
        else container.insertAdjacentHTML('beforeend', userHtml);
      }
      continue;
    }

    if (msg.type === 'ai-title') {
      var title = typeof msg.content === 'string' ? msg.content : '';
      if (title) { appState.sessionPreview = title; updateBreadcrumb(); saveNav(); }
      continue;
    }

    if (msg.type !== 'assistant' && !isInterruptMsg(msg)) continue;

    wsRunning = msg.type === 'assistant' && msg.stopReason !== 'end_turn';
    updateSendBtn();

    var html = renderSingleMessage(msg, wsAllMessages);
    if (!html) continue;

    // Insert at correct position by timestamp
    var insertBefore = findInsertBefore(container, msg.timestamp);
    var lastTurn;
    if (insertBefore) {
      var prev = insertBefore.previousElementSibling;
      lastTurn = (prev && prev.classList.contains('assistant-turn')) ? prev : null;
    } else {
      lastTurn = container.querySelector('.assistant-turn:last-child');
    }
    if (lastTurn) {
      lastTurn.insertAdjacentHTML('beforeend', html);
    } else if (insertBefore) {
      insertBefore.insertAdjacentHTML('beforebegin', '<div class="assistant-turn">' + html + '</div>');
    } else {
      container.insertAdjacentHTML('beforeend', '<div class="assistant-turn">' + html + '</div>');
    }
  }

  // After all messages rendered — check pending prompts
  dismissPermissionPrompt();
  // If we were waiting to see if a tool_result arrives, check now
  if (_pendingToolUse) {
    var resolved = newMessages.some(function (m) {
      return Array.isArray(m.content) && m.content.some(function (c) {
        return c.type === 'tool_result' && c.tool_use_id === _pendingToolUse.id;
      });
    });
    if (resolved) {
      _pendingToolUse = null; // auto-approved, no prompt needed
    } else {
      // tool_result didn't come in this batch — CC is waiting for user
      var prompt = buildClientPrompt(_pendingToolUse.name, _pendingToolUse.input);
      _pendingToolUse = null;
      if (prompt) showPermissionPrompt(prompt);
    }
  }
  checkPendingPrompts(wsAllMessages);

  var el = document.getElementById('content');
  function scrollIfNearBottom() {
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }
  scrollIfNearBottom();
  setTimeout(scrollIfNearBottom, 150);
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
      wsAllMessages.sort(function (a, b) { return (a.timestamp || '') < (b.timestamp || '') ? -1 : 1; });
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
  input.focus();
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
    wsSend({ action: 'send_message', projectHash: wsProjectHash, text: fullText, device: device });
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
      '<div class="msg-user" id="' + msgId + '">' + attachHtml
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

var _pendingToolUse = null;

/** Check if the last message has an unresolved prompt. */
function checkPendingPrompts(messages) {
  if (!messages.length) return;
  var last = messages[messages.length - 1];
  if (last.type !== 'assistant' || !Array.isArray(last.content)) return;
  for (var i = last.content.length - 1; i >= 0; i--) {
    var b = last.content[i];
    if (b.type === 'tool_use') {
      // Check if tool_result already exists in messages
      var hasResult = messages.some(function (m) {
        return Array.isArray(m.content) && m.content.some(function (c) {
          return c.type === 'tool_result' && c.tool_use_id === b.id;
        });
      });
      if (hasResult) return;
      var prompt = buildClientPrompt(b.name, b.input);
      if (!prompt) return;
      // AskUserQuestion / ExitPlanMode always need user input — show immediately
      if (prompt.type === 'ask_user' || prompt.type === 'plan_approval') {
        showPermissionPrompt(prompt);
        return;
      }
      // Tool permissions (Bash/Edit/Write) might be auto-approved — defer to check
      _pendingToolUse = { id: b.id, name: b.name, input: b.input };
      return;
    }
  }
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

/** Check if an incoming user message matches a pending sent message. If so, mark as delivered instead of appending. */
function tryDedup(msg) {
  if (msg.type !== 'user') return false;
  var text = extractMsgText(msg).trim();
  if (!text) return false;

  var stripped = stripImageRefs(text);
  for (var i = 0; i < pendingSentMessages.length; i++) {
    var pendingText = pendingSentMessages[i].text.trim();
    if (pendingText === stripped || pendingText === text) {
      var el = document.getElementById(pendingSentMessages[i].id);
      if (el) {
        // Update data-ts to real timestamp so assistant insertion finds correct position
        if (msg.timestamp) el.dataset.ts = msg.timestamp;
        var status = el.querySelector('.sending-status');
        if (status) {
          var ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
          status.innerHTML = '<span style="color:#3fb950">&#10003;</span> ' + ts;
          setTimeout(function () {
            status.innerHTML = ts;
            status.style.color = '#6e7681';
          }, 2000);
        }
      }
      pendingSentMessages.splice(i, 1);
      return true;
    }
  }
  return false;
}
