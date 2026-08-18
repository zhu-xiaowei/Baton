// Permission Prompt: bridge pushes permission_request; we reply permission_reply.
import { state } from '../state.js';
import {
  createCodexPermissionController,
  isCodexPermissionRequest,
} from './permission-codex.js';

var _req = null;
var _askQuestions = null;
var _askIndex = 0;
var _askAnswers = [];

var codexPermission = createCodexPermissionController({
  renderPrompt: renderPrompt,
  reply: reply,
  dismiss: dismissPermissionPrompt,
  buildToolSummary: buildToolSummary,
});

function reply(payload) {
  var send = (typeof wsSendReliable === 'function') ? wsSendReliable : wsSend;
  send(Object.assign({
    action: 'permission_reply',
    sessionId: state.wsSessionId,
    device: state.appState.device || '',
  }, payload));
}

function resetClaudeState() {
  _askQuestions = null;
  _askIndex = 0;
  _askAnswers = [];
}

function showPermissionPrompt(msg) {
  _req = {
    requestId: msg.requestId,
    kind: msg.kind || 'tool',
  };
  resetClaudeState();
  codexPermission.reset();

  if (isCodexPermissionRequest(msg)) {
    codexPermission.show(msg);
    return;
  }
  if (msg.kind === 'ask') {
    _askQuestions = (msg.questions && msg.questions.length)
      ? msg.questions
      : [msg.input || {}];
    renderAskStep();
    return;
  }
  if (msg.kind === 'plan') {
    renderPrompt({
      title: 'Accept this plan?',
      description: msg.plan || (msg.input && msg.input.plan) || '',
      options: [
        { label: 'Yes, proceed', act: 'plan-accept' },
        {
          label: 'No, keep planning',
          act: 'plan-reject',
          hasInput: true,
          placeholder: 'Tell Claude what to do instead...',
        },
      ],
    });
    return;
  }
  var summary = buildToolSummary(msg.toolName, msg.input || {});
  renderPrompt({
    title: summary.title,
    description: summary.description,
    options: [
      { label: 'Yes', act: 'allow', key: '1' },
      { label: 'No', act: 'deny', key: '2' },
    ],
  });
}

function renderPrompt(prompt) {
  var existing = document.getElementById('permission-prompt');
  if (existing) existing.remove();

  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = true;
    inputBar.querySelectorAll('.input-row button').forEach(function (button) {
      button.disabled = true;
    });
  }

  var container = document.querySelector('.messages');
  if (!container) return;
  container.classList.add('has-permission-prompt');

  var html = '<div class="permission-prompt" id="permission-prompt">';
  html += '<div class="permission-header"><div class="permission-title">'
    + esc(prompt.title || 'Confirm?') + '</div>'
    + '<button class="permission-close" onclick="cancelPermissionPrompt()" '
    + 'title="Cancel (Esc)">&times;</button></div>';
  if (prompt.description) {
    html += '<pre class="permission-desc">' + esc(prompt.description) + '</pre>';
  }
  html += '<div class="permission-options">';
  for (var i = 0; i < prompt.options.length; i++) {
    var option = prompt.options[i];
    var buttonClass = option.tone === 'deny' || /deny|reject|no/i.test(option.act || '')
      ? 'permission-btn deny'
      : 'permission-btn allow';
    html += '<button class="' + buttonClass + '" data-act="' + esc(option.act) + '" '
      + 'data-has-input="' + (option.hasInput ? '1' : '0') + '" '
      + 'onclick="handlePermissionOption(this)">'
      + (option.key ? '<span class="permission-key">' + esc(option.key) + '</span>' : '')
      + '<span class="permission-copy">'
      + '<span class="permission-label">' + esc(option.label) + '</span>'
      + (option.description
        ? '<span class="permission-desc-inline">' + esc(option.description) + '</span>'
        : '')
      + '</span>'
      + '</button>';
    if (option.hasInput) {
      html += '<div class="permission-input-wrap" style="display:none">'
        + '<input class="permission-input" placeholder="' + esc(option.placeholder || '') + '" '
        + 'onkeydown="if(event.key===\'Enter\'&&!event.isComposing&&event.keyCode!==229)'
        + 'submitPermissionWithInput(this,\'' + esc(option.act) + '\')" />'
        + '<button class="permission-submit" '
        + 'onclick="submitPermissionWithInput(this.previousElementSibling,\'' + esc(option.act)
        + '\')">Send</button></div>';
    }
  }
  html += '</div></div>';

  container.insertAdjacentHTML('beforeend', html);
  if (typeof updateSpinner === 'function') updateSpinner();
  var content = document.getElementById('content');
  var promptEl = document.getElementById('permission-prompt');
  function pinPromptToBottom() {
    if (promptEl && promptEl.isConnected) content.scrollTop = content.scrollHeight;
  }
  pinPromptToBottom();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(pinPromptToBottom);
}

function renderAskStep() {
  var question = _askQuestions[_askIndex] || {};
  var prefix = _askQuestions.length > 1
    ? '[' + (_askIndex + 1) + '/' + _askQuestions.length + '] '
    : '';
  var header = question.header ? '[' + question.header + '] ' : '';
  var options = (question.options || []).map(function (option, index) {
    return {
      label: option.label,
      description: option.description || '',
      act: 'opt:' + index,
    };
  });
  options.push({
    label: 'Type something…',
    act: 'type',
    hasInput: true,
    placeholder: 'Type your response…',
  });
  renderPrompt({
    title: prefix + header + (question.question || question.text || ''),
    options: options,
  });
}

function handlePermissionOption(button) {
  var act = button.getAttribute('data-act');
  if (button.getAttribute('data-has-input') === '1') {
    var wrapper = button.nextElementSibling;
    if (wrapper && wrapper.classList.contains('permission-input-wrap')) {
      var visible = wrapper.style.display !== 'none';
      wrapper.style.display = visible ? 'none' : 'flex';
      if (!visible) wrapper.querySelector('input').focus();
      return;
    }
  }
  var label = button.querySelector('.permission-label');
  chooseOption(act, label ? label.textContent : act);
}

function submitPermissionWithInput(input, act) {
  var text = (input.value || '').trim();
  if (text) chooseOption(act, text, true);
}

function chooseOption(act, label, isTyped) {
  if (!_req || codexPermission.choose(act, label, isTyped)) return;

  if (_req.kind === 'tool') {
    reply({
      requestId: _req.requestId,
      decision: act === 'allow' ? 'allow' : 'deny',
    });
    dismissPermissionPrompt();
    return;
  }
  if (_req.kind === 'plan') {
    reply({
      requestId: _req.requestId,
      decision: 'answer',
      answerText: act === 'plan-accept'
        ? 'Approved, proceed with the plan.'
        : label,
    });
    dismissPermissionPrompt();
    return;
  }

  var question = _askQuestions[_askIndex] || {};
  var answer = label;
  if (act !== 'type' && !isTyped) {
    var index = parseInt(act.slice(4), 10);
    var option = (question.options || [])[index];
    answer = option ? option.label : label;
  }
  _askAnswers.push({
    question: question.question || question.text || '',
    answer: answer,
  });

  if (_askIndex < _askQuestions.length - 1) {
    _askIndex++;
    renderAskStep();
    return;
  }
  var text = _askAnswers.map(function (entry) {
    return (entry.question ? entry.question + ' ' : '') + '→ ' + entry.answer;
  }).join('\n');
  reply({
    requestId: _req.requestId,
    decision: 'answer',
    answerText: text,
  });
  dismissPermissionPrompt();
}

function cancelPermissionPrompt() {
  if (codexPermission.cancel()) return;
  if (_req) {
    reply({ requestId: _req.requestId, decision: 'deny' });
  }
  dismissPermissionPrompt();
}

function dismissPermissionPrompt() {
  _req = null;
  resetClaudeState();
  codexPermission.reset();
  var prompt = document.getElementById('permission-prompt');
  if (prompt) prompt.remove();
  var container = document.querySelector('.messages');
  if (container) container.classList.remove('has-permission-prompt');
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = false;
    inputBar.querySelectorAll('.input-row button').forEach(function (button) {
      button.disabled = false;
    });
  }
  if (typeof updateSpinner === 'function') updateSpinner();
}

function resolvePermissionPrompt(requestId) {
  if (!_req || (requestId && _req.requestId !== requestId)) return false;
  dismissPermissionPrompt();
  return true;
}

function buildToolSummary(toolName, input) {
  if (toolName === 'Bash' || toolName === 'bash') {
    return {
      title: 'Run command?',
      description: input.command || input.cmd || '',
    };
  }
  if (toolName === 'Edit' || toolName === 'Write'
    || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    var filePath = input.file_path || input.path || '';
    return {
      title: toolName + ': ' + filePath,
      description: toolName === 'Write' ? 'Create/overwrite file' : 'Edit file',
    };
  }
  var description;
  try { description = JSON.stringify(input, null, 2); } catch (e) { description = ''; }
  if (description && description.length > 500) {
    description = description.slice(0, 500) + '…';
  }
  return {
    title: toolName || 'Run tool?',
    description: description,
  };
}

function hasActivePermissionPrompt() {
  return !!_req;
}

Object.assign(window, {
  showPermissionPrompt: showPermissionPrompt,
  handlePermissionOption: handlePermissionOption,
  submitPermissionWithInput: submitPermissionWithInput,
  cancelPermissionPrompt: cancelPermissionPrompt,
  dismissPermissionPrompt: dismissPermissionPrompt,
  resolvePermissionPrompt: resolvePermissionPrompt,
  hasActivePermissionPrompt: hasActivePermissionPrompt,
});
