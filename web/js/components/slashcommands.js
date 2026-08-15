// Runtime-aware command autocomplete. Codex commands preserve the TUI's
// presentation order; Skills use the same "$name" composer syntax as Codex.
import { state } from '../state.js';

var CACHE_PREFIX = 'apeek_cmds:v6:';

var _commands = [];     // current command list shown/filtered against
var _skills = [];
var _filtered = [];     // commands matching the current "/prefix"
var _selected = 0;      // highlighted index in _filtered
var _open = false;
var _mode = 'commands';
var _parentCommand = null;
var _latestRequestId = '';
var _requestPending = false;
var _lastFetchAt = 0;
var _contextKey = '';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function projectHash() {
  var project = state.appState.project;
  return state.wsProjectHash || (project && project.hash) || '';
}

function runtime() {
  return state.appState.runtime || 'claude';
}

function cacheKey() {
  return CACHE_PREFIX
    + encodeURIComponent(state.appState.device || '') + ':'
    + encodeURIComponent(runtime()) + ':'
    + encodeURIComponent(projectHash());
}

function loadCache() {
  try {
    var raw = localStorage.getItem(cacheKey());
    if (!raw) return { commands: [], skills: [] };
    var cached = JSON.parse(raw);
    return {
      commands: Array.isArray(cached.commands) ? cached.commands : [],
      skills: Array.isArray(cached.skills) ? cached.skills : [],
    };
  } catch (e) {}
  return { commands: [], skills: [] };
}

function saveCache(commands, skills) {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({
      commands: commands,
      skills: skills,
    }));
  } catch (e) {}
}

function loadCurrentContext() {
  var key = cacheKey();
  if (_contextKey === key) return;
  _contextKey = key;
  var cached = loadCache();
  _commands = cached.commands;
  _skills = cached.skills;
}

// Fire a fresh scan request to the bridge (response → handleCommandsList).
function prefetchCommands() {
  var send = window.wsSendReliable || window.wsSend;
  if (!send) return;
  loadCurrentContext();
  _latestRequestId = 'cmds_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  _requestPending = true;
  _lastFetchAt = Date.now();
  send({
    action: 'list_commands',
    projectHash: projectHash(),
    device: state.appState.device || '',
    runtime: runtime(),
    sessionId: state.wsSessionId || '',
    requestId: _latestRequestId,
  });
}

function handleCommandsList(msg) {
  if (!Array.isArray(msg.commands)) return;
  if (_latestRequestId && msg.requestId !== _latestRequestId) return;
  var currentRuntime = runtime();
  if (currentRuntime === 'codex' && msg.runtime !== 'codex') return;
  if (currentRuntime !== 'codex' && msg.runtime && msg.runtime !== currentRuntime) return;
  if (msg.device && msg.device !== (state.appState.device || '')) return;
  if (msg.projectHash && msg.projectHash !== projectHash()) return;
  if (msg.sessionId && state.wsSessionId && msg.sessionId !== state.wsSessionId) return;
  _requestPending = false;
  _commands = msg.commands.slice();
  _skills = Array.isArray(msg.skills) ? msg.skills.slice() : [];
  _contextKey = cacheKey();
  saveCache(_commands, _skills);
  if (currentQuery() !== null) applyFilter();
}

// --- popup UI ---

function popupEl() { return document.getElementById('slash-popup'); }
function listEl() { return document.getElementById('slash-list'); }

function currentQuery() {
  var input = document.getElementById('msg-input');
  var v = input ? input.value : '';
  var slash = /^\/(\S*)$/.exec(v);
  if (slash) return { mode: 'commands', prefix: slash[1].toLowerCase() };
  if (runtime() === 'codex') {
    var skill = /^\$(\S*)$/.exec(v);
    if (skill) return { mode: 'skills', prefix: skill[1].toLowerCase() };
  }
  return null;
}

function applyFilter() {
  var query = currentQuery();
  if (query === null) { closePopup(); return; }
  _mode = query.mode;
  var source = _mode === 'skills' ? _skills : _commands;
  _filtered = source.filter(function (item) {
    return item.name.toLowerCase().indexOf(query.prefix) === 0;
  });
  if (_filtered.length === 0) { closePopup(); return; }
  _selected = 0;
  renderPopup();
}

function renderPopup() {
  var list = listEl();
  if (!list) return;
  var title = popupEl() && popupEl().querySelector('.slash-popup-title');
  if (title) {
    var titleText = _mode === 'skills'
      ? 'Skills'
      : (_mode === 'options' && _parentCommand
        ? '/' + _parentCommand.name
        : 'Slash Commands');
    if (_parentCommand && _mode !== 'commands') {
      title.innerHTML = '<button class="slash-back" type="button" aria-label="Back" title="Back">'
        + '<svg viewBox="0 0 24 24" aria-hidden="true">'
        + '<path d="m15 18-6-6 6-6"></path></svg></button>'
        + '<span>' + esc(titleText) + '</span>';
    } else {
      title.textContent = titleText;
    }
  }
  list.innerHTML = _filtered.map(function (item, i) {
    var prefix = _mode === 'skills' ? '$' : (_mode === 'options' ? '' : '/');
    var label = _mode === 'options' ? (item.label || item.name) : item.name;
    var description = item.description
      ? '<span class="slash-description">' + esc(item.description) + '</span>'
      : '';
    var argumentHint = _mode === 'commands' && item.argumentHint
      ? '<span class="slash-argument-hint">' + esc(item.argumentHint) + '</span>'
      : '';
    return '<div class="slash-item' + (i === _selected ? ' active' : '')
      + (item.disabled ? ' disabled' : '') + '" data-i="' + i + '">'
      + '<span class="slash-name"><span class="slash-command-name">'
      + prefix + esc(label) + '</span>' + argumentHint + '</span>'
      + description
      + '</div>';
  }).join('');
  popupEl().style.display = 'block';
  _open = true;
  scrollSelectedIntoView();
}

function scrollSelectedIntoView() {
  var el = listEl() && listEl().querySelector('.slash-item.active');
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

function closePopup() {
  var p = popupEl();
  if (p) p.style.display = 'none';
  _open = false;
  _mode = 'commands';
  _parentCommand = null;
}

function backToCommands() {
  if (!_open || !_parentCommand || _mode === 'commands') return false;
  var parentName = _parentCommand.name;
  var input = document.getElementById('msg-input');
  _mode = 'commands';
  _parentCommand = null;
  _filtered = _commands.slice();
  _selected = Math.max(0, _filtered.findIndex(function (item) {
    return item.name === parentName;
  }));
  if (input) setInputValue(input, '/');
  renderPopup();
  if (window.updateSendBtn) window.updateSendBtn();
  return true;
}

function selectCommand(i) {
  var item = _filtered[i];
  if (!item) return;
  if (item.disabled) return;
  var input = document.getElementById('msg-input');
  if (_mode === 'options') {
    var parent = _parentCommand;
    if (!parent) { closePopup(); return; }
    if (item.confirm && !window.confirm(item.confirm)) return;
    var value = item.value == null ? item.name : item.value;
    setInputValue(
      input,
      '/' + parent.name + (value ? ' ' + value : '') + (item.behavior === 'compose' ? ' ' : ''),
    );
    closePopup();
    if (item.behavior !== 'compose' && window.sendMessage) window.sendMessage();
    if (window.updateSendBtn) window.updateSendBtn();
    return;
  }
  if (_mode === 'skills') {
    if (input) setInputValue(input, '$' + item.name + ' ');
    closePopup();
    if (window.updateSendBtn) window.updateSendBtn();
    return;
  }
  if (item.behavior === 'picker' && item.picker === 'skills') {
    _mode = 'skills';
    _parentCommand = item;
    if (input) setInputValue(input, '$');
    _filtered = _skills.slice();
    _selected = 0;
    if (_filtered.length) renderPopup();
    else closePopup();
    if (window.updateSendBtn) window.updateSendBtn();
    return;
  }
  if (item.behavior === 'picker') {
    _mode = 'options';
    _parentCommand = item;
    _filtered = Array.isArray(item.options) ? item.options.slice() : [];
    _selected = 0;
    if (_filtered.length) renderPopup();
    else closePopup();
    return;
  }
  if (item.behavior === 'client') {
    runClientAction(item, input);
    closePopup();
    return;
  }
  if (item.behavior === 'confirm' && item.confirm && !window.confirm(item.confirm)) {
    return;
  }
  if (input) {
    setInputValue(input, '/' + item.name + (item.behavior === 'compose' ? ' ' : ''));
  }
  closePopup();
  if (item.behavior !== 'compose' && window.sendMessage) window.sendMessage();
  if (window.updateSendBtn) window.updateSendBtn();
}

function runClientAction(item, input) {
  if (item.clientAction === 'mention') {
    setInputValue(input, '@');
  } else if (item.clientAction === 'new' || item.clientAction === 'clear') {
    var project = state.appState.project;
    if (project && window.startNewSession) window.startNewSession(project.hash);
  } else if (item.clientAction === 'resume' || item.clientAction === 'exit') {
    if (window.navigateUp) window.navigateUp();
  } else {
    setInputValue(input, '/' + item.name);
    if (window.sendMessage) window.sendMessage();
  }
  if (window.updateSendBtn) window.updateSendBtn();
}

function setInputValue(input, value) {
  input.value = value;
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
  input.focus();
}

// --- wiring ---

function onInput() {
  var query = currentQuery();
  if (query !== null) loadCurrentContext();
  if (query !== null && ((_commands.length === 0 && _skills.length === 0) || query.prefix === '')) {
    var cached = loadCache();
    _commands = cached.commands;
    _skills = cached.skills;
  }
  var needsRefresh = query !== null
    && !_requestPending
    && (
      (_commands.length === 0 && _skills.length === 0)
      || (query.mode === 'commands' && query.prefix === '' && Date.now() - _lastFetchAt > 2000)
    );
  if (needsRefresh) {
    prefetchCommands();
  }
  applyFilter();
}

// Returns true if the keydown was consumed by the popup.
function onKeydown(e) {
  if (!_open) return false;
  if ((e.key === 'ArrowLeft' || e.key === 'Escape') && backToCommands()) {
    e.preventDefault();
    return true;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _selected = (_selected + 1) % _filtered.length;
    renderPopup();
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    _selected = (_selected - 1 + _filtered.length) % _filtered.length;
    renderPopup();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    selectCommand(_selected);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closePopup();
    return true;
  }
  return false;
}

(function () {
  var input = document.getElementById('msg-input');
  if (!input) return;
  input.addEventListener('input', onInput);
  // Capture phase + stopImmediatePropagation so popup navigation (Enter/Tab/arrows)
  // pre-empts the send-on-Enter handler registered on the same element.
  input.addEventListener('keydown', function (e) {
    // Don't intercept during IME composition — Enter/arrows belong to the input method.
    if (e.isComposing || e.keyCode === 229) return;
    if (onKeydown(e)) e.stopImmediatePropagation();
  }, true);
  var list = listEl();
  if (list) {
    list.addEventListener('mousedown', function (e) {
      var item = e.target.closest('.slash-item');
      if (item) { e.preventDefault(); selectCommand(parseInt(item.dataset.i, 10)); }
    });
  }
  var popup = popupEl();
  if (popup) {
    popup.addEventListener('pointerdown', function (e) {
      if (!e.target.closest('.slash-back')) return;
      e.preventDefault();
      e.stopPropagation();
      backToCommands();
    });
  }
  // Click outside the popup (and outside the input) closes it — like CC.
  document.addEventListener('pointerdown', function (e) {
    if (!_open) return;
    if (e.target.closest('#slash-popup') || e.target === input) return;
    closePopup();
  });
})();

Object.assign(window, {
  prefetchCommands: prefetchCommands,
  handleCommandsList: handleCommandsList,
  closeSlashPopup: closePopup,
});
