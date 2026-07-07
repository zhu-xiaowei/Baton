// ---- Permission Prompt ----
import { state } from '../state.js';

function showPermissionPrompt(msg) {
  // Remove any existing prompt DOM (without clearing wizard state)
  var existing = document.getElementById('permission-prompt');
  if (existing) existing.remove();

  // Disable bottom input bar while prompt is active — except in rescued mode,
  // where CC is idle (not actually blocked on this tool_use anymore) and the
  // user may prefer to just type a normal message instead of the wizard.
  var inputBar = document.getElementById('input-bar');
  if (inputBar && !_wizardRescued) {
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
  var sp = document.getElementById('cc-spinner');
  if (sp) sp.style.display = 'none';
  var el = document.getElementById('content');
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

function handlePermissionOption(btn) {
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

  var labelEl = btn.querySelector('.permission-label');
  advanceWizard(btn.getAttribute('data-value'), labelEl ? labelEl.textContent : btn.getAttribute('data-value'));
}

function submitPermissionWithInput(input, value) {
  var text = input.value.trim();
  if (!text) return; // require input
  // Send as type:N:text — bridge navigates to option, types text, Enter
  advanceWizard(value + ':' + text, text);
}

// Advance to the next wizard step (or finish). replyValue is the raw
// permission_reply payload for the live path; answerLabel is the human-
// readable choice, used to build the rescued path's chat-text summary.
function advanceWizard(replyValue, answerLabel) {
  if (_wizardRescued) {
    var rq = _rescuedQuestions[_wizardIndex];
    _wizardAnswers.push({ question: rq ? (rq.question || rq.text || '') : '', answer: answerLabel });
  } else {
    wsSend({ action: 'permission_reply', sessionId: state.wsSessionId, device: state.appState.device || '', approved: replyValue });
  }

  if (_wizardQuestions && _wizardIndex < _wizardQuestions.length - 1) {
    _wizardIndex++;
    showWizardStep();
    return;
  }
  if (_wizardRescued) {
    sendRescuedAnswers();
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

/** Render the current step of a live multi-question wizard. */
function showWizardStep() {
  var nq = _wizardQuestions[_wizardIndex];
  var stepPrefix = '[' + (_wizardIndex + 1) + '/' + _wizardQuestions.length + '] ';
  var opts = (nq.options || []).map(function(o, i) { return { label: o.label, description: o.description || '', value: 'arrow:' + i, key: String(i+1) }; });
  opts.push({ label: 'Type something...', value: 'type:' + (nq.options||[]).length, key: String((nq.options||[]).length+1), hasInput: true, placeholder: 'Type your response...' });
  showPermissionPrompt({ type: 'ask_user', title: stepPrefix + (nq.header ? '[' + nq.header + '] ' : '') + (nq.question || ''), options: opts });
}

// Bridge force-flushed this wizard's tool_use from a stuck session (see
// bridge/stall.mjs) — CC has already moved on, so there's no live wizard state
// left to navigate via arrow keys. Answers are collected locally, then sent
// back as one plain chat message instead of permission_reply.
function sendRescuedAnswers() {
  var lines = [];
  if (_wizardSummary) lines.push(_wizardSummary, '');
  for (var i = 0; i < _wizardAnswers.length; i++) {
    var a = _wizardAnswers[i];
    lines.push((a.question ? a.question + ' ' : '') + '→ ' + a.answer);
  }
  var text = lines.join('\n');
  dismissPermissionPrompt();
  if (typeof doSend === 'function') doSend(text, text, []);
}

function cancelPermissionPrompt() {
  // Live mode: send Escape to Claude Code. Rescued mode: CC already moved on
  // (nothing to cancel there) — just close the card, don't send anything.
  if (!_wizardRescued) {
    wsSend({ action: 'permission_reply', sessionId: state.wsSessionId, device: state.appState.device || '', approved: 'escape' });
  }
  dismissPermissionPrompt();
}

function dismissPermissionPrompt() {
  _pendingToolUseId = null;
  _wizardQuestions = null; _wizardIndex = 0;
  _wizardRescued = false; _wizardAnswers = []; _wizardSummary = ''; _rescuedQuestions = [];
  var el = document.getElementById('permission-prompt');
  if (el) el.remove();
  // Re-enable bottom input bar
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = false;
    inputBar.querySelectorAll('.input-row button').forEach(function(b) { b.disabled = false; });
    inputBar.querySelector('#msg-input').placeholder = 'Send a message...';
  }
  if (typeof updateSpinner === 'function') updateSpinner();
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
  // Fallback: MCP tools only — generic permission prompt
  if (toolName.indexOf('mcp__') !== 0) return null;
  var desc = '';
  try { desc = JSON.stringify(toolInput, null, 2); } catch(e) {}
  if (desc.length > 500) desc = desc.substring(0, 500) + '…';
  return {
    type: 'tool_permission',
    title: toolName,
    description: desc,
    options: [
      { label: 'Yes', value: 'arrow:0', key: '1' },
      { label: 'Yes, always', value: 'arrow:1', key: '2' },
      { label: 'No', value: 'arrow:2', key: '3' }
    ]
  };
}

// Multi-question wizard state
var _wizardQuestions = null;
var _wizardIndex = 0;
var _pendingToolUseId = null;
// Rescued mode (see bridge/stall.mjs): CC already moved on, so answers are
// collected locally and sent as one chat message instead of permission_reply.
var _wizardRescued = false;
var _wizardAnswers = [];
var _wizardSummary = '';
// The rescued tool_use's full questions array. Kept separate from
// _wizardQuestions because buildClientPrompt() nulls that out for a single
// question (the live path only needs it for multi-step nav) — but the rescued
// path still needs each question's text to build the chat message.
var _rescuedQuestions = [];

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

  // Bridge force-flushed this from a stuck multi-question wizard (see
  // bridge/stall.mjs) — its tool_result was intentionally hidden, so it looks
  // pending here, but CC has already moved on. Reuse the normal wizard UI in
  // "rescued" mode: answers accumulate locally instead of going out via
  // permission_reply (there's no live arrow-key state left to navigate).
  if (toolUse.stallRescued && toolUse.name === 'AskUserQuestion') {
    if (document.getElementById('permission-prompt')) return; // already showing
    _wizardRescued = true;
    _wizardAnswers = [];
    _wizardSummary = extractAssistantText(last);
    _rescuedQuestions = toolUse.input.questions || [toolUse.input];
    var prompt = buildClientPrompt(toolUse.name, toolUse.input);
    if (!prompt) return;
    showPermissionPrompt(prompt);
    return;
  }

  // Bridge marks each tool_use with needsPermission — trust it
  if (!toolUse.needsPermission) return;

  var prompt = buildClientPrompt(toolUse.name, toolUse.input);
  if (!prompt) return;

  _pendingToolUseId = toolUse.id;
  showPermissionPrompt(prompt);
}

/** The plain-text portion of an assistant message (CC's summary before the tool_use). */
function extractAssistantText(msg) {
  if (!Array.isArray(msg.content)) return '';
  return msg.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text || ''; }).join('\n').trim();
}

Object.assign(window, {
  showPermissionPrompt, handlePermissionOption, submitPermissionWithInput,
  cancelPermissionPrompt, dismissPermissionPrompt,
  buildClientPrompt, checkPendingPrompts,
});
