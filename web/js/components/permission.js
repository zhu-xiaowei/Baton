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
