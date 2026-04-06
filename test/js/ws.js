// WebSocket connection management
var ws = null;
var wsSessionId = null;
var wsMessageCount = 0;
var wsStatusText = '';
var wsAllMessages = []; // track all messages for tool pairing

function connectWs() {
  if (!WS_URL) return;
  if (ws) { ws.close(); ws = null; }
  ws = new WebSocket(WS_URL + '?apiKey=' + KEY + '&role=app');

  ws.onopen = function () {
    setWsStatus('connected');
    if (wsSessionId) subscribeSession(wsSessionId);
  };

  ws.onmessage = function (e) {
    var msg = JSON.parse(e.data);
    if (msg.action === 'messages' && msg.sessionId === wsSessionId) {
      for (var i = 0; i < msg.messages.length; i++) {
        wsAllMessages.push(msg.messages[i]);
        wsMessageCount++;
      }
      updateLastTurn();
      showStats(wsMessageCount + ' messages (' + msg.messages.length + ' new via WS)');
    } else if (msg.action === 'permission_request') {
      if (msg.sessionId === wsSessionId) showPermissionPrompt(msg);
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
    setWsStatus('');
  }
}

// Track last rendered message index to only append new ones
var wsRenderedCount = 0;

function updateLastTurn() {
  var container = document.querySelector('.messages');
  if (!container) return;

  // Only render messages that haven't been rendered yet
  var newMessages = wsAllMessages.slice(wsRenderedCount);
  wsRenderedCount = wsAllMessages.length;

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

    // tool_result → append OUT to matching tool_use node
    if (isToolResultOnly(msg)) {
      if (Array.isArray(msg.content)) {
        for (var ri = 0; ri < msg.content.length; ri++) {
          var rb = msg.content[ri];
          if (rb.type === 'tool_result' && rb.tool_use_id) {
            var node = container.querySelector('[data-tool-id="' + rb.tool_use_id + '"]');
            if (node && !node.querySelector('.tool-body-out')) {
              var outContent = typeof rb.content === 'string' ? rb.content
                : Array.isArray(rb.content) ? rb.content.map(function(c) { return c.text || ''; }).join('') : '';
              if (outContent) {
                var bodyEl = node.querySelector('.tool-body');
                if (bodyEl) {
                  bodyEl.insertAdjacentHTML('beforeend',
                    '<div class="tool-body-out"><span class="tool-label">OUT</span><pre class="tool-out-pre">' + esc(outContent) + '</pre></div>');
                } else {
                  node.insertAdjacentHTML('beforeend',
                    '<div class="tool-body"><div class="tool-body-out"><span class="tool-label">OUT</span><pre class="tool-out-pre">' + esc(outContent) + '</pre></div></div>');
                }
              }
            }
          }
        }
      }
      continue;
    }
    if (isInterruptMsg(msg)) continue;

    // User message: dedup against pending sent messages, or render new bubble
    if (msg.type === 'user') {
      if (tryDedup(msg)) continue;  // matched a pending sent msg — skip rendering
      var userHtml = renderUserBubble(msg);
      if (userHtml) container.insertAdjacentHTML('beforeend', userHtml);
      continue;
    }

    if (msg.type !== 'assistant') continue;

    var html = renderSingleMessage(msg, wsAllMessages);
    if (!html) continue;

    // Append to existing turn or create new one
    var lastTurn = container.querySelector('.assistant-turn:last-child');
    if (lastTurn) {
      lastTurn.insertAdjacentHTML('beforeend', html);
    } else {
      container.insertAdjacentHTML('beforeend', '<div class="assistant-turn">' + html + '</div>');
    }
  }

  // After all messages rendered — check if last message needs a prompt
  dismissPermissionPrompt();
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
  showStats(wsMessageCount + ' messages (live)');
}

function startWs(sessionId) {
  wsSessionId = sessionId;
  if (!ws) connectWs();
  else subscribeSession(sessionId);
}

// Track pending (optimistically rendered) messages for dedup
var pendingSentMessages = [];

function sendMessage() {
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  if (!text || !wsSessionId) return;
  wsSend({ action: 'send_message', sessionId: wsSessionId, text: text });

  // Optimistic render: show user message immediately with sending status
  var msgId = 'sent-' + Date.now();
  pendingSentMessages.push({ id: msgId, text: text });
  var container = document.querySelector('.messages');
  if (container) {
    var time = new Date().toLocaleTimeString();
    container.insertAdjacentHTML('beforeend',
      '<div class="msg-user" id="' + msgId + '"><div class="msg-text">' + esc(text) + '</div>'
      + '<div class="msg-time sending-status">sending... ' + time + '</div></div>');
    var el = document.getElementById('content');
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  input.value = '';
  input.focus();
}

// ---- Permission Prompt ----

function showPermissionPrompt(msg) {
  // Remove any existing prompt
  dismissPermissionPrompt();

  // Disable bottom input bar while prompt is active
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('input').disabled = true;
    inputBar.querySelector('button').disabled = true;
    inputBar.querySelector('input').placeholder = 'Please respond to the prompt above...';
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
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, approved: value });
  dismissPermissionPrompt();
}

function submitPermissionWithInput(input, value) {
  var text = input.value.trim();
  if (!text) return; // require input
  // Send as type:N:text — bridge navigates to option, types text, Enter
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, approved: value + ':' + text });
  dismissPermissionPrompt();
}

function cancelPermissionPrompt() {
  // Send Escape to Claude Code
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, approved: 'escape' });
  dismissPermissionPrompt();
}

function dismissPermissionPrompt() {
  var el = document.getElementById('permission-prompt');
  if (el) el.remove();
  // Re-enable bottom input bar
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('input').disabled = false;
    inputBar.querySelector('button').disabled = false;
    inputBar.querySelector('input').placeholder = 'Send a message...';
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

/** Check if the last message has an unresolved prompt. */
function checkPendingPrompts(messages) {
  if (!messages.length) return;
  var last = messages[messages.length - 1];
  if (last.type !== 'assistant' || !Array.isArray(last.content)) return;
  for (var i = last.content.length - 1; i >= 0; i--) {
    var b = last.content[i];
    if (b.type === 'tool_use') {
      var prompt = buildClientPrompt(b.name, b.input);
      if (prompt) showPermissionPrompt(prompt);
      return;
    }
  }
}

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

/** Check if an incoming user message matches a pending sent message. If so, mark as delivered instead of appending. */
function tryDedup(msg) {
  if (msg.type !== 'user') return false;
  var text = extractMsgText(msg).trim();
  if (!text) return false;

  for (var i = 0; i < pendingSentMessages.length; i++) {
    if (pendingSentMessages[i].text.trim() === text) {
      // Match found — update sending status to delivered
      var el = document.getElementById(pendingSentMessages[i].id);
      if (el) {
        var status = el.querySelector('.sending-status');
        if (status) {
          status.innerHTML = '<span style="color:#3fb950">&#10003;</span>';
          setTimeout(function () { status.style.display = 'none'; }, 2000);
        }
      }
      pendingSentMessages.splice(i, 1);
      return true;
    }
  }
  return false;
}
