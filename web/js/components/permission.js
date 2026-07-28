// Permission Prompt (headless): bridge pushes permission_request; we reply permission_reply. See docs/headless-streaming.md.
import { state } from '../state.js';

var _req = null;            // pending control_request { sessionId, requestId, kind, toolName }
var _askQuestions = null;   // AskUserQuestion input.questions[]
var _askIndex = 0;
var _askAnswers = [];       // [{ question, answer }]

function reply(payload) {
  var send = (typeof wsSendReliable === 'function') ? wsSendReliable : wsSend;
  send(Object.assign({ action: 'permission_reply', sessionId: state.wsSessionId, device: state.appState.device || '' }, payload));
}

function showPermissionPrompt(msg) {
  _req = { sessionId: msg.sessionId, requestId: msg.requestId, kind: msg.kind || 'tool', toolName: msg.toolName };
  _askQuestions = null; _askIndex = 0; _askAnswers = [];

  if (msg.kind === 'ask') {
    var qs = (msg.questions && msg.questions.length) ? msg.questions : [msg.input || {}];
    _askQuestions = qs;
    _askIndex = 0;
    renderAskStep();
    return;
  }
  if (msg.kind === 'plan') {
    renderPrompt({
      title: 'Accept this plan?',
      description: (msg.plan || (msg.input && msg.input.plan) || ''),
      options: [
        { label: 'Yes, proceed', act: 'plan-accept' },
        { label: 'No, keep planning', act: 'plan-reject', hasInput: true, placeholder: 'Tell Claude what to do instead...' }
      ]
    });
    return;
  }
  // Ordinary tool (Bash/Edit/Write/MCP/…)
  renderPrompt(buildToolPrompt(msg.toolName, msg.input || {}));
}

// ---- Rendering ----

function renderPrompt(p) {
  var existing = document.getElementById('permission-prompt');
  if (existing) existing.remove();

  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = true;
    inputBar.querySelectorAll('.input-row button').forEach(function (b) { b.disabled = true; });
    inputBar.querySelector('#msg-input').placeholder = 'Please respond to the prompt above...';
  }

  var container = document.querySelector('.messages');
  if (!container) return;

  var html = '<div class="permission-prompt" id="permission-prompt">';
  html += '<div class="permission-header"><div class="permission-title">' + esc(p.title || 'Confirm?') + '</div>'
    + '<button class="permission-close" onclick="cancelPermissionPrompt()" title="Cancel (Esc)">&times;</button></div>';
  if (p.description) html += '<pre class="permission-desc">' + esc(p.description) + '</pre>';
  html += '<div class="permission-options">';
  for (var i = 0; i < p.options.length; i++) {
    var opt = p.options[i];
    var btnClass = /deny|reject|no/i.test(opt.act || '') ? 'permission-btn deny' : 'permission-btn allow';
    html += '<button class="' + btnClass + '" data-act="' + esc(opt.act) + '" '
      + 'data-has-input="' + (opt.hasInput ? '1' : '0') + '" '
      + 'onclick="handlePermissionOption(this)">'
      + (opt.key ? '<span class="permission-key">' + esc(opt.key) + '</span> ' : '')
      + '<span class="permission-label">' + esc(opt.label) + '</span>'
      + (opt.description ? '<span class="permission-desc-inline">' + esc(opt.description) + '</span>' : '')
      + '</button>';
    if (opt.hasInput) {
      html += '<div class="permission-input-wrap" style="display:none">'
        + '<input class="permission-input" placeholder="' + esc(opt.placeholder || '') + '" '
        + 'onkeydown="if(event.key===\'Enter\'&&!event.isComposing&&event.keyCode!==229)submitPermissionWithInput(this,\'' + esc(opt.act) + '\')" />'
        + '<button class="permission-submit" onclick="submitPermissionWithInput(this.previousElementSibling,\'' + esc(opt.act) + '\')">Send</button>'
        + '</div>';
    }
  }
  html += '</div></div>';

  container.insertAdjacentHTML('beforeend', html);
  if (typeof updateSpinner === 'function') updateSpinner(); // hide spinner while the prompt is up
  var el = document.getElementById('content');
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

/** Render the current step of the AskUserQuestion wizard. */
function renderAskStep() {
  var q = _askQuestions[_askIndex] || {};
  var prefix = _askQuestions.length > 1 ? '[' + (_askIndex + 1) + '/' + _askQuestions.length + '] ' : '';
  var header = q.header ? '[' + q.header + '] ' : '';
  var rawOptions = q.options || [];
  var options = rawOptions.map(function (o, i) {
    return { label: o.label, description: o.description || '', act: 'opt:' + i };
  });
  options.push({ label: 'Type something…', act: 'type', hasInput: true, placeholder: 'Type your response…' });
  renderPrompt({ title: prefix + header + (q.question || q.text || ''), options: options });
}

// ---- Option handling ----

function handlePermissionOption(btn) {
  var act = btn.getAttribute('data-act');
  var hasInput = btn.getAttribute('data-has-input') === '1';
  if (hasInput) {
    var wrap = btn.nextElementSibling;
    if (wrap && wrap.classList.contains('permission-input-wrap')) {
      var visible = wrap.style.display !== 'none';
      wrap.style.display = visible ? 'none' : 'flex';
      if (!visible) wrap.querySelector('input').focus();
      return;
    }
  }
  var label = btn.querySelector('.permission-label');
  chooseOption(act, label ? label.textContent : act);
}

function submitPermissionWithInput(input, act) {
  var text = (input.value || '').trim();
  if (!text) return;
  chooseOption(act, text, true);
}

/** Act on a chosen option. For 'ask' this advances the wizard; for 'tool'/'plan' it replies. */
function chooseOption(act, label, isTyped) {
  if (!_req) return;

  // Ordinary tool: Yes/No → allow/deny.
  if (_req.kind === 'tool') {
    reply({ requestId: _req.requestId, decision: act === 'allow' ? 'allow' : 'deny' });
    dismissPermissionPrompt();
    return;
  }

  // Plan approval.
  if (_req.kind === 'plan') {
    var planAns = act === 'plan-accept' ? 'Approved, proceed with the plan.' : label;
    reply({ requestId: _req.requestId, decision: 'answer', answerText: planAns });
    dismissPermissionPrompt();
    return;
  }

  // AskUserQuestion wizard step.
  var q = _askQuestions[_askIndex] || {};
  var answer;
  if (act === 'type' || isTyped) {
    answer = label;
  } else {
    var idx = parseInt(act.slice(4), 10); // 'opt:N'
    var opt = (q.options || [])[idx];
    answer = opt ? opt.label : label;
  }
  _askAnswers.push({ question: q.question || q.text || '', answer: answer });

  if (_askIndex < _askQuestions.length - 1) {
    _askIndex++;
    renderAskStep();
    return;
  }
  // Last question answered — build "question → answer" text (historical format).
  var text = _askAnswers.map(function (a) {
    return (a.question ? a.question + ' ' : '') + '→ ' + a.answer;
  }).join('\n');
  reply({ requestId: _req.requestId, decision: 'answer', answerText: text });
  dismissPermissionPrompt();
}

function cancelPermissionPrompt() {
  if (_req) {
    // Bare deny (no answerText) tells CC the user declined to answer.
    reply({ requestId: _req.requestId, decision: 'deny' });
  }
  dismissPermissionPrompt();
}

function dismissPermissionPrompt() {
  _req = null;
  _askQuestions = null; _askIndex = 0; _askAnswers = [];
  var el = document.getElementById('permission-prompt');
  if (el) el.remove();
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = false;
    inputBar.querySelectorAll('.input-row button').forEach(function (b) { b.disabled = false; });
    inputBar.querySelector('#msg-input').placeholder = 'Send a message...';
  }
  if (typeof updateSpinner === 'function') updateSpinner();
}

/** Build title/description + Yes/No options for an ordinary tool. */
function buildToolPrompt(toolName, input) {
  var title, description;
  if (toolName === 'Bash' || toolName === 'bash') {
    title = 'Run command?';
    description = input.command || input.cmd || '';
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    var fp = input.file_path || input.path || '';
    title = toolName + ': ' + fp;
    description = toolName === 'Write' ? 'Create/overwrite file' : 'Edit file';
  } else {
    title = toolName || 'Run tool?';
    try { description = JSON.stringify(input, null, 2); } catch (e) { description = ''; }
    if (description && description.length > 500) description = description.slice(0, 500) + '…';
  }
  return {
    title: title, description: description,
    options: [
      { label: 'Yes', act: 'allow', key: '1' },
      { label: 'No', act: 'deny', key: '2' }
    ]
  };
}

// No-op: prompts are bridge-driven now; kept so existing callers don't break.
function checkPendingPrompts() {}

// True while a prompt awaits the user (ws.js checks this before auto-dismissing).
function hasActivePermissionPrompt() { return !!_req; }

Object.assign(window, {
  showPermissionPrompt, handlePermissionOption, submitPermissionWithInput,
  cancelPermissionPrompt, dismissPermissionPrompt,
  checkPendingPrompts, hasActivePermissionPrompt,
});
