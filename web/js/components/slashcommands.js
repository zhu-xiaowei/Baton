// Slash-command autocomplete: type "/" at the start of the input to pick a
// command (custom commands + skills + enabled-plugin commands/skills), scanned
// live by the bridge. Cached per-project in localStorage; selection sends immediately.
import { state } from '../state.js';

// Cache split: global commands (user/plugin/builtin) are shared across all
// projects on a device → stored once per DEVICE. Project commands (source
// 'project') are project-specific → stored per PROJECT. The "/" menu shows the
// union. This means a brand-new project dir still gets the global commands
// instantly from the device cache (no per-project request needed).
var CACHE_GLOBAL = 'apeek_cmds:g:';   // + deviceName
var CACHE_PROJECT = 'apeek_cmds:p:';  // + projectHash

var _commands = [];     // current command list shown/filtered against
var _filtered = [];     // commands matching the current "/prefix"
var _selected = 0;      // highlighted index in _filtered
var _open = false;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function projectHash() {
  var project = state.appState.project;
  return state.wsProjectHash || (project && project.hash) || '';
}

function readKey(key) {
  try { var raw = localStorage.getItem(key); if (raw) return JSON.parse(raw); } catch (e) {}
  return [];
}

// Union of device-global cache + current-project cache, deduped + sorted.
function loadCache() {
  var device = state.appState.device || '';
  var h = projectHash();
  var merged = readKey(CACHE_GLOBAL + device).concat(h ? readKey(CACHE_PROJECT + h) : []);
  var seen = {}, out = [];
  for (var i = 0; i < merged.length; i++) {
    if (merged[i] && merged[i].name && !seen[merged[i].name]) { seen[merged[i].name] = 1; out.push(merged[i]); }
  }
  out.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return out;
}

// Split the bridge's reply into global vs project and cache each separately.
function saveCache(commands) {
  try {
    var device = state.appState.device || '';
    var h = projectHash();
    var global = [], project = [];
    for (var i = 0; i < commands.length; i++) {
      (commands[i].source === 'project' ? project : global).push(commands[i]);
    }
    if (device) localStorage.setItem(CACHE_GLOBAL + device, JSON.stringify(global));
    if (h) localStorage.setItem(CACHE_PROJECT + h, JSON.stringify(project));
  } catch (e) {}
}

// Fire a fresh scan request to the bridge (response → handleCommandsList).
function prefetchCommands() {
  if (!window.wsSend) return;
  window.wsSend({
    action: 'list_commands',
    projectHash: projectHash(),
    device: state.appState.device || '',
    requestId: 'cmds_' + Date.now(),
  });
}

function handleCommandsList(msg) {
  if (!Array.isArray(msg.commands)) return;
  saveCache(msg.commands);
  _commands = loadCache(); // re-read merged global+project union (deduped, sorted)
  if (_open) applyFilter(); // live-refresh popup if it's currently showing
}

// --- popup UI ---

function popupEl() { return document.getElementById('slash-popup'); }
function listEl() { return document.getElementById('slash-list'); }

function currentPrefix() {
  var input = document.getElementById('msg-input');
  var v = input ? input.value : '';
  // Only a leading "/command" (no spaces yet) triggers the popup.
  var m = /^\/(\S*)$/.exec(v);
  return m ? m[1].toLowerCase() : null;
}

function applyFilter() {
  var prefix = currentPrefix();
  if (prefix === null) { closePopup(); return; }
  _filtered = _commands.filter(function (c) {
    return c.name.toLowerCase().indexOf(prefix) === 0;
  });
  if (_filtered.length === 0) { closePopup(); return; }
  _selected = 0;
  renderPopup();
}

function renderPopup() {
  var list = listEl();
  if (!list) return;
  list.innerHTML = _filtered.map(function (c, i) {
    return '<div class="slash-item' + (i === _selected ? ' active' : '') + '" data-i="' + i + '">'
      + '<span class="slash-name">/' + esc(c.name) + '</span>'
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
}

function selectCommand(i) {
  var cmd = _filtered[i];
  if (!cmd) return;
  var input = document.getElementById('msg-input');
  if (input) {
    input.value = '/' + cmd.name;
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }
  closePopup();
  // Selection sends immediately.
  if (window.sendMessage) window.sendMessage();
  if (window.updateSendBtn) window.updateSendBtn();
}

// --- wiring ---

function onInput() {
  // Read from cache on every "/" trigger so a project switch picks up the new
  // project's commands immediately (cache read is a cheap localStorage hit).
  var prefix = currentPrefix();
  if (prefix !== null && (_commands.length === 0 || prefix === '')) _commands = loadCache();
  applyFilter();
}

// Returns true if the keydown was consumed by the popup.
function onKeydown(e) {
  if (!_open) return false;
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
    if (onKeydown(e)) e.stopImmediatePropagation();
  }, true);
  var list = listEl();
  if (list) {
    list.addEventListener('mousedown', function (e) {
      var item = e.target.closest('.slash-item');
      if (item) { e.preventDefault(); selectCommand(parseInt(item.dataset.i, 10)); }
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
