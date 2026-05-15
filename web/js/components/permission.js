// ---- Permission Prompt ----

function showPermissionPrompt(msg) {
  // Remove any existing prompt DOM (without clearing wizard state)
  var existing = document.getElementById('permission-prompt');
  if (existing) existing.remove();

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
  if (_wizardQuestions && _wizardIndex < _wizardQuestions.length - 1) {
    _wizardIndex++;
    var nq = _wizardQuestions[_wizardIndex];
    var stepPrefix = '[' + (_wizardIndex + 1) + '/' + _wizardQuestions.length + '] ';
    var opts = (nq.options || []).map(function(o, i) { return { label: o.label, description: o.description || '', value: 'arrow:' + i, key: String(i+1) }; });
    opts.push({ label: 'Type something...', value: 'type:' + (nq.options||[]).length, key: String((nq.options||[]).length+1), hasInput: true, placeholder: 'Type your response...' });
    showPermissionPrompt({ type: 'ask_user', title: stepPrefix + (nq.header ? '[' + nq.header + '] ' : '') + (nq.question || ''), options: opts });
    return;
  }
  if (_wizardQuestions && _wizardIndex === _wizardQuestions.length - 1) {
    showPermissionPrompt({ type: 'ask_user', title: 'Submit answers?', options: [
      { label: 'Submit answers', value: 'arrow:0', key: '1' },
      { label: 'Cancel', value: 'arrow:1', key: '2' }
    ]});
    _wizardQuestions = null; _wizardIndex = 0;
    return;
  }
  dismissPermissionPrompt();
}

function submitPermissionWithInput(input, value) {
  var text = input.value.trim();
  if (!text) return; // require input
  // Send as type:N:text — bridge navigates to option, types text, Enter
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, device: appState.device || '', approved: value + ':' + text });
  if (_wizardQuestions && _wizardIndex < _wizardQuestions.length - 1) {
    _wizardIndex++;
    var nq = _wizardQuestions[_wizardIndex];
    var stepPrefix = '[' + (_wizardIndex + 1) + '/' + _wizardQuestions.length + '] ';
    var opts = (nq.options || []).map(function(o, i) { return { label: o.label, description: o.description || '', value: 'arrow:' + i, key: String(i+1) }; });
    opts.push({ label: 'Type something...', value: 'type:' + (nq.options||[]).length, key: String((nq.options||[]).length+1), hasInput: true, placeholder: 'Type your response...' });
    showPermissionPrompt({ type: 'ask_user', title: stepPrefix + (nq.header ? '[' + nq.header + '] ' : '') + (nq.question || ''), options: opts });
    return;
  }
  if (_wizardQuestions && _wizardIndex === _wizardQuestions.length - 1) {
    showPermissionPrompt({ type: 'ask_user', title: 'Submit answers?', options: [
      { label: 'Submit answers', value: 'arrow:0', key: '1' },
      { label: 'Cancel', value: 'arrow:1', key: '2' }
    ]});
    _wizardQuestions = null; _wizardIndex = 0;
    return;
  }
  dismissPermissionPrompt();
}

function cancelPermissionPrompt() {
  // Send Escape to Claude Code
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, device: appState.device || '', approved: 'escape' });
  dismissPermissionPrompt();
}

function dismissPermissionPrompt() {
  _pendingToolUseId = null;
  _wizardQuestions = null; _wizardIndex = 0;
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
    var allQ = toolInput.questions || [toolInput];
    if (allQ.length > 1) { _wizardQuestions = allQ; _wizardIndex = 0; }
    else { _wizardQuestions = null; _wizardIndex = 0; }
    var q = allQ[_wizardIndex];
    var question = q.question || q.text || '';
    var header = q.header || '';
    var stepPrefix = _wizardQuestions ? '[' + (_wizardIndex + 1) + '/' + _wizardQuestions.length + '] ' : '';
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
      title: stepPrefix + (header ? '[' + header + '] ' + question : question),
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

// Multi-question wizard state
var _wizardQuestions = null;
var _wizardIndex = 0;
var _pendingToolUseId = null;

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
    _pendingToolUseId = null;
    dismissPermissionPrompt();
    return;
  }

  // Bridge marks each tool_use with needsPermission — trust it
  if (!toolUse.needsPermission) return;

  var prompt = buildClientPrompt(toolUse.name, toolUse.input);
  if (!prompt) return;

  _pendingToolUseId = toolUse.id;
  showPermissionPrompt(prompt);
}
