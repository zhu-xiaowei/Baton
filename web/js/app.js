// App state, routing, page loading
import { state } from './state.js';

var _navVersion = 0;

// Stubs replaced when loadViewerLibs() resolves — needed on the device-list path.
if (typeof window.disconnectWs !== 'function') window.disconnectWs = function () {};
if (typeof window.updateSpinner !== 'function') window.updateSpinner = function () {};

function osName(os) {
  return { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[os] || os || 'unknown';
}

function timeAgo(iso) {
  var diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return Math.floor(diff / 86400000) + 'd ago';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

// ---- Batch-delete selection ----
// Checkbox markup prepended to each item in select mode (CSS slides it in from the left).
function selectBox(id) {
  var on = state.selected.has(id);
  return '<span class="sel-box' + (on ? ' on' : '') + '" data-selid="' + esc(id) + '">'
    + (on ? '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M13 4L6 11l-3-3" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '')
    + '</span>';
}

// Toggle select mode by mutating the live DOM (add/remove the checkbox column) —
// no list re-fetch/re-render, so entering/leaving doesn't flash.
function applySelectModeDom() {
  var list = document.querySelector('.list');
  if (!list) return;
  list.classList.toggle('select-mode', state.selectMode);
  list.querySelectorAll('.item[data-id]').forEach(function (item) {
    var existing = item.querySelector(':scope > .sel-box');
    if (state.selectMode) {
      if (!existing) item.insertAdjacentHTML('afterbegin', selectBox(item.getAttribute('data-id')));
    } else if (existing) {
      existing.remove();
    }
  });
}

function enterSelectMode(type, firstId) {
  state.selectMode = true;
  state.selectType = type;
  state.selected = new Set(firstId ? [firstId] : []);
  applySelectModeDom();
  updateBreadcrumb();
}

function exitSelectMode() {
  state.selectMode = false;
  state.selectType = null;
  state.selected = new Set();
  applySelectModeDom();
  updateBreadcrumb();
}

// Toggle one item's selection by mutating just its checkbox — no list re-fetch/re-render.
function toggleSelected(id) {
  var on = !state.selected.has(id);
  if (on) state.selected.add(id); else state.selected.delete(id);
  var box = document.querySelector('.list.select-mode .item[data-id="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] .sel-box');
  if (box) {
    box.classList.toggle('on', on);
    box.innerHTML = on ? '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M13 4L6 11l-3-3" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '';
  }
  updateBreadcrumb(); // refresh the Delete count only
}

// Long-press vs text-selection: a press that stays put ~500ms → select mode; any
// move >10px cancels the timer so the browser's native text selection takes over.
// In select mode a click toggles the item (capture handler beats the baked nav onclick).
function attachLongPress(container, type) {
  var timer = null, sx = 0, sy = 0, targetId = null, justLongPressed = false;
  var clear = function () { if (timer) { clearTimeout(timer); timer = null; } targetId = null; };
  container.addEventListener('pointerdown', function (e) {
    if (state.selectMode) return;
    var item = e.target.closest && e.target.closest('.item[data-id]');
    if (!item) return;
    sx = e.clientX; sy = e.clientY; targetId = item.getAttribute('data-id');
    timer = setTimeout(function () {
      timer = null;
      if (targetId) { e.preventDefault && e.preventDefault(); justLongPressed = true; enterSelectMode(type, targetId); }
    }, 500);
  });
  container.addEventListener('pointermove', function (e) {
    if (!timer) return;
    if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) clear();
  });
  container.addEventListener('pointerup', clear);
  container.addEventListener('pointercancel', clear);
  container.addEventListener('click', function (e) {
    if (!state.selectMode) return;
    e.preventDefault(); e.stopPropagation(); // beat the item's baked navigation onclick
    // The pointerup after a long-press fires a click; swallow it (selection already made).
    if (justLongPressed) { justLongPressed = false; return; }
    var item = e.target.closest && e.target.closest('.item[data-id]');
    if (item) toggleSelected(item.getAttribute('data-id'));
  }, true);
}

// Unified 3-state (running / needs_input / completed); legacy idle/stopped/unknown → Done.
function statusLabel(status) {
  if (status === 'running') return 'Running';
  if (status === 'needs_input') return 'Needs input';
  return 'Done';
}

// needs_input reuses the amber .badge.idle style; Done reuses the grey .badge.stopped (quiet terminal state).
function statusClass(status) {
  if (status === 'running') return 'running';
  if (status === 'needs_input') return 'idle';
  return 'stopped';
}

function showStats() {}  // no-op, stats bar removed

function showWsBanner(status) {
  var existing = document.getElementById('ws-banner');
  if (status === 'connected' || status === '') {
    if (existing) existing.remove();
    return;
  }
  var content = document.getElementById('content');
  if (!content) return;
  if (!existing) {
    content.insertAdjacentHTML('afterbegin', '<div id="ws-banner" class="ws-banner"></div>');
    existing = document.getElementById('ws-banner');
  }
  if (status === 'reconnecting') {
    existing.className = 'ws-banner warn';
    existing.textContent = 'Reconnecting...';
  } else {
    existing.className = 'ws-banner error';
    existing.textContent = 'Disconnected';
  }
}

function navHref(view, params) {
  if (view === 'devices') return '#/';
  if (view === 'projects') return '#/' + encodeURIComponent(params.device);
  if (view === 'sessions') return '#/' + encodeURIComponent(params.device) + '/' + encodeURIComponent(params.projectHash);
  return '#/';
}

function updateBreadcrumb() {
  var el = document.getElementById('breadcrumb');
  var parts = [];
  if (state.appState.device) {
    parts.push('<a href="' + navHref('projects', {device: state.appState.device}) + '" onclick="loadProjects(\'' + esc(state.appState.device) + '\');return false;">' + esc(state.appState.device) + '</a>');
  }
  if (state.appState.project) {
    parts.push('<a href="' + navHref('sessions', {device: state.appState.device, projectHash: state.appState.project.hash}) + '" onclick="loadSessions(\'' + esc(state.appState.device) + '\',\'' + esc(state.appState.project.hash) + '\',\'' + esc(state.appState.project.name) + '\');return false;">' + esc(state.appState.project.name) + '</a>');
  }
  if (state.appState.session) {
    var label = state.appState.sessionPreview || state.appState.session.slice(0, 8) + '...';
    parts.push('<span>' + esc(label) + '</span>');
  }
  var _addSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  var _gearHtml = '<a href="setup.html" class="top-gear" title="Settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></a>';
  var topRight = document.getElementById('top-right');
  if (state.selectMode) {
    var n = state.selected.size;
    topRight.innerHTML = '<button class="text-btn" onclick="exitSelectMode()">Cancel</button>'
      + '<button class="text-btn danger" ' + (n ? '' : 'disabled') + ' onclick="openDeleteModal()">Delete' + (n ? '<span class="sel-count">' + n + '</span>' : '') + '</button>';
  } else if (state.appState.project) {
    topRight.innerHTML = '<button class="new-session-btn" onclick="startNewSession(\'' + esc(state.appState.project.hash) + '\')" title="New Session">' + _addSvg + '</button>';
  } else if (state.appState.device && !state.appState.project) {
    topRight.innerHTML = '<button class="new-session-btn" onclick="createNewProject()" title="New Project">' + _addSvg + '</button>';
  } else {
    topRight.innerHTML = _gearHtml;
  }
  var titleHtml = '';
  if (state.appState.session) {
    parts.pop();
    var titleText = esc(state.appState.sessionPreview || state.appState.session.slice(0, 8) + '...');
    var agentMark = state.appState.isAgent ? ' <span class="badge agent">Agent</span>' : '';
    titleHtml = '<span class="breadcrumb-sep">/</span><span class="breadcrumb-title">' + titleText + agentMark + '</span>';
  }
  el.innerHTML = '<div class="breadcrumb-nav" onclick="toggleBreadcrumbExpand(this)">'
    + parts.join('<span class="breadcrumb-sep">/</span>') + titleHtml
    + '</div>';
  el.style.display = parts.length > 0 ? 'flex' : 'none';
}

function toggleBreadcrumbExpand(nav) {
  nav.classList.toggle('expanded');
}

function showInputBar(visible) {
  var bar = document.getElementById('input-bar');
  bar.style.display = visible ? 'flex' : 'none';
  if (visible && typeof initVoiceButton === 'function') initVoiceButton();
  if (!visible) {
    if (typeof dismissPermissionPrompt === 'function') dismissPermissionPrompt();
    if (typeof window.closeSlashPopup === 'function') window.closeSlashPopup();
    document.getElementById('scroll-bottom-btn').classList.remove('visible');
    document.body.classList.remove('new-session');
    // Restore input-bar to body if it was moved into #content
    if (bar.parentElement !== document.body) document.body.appendChild(bar);
    state.wsRunning = false;
    updateSpinner();
  }
}

function saveNav() {
  sessionStorage.setItem('agentpeek-nav', JSON.stringify(state.appState));
}

var _chevron = '<svg class="collapse-arrow" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5"/></svg>';

function toggleRecentAgents() {
  var grid = document.getElementById('recent-agents-grid');
  var title = grid && grid.previousElementSibling;
  if (!grid) return;
  var show = grid.style.display === 'none';
  grid.style.display = show ? '' : 'none';
  if (title) title.classList.toggle('expanded', show);
  localStorage.setItem('apeek_raCollapsed', show ? '0' : '1');
}

// ---- Active session card click ----
function openActiveSession(el) {
  var d = el.dataset;
  state.appState = {
    device: d.device,
    project: { hash: d.phash, name: d.pname },
    session: null,
    sessionPreview: '',
    isAgent: d.isagent === 'true'
  };
  loadMessages(d.sid, d.preview, d.status);
}

function openSession(el) {
  state.appState.isAgent = el.dataset.isagent === 'true';
  loadMessages(el.dataset.sid, el.dataset.preview, el.dataset.status);
}

var _revealedSessions = new Set();
function maybeRevealStuckAgent(sessionId) {
  if (!state.appState.isAgent) return;
  if (document.getElementById('permission-prompt')) return;
  if (_revealedSessions.has(sessionId)) return;
  _revealedSessions.add(sessionId);
  ensureWsAndSend({ action: 'reveal_agent', sessionId: sessionId, device: state.appState.device || '' });
}

function shortModel(m) {
  return (m || 'unknown').replace(/^claude-/, '');
}

// ---- Devices ----
async function loadDevices() {
  var myNav = ++_navVersion;
  if (state.selectMode) { state.selectMode = false; state.selectType = null; state.selected = new Set(); }
  state.appState = { device: null, project: null, session: null, sessionPreview: '' };
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  var content = document.getElementById('content');

  // Reuse inline shell render only on the first call — the one right after inline shell paints.
  // __preload is consumed (set to null) after first call, so subsequent logo clicks always re-render.
  var preload = window.__preload;
  var reuseInline = !!preload && !!(document.getElementById('devices-section') || document.getElementById('active-section'));
  if (preload) window.__preload = null;

  if (!reuseInline) {
    content.innerHTML = '<div class="section-title">Active Sessions</div>'
      + '<div id="active-section" class="active-grid">' + skeletonCards(4) + '</div>'
      + '<div id="recent-agents-section"></div>'
      + '<div class="section-title">Devices</div>'
      + '<div id="devices-section" class="list">' + skeletonItems(2) + '</div>';
  }

  var activePromise = (preload && preload.active) || api('/api/bridge/active-sessions');
  var devicesPromise = (preload && preload.devices) || api('/api/bridge/devices');

  if (reuseInline) {
    Promise.resolve(devicesPromise).then(function (devData) {
      if (devData && devData.devices) devData.devices.forEach(function (d) { state.deviceOnlineMap[d.deviceName] = d.online; });
    }).catch(function () {});
    return;
  }

  // Fire both independently
  Promise.resolve(activePromise).then(function (activeData) {
    if (_navVersion !== myNav) return;
    var el = document.getElementById('active-section');
    var titleEl = el && el.previousElementSibling;
    if (!el) return;
    var hasActive = activeData.sessions && activeData.sessions.length > 0;
    if (!hasActive) {
      el.remove();
      if (titleEl) titleEl.remove();
    }
    if (hasActive && titleEl) titleEl.textContent = 'Active Sessions (' + activeData.sessions.length + ')';
    if (hasActive) el.innerHTML = (activeData.sessions).map(function (s) {
      var agentBadge = s.isAgent ? '<span class="badge agent">Agent</span>' : '';
      var sLabel = statusLabel(s.status);
      var sClass = statusClass(s.status);
      var title = s.isAgent && s.agentName ? s.agentName : (s.preview || 'No preview');
      var detail = s.status === 'needs_input' && s.agentDetail ? s.agentDetail : '';
      return '<div class="active-card ' + esc(sClass) + '"'
        + ' data-sid="' + esc(s.sessionId) + '"'
        + ' data-preview="' + esc(s.preview || '') + '"'
        + ' data-status="' + esc(s.status) + '"'
        + ' data-device="' + esc(s.deviceName) + '"'
        + ' data-phash="' + esc(s.projectHash) + '"'
        + ' data-pname="' + esc(s.projectName) + '"'
        + ' data-isagent="' + (s.isAgent ? 'true' : '') + '"'
        + ' onclick="openActiveSession(this)">'
        + '<div class="card-header"><span class="card-project">' + esc(s.projectName) + '</span><span class="card-badges">' + agentBadge + '<span class="badge ' + esc(sClass) + '">' + sLabel + '</span></span></div>'
        + '<div class="card-title"><span class="card-title-text">' + esc(title) + '</span>' + (detail ? '<span class="card-detail">' + esc(detail) + '</span>' : '') + '</div>'
        + '<div class="card-bottom"><span class="card-device">' + esc(s.deviceName) + '</span><span class="card-time">' + timeAgo(s.lastActive) + '</span></div>'
        + '</div>';
    }).join('');

    // Completed Sessions section — the 20 most recently finished sessions (any type).
    var raSection = document.getElementById('recent-agents-section');
    if (raSection && activeData.recentSessions && activeData.recentSessions.length > 0) {
      var collapsed = localStorage.getItem('apeek_raCollapsed') !== '0';
      raSection.innerHTML = '<div class="section-title collapsible' + (collapsed ? '' : ' expanded') + '" onclick="toggleRecentAgents()">'
        + 'Completed Sessions (' + activeData.recentSessions.length + ') ' + _chevron + '</div>'
        + '<div class="active-grid" id="recent-agents-grid" style="' + (collapsed ? 'display:none' : '') + '">'
        + activeData.recentSessions.map(function (s) {
          var title = s.isAgent && s.agentName ? s.agentName : (s.preview || 'No preview');
          var agentBadge = s.isAgent ? '<span class="badge agent">Agent</span>' : '';
          return '<div class="active-card stopped"'
            + ' data-sid="' + esc(s.sessionId) + '"'
            + ' data-preview="' + esc(s.preview || '') + '"'
            + ' data-status="' + esc(s.status) + '"'
            + ' data-device="' + esc(s.deviceName) + '"'
            + ' data-phash="' + esc(s.projectHash) + '"'
            + ' data-pname="' + esc(s.projectName) + '"'
            + ' data-isagent="' + (s.isAgent ? 'true' : '') + '"'
            + ' onclick="openActiveSession(this)">'
            + '<div class="card-header"><span class="card-project">' + esc(s.projectName) + '</span><span class="card-badges">' + agentBadge + '<span class="badge stopped">Done</span></span></div>'
            + '<div class="card-title"><span class="card-title-text">' + esc(title) + '</span></div>'
            + '<div class="card-bottom"><span class="card-device">' + esc(s.deviceName) + '</span><span class="card-time">' + timeAgo(s.lastActive) + '</span></div>'
            + '</div>';
        }).join('') + '</div>';
    }
  }).catch(function () {
    if (_navVersion !== myNav) return;
    var el = document.getElementById('active-section');
    var titleEl = el && el.previousElementSibling;
    if (el) el.remove();
    if (titleEl) titleEl.remove();
  });

  Promise.resolve(devicesPromise).then(function (devData) {
    if (_navVersion !== myNav) return;
    var el = document.getElementById('devices-section');
    var titleEl = el && el.previousElementSibling;
    if (!el) return;
    if (devData.devices.length === 0) {
      el.remove();
      if (titleEl) titleEl.remove();
      return;
    }
    if (titleEl) titleEl.textContent = 'Devices (' + devData.devices.length + ')';
    devData.devices.forEach(function (d) { state.deviceOnlineMap[d.deviceName] = d.online; });
    el.innerHTML = devData.devices.map(function (d) {
      var rc = d.runningCount || 0, ic = d.needsInputCount || 0;
      var dotClass = d.online ? 'online' : 'offline';
      return '<div class="item" onclick="loadProjects(\'' + esc(d.deviceName) + '\')">'
        + '<div class="item-top"><span class="device-dot ' + dotClass + '"></span><span class="title">' + esc(d.deviceName) + '</span><span class="item-time">' + timeAgo(d.lastActive) + '</span></div>'
        + '<div class="item-bottom"><span class="subtitle">' + osName(d.os) + ' &middot; ' + d.projectCount + ' projects</span><span class="item-status">' + rc + ' running &middot; ' + ic + ' needs input</span></div>'
        + '</div>';
    }).join('');
    showStats(devData.devices.length + ' device(s)');
  }).catch(function (e) {
    if (_navVersion !== myNav) return;
    var el = document.getElementById('devices-section');
    if (el) el.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  });
}

// ---- Projects ----
async function loadProjects(device) {
  var myNav = ++_navVersion;
  if (state.selectMode) { state.selectMode = false; state.selectType = null; state.selected = new Set(); }
  state.appState = { device: device, project: null, session: null, sessionPreview: '' };
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="list">' + skeletonItems(4) + '</div>';

  try {
    var data = await api('/api/bridge/projects', { device: device });
    if (_navVersion !== myNav) return;
    var sel = state.selectMode && state.selectType === 'project';
    content.innerHTML = '<div class="list' + (sel ? ' select-mode' : '') + '">' + data.projects.map(function (p) {
      var rc = p.runningCount || 0, ic = p.needsInputCount || 0;
      var projHref = '#/' + encodeURIComponent(device) + '/' + encodeURIComponent(p.projectHash);
      // Nav onclick always baked; in select mode the capture click handler intercepts + toggles.
      var onclick = 'loadSessions(\'' + esc(device) + '\',\'' + esc(p.projectHash) + '\',\'' + esc(p.projectName) + '\');return false;';
      return '<a class="item" data-id="' + esc(p.projectHash) + '" href="' + projHref + '" onclick="' + onclick + '">'
        + (sel ? selectBox(p.projectHash) : '')
        + '<div class="item-main"><div class="item-top"><span class="title">' + esc(p.projectName) + '</span><span class="item-time">' + timeAgo(p.lastActive) + '</span></div>'
        + '<div class="subtitle">' + esc(p.projectPath) + '</div>'
        + '<div class="item-bottom"><span class="meta-left">' + p.sessionCount + ' sessions</span><span class="item-status">' + rc + ' running &middot; ' + ic + ' needs input</span></div></div>'
        + '</a>';
    }).join('') + '</div>';
    attachLongPress(content.querySelector('.list'), 'project');
    showStats(data.projects.length + ' project(s)');
  } catch (e) { if (_navVersion === myNav) content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// ---- Sessions ----
async function loadSessions(device, projectHash, projectName) {
  var myNav = ++_navVersion;
  if (state.selectMode) { state.selectMode = false; state.selectType = null; state.selected = new Set(); }
  state.appState = { device: device, project: { hash: projectHash, name: projectName || projectHash }, session: null, sessionPreview: '' };
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="list">' + skeletonItems(5) + '</div>';

  try {
    var data = await api('/api/bridge/sessions', { device: device, project: projectHash });
    if (_navVersion !== myNav) return;
    var sel = state.selectMode && state.selectType === 'session';
    content.innerHTML = '<div class="list' + (sel ? ' select-mode' : '') + '">'
      + data.sessions.map(function (s) {
      var sessionHref = '#/' + encodeURIComponent(device) + '/' + encodeURIComponent(projectHash) + '/' + s.sessionId;
      var agentBadge = s.isAgent ? '<span class="badge agent">Agent</span> ' : '';
      var sLabel = statusLabel(s.status);
      var sClass = statusClass(s.status);
      var statusBadge = '<span class="badge ' + sClass + '">' + sLabel + '</span>';
      var title = s.isAgent && s.agentName ? s.agentName : (s.preview || 'No preview');
      var detailHtml = s.status === 'needs_input' && s.agentDetail ? '<span class="item-detail">' + esc(s.agentDetail) + '</span>' : '';
      // Nav onclick always baked; in select mode the capture click handler intercepts + toggles.
      var onclick = 'if(window.getSelection().toString())return false;openSession(this);return false;';
      return '<a class="item" data-id="' + esc(s.sessionId) + '" href="' + sessionHref + '" data-sid="' + esc(s.sessionId) + '" data-preview="' + esc(s.preview || '') + '" data-status="' + esc(s.status || '') + '" data-isagent="' + (s.isAgent ? 'true' : '') + '" onclick="' + onclick + '">'
        + (sel ? selectBox(s.sessionId) : '')
        + '<div class="item-main"><div class="item-top"><span class="title">' + agentBadge + statusBadge + ' ' + esc(title) + '</span><span class="item-time">' + timeAgo(s.lastActive) + '</span></div>'
        + '<div class="meta">' + esc(s.model || 'unknown model') + '<span class="meta-sid"> &middot; ' + s.sessionId.slice(0, 8) + '</span> &middot; ' + formatSize(s.size) + detailHtml + '</div></div>'
        + '</a>';
    }).join('') + '</div>';
    attachLongPress(content.querySelector('.list'), 'session');
    showStats(data.sessions.length + ' session(s)');
  } catch (e) { if (_navVersion === myNav) content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

function createNewProject() {
  var modal = document.getElementById('newProjectModal');
  var input = document.getElementById('newProjectInput');
  var err = document.getElementById('newProjectError');
  var agentCb = document.getElementById('newProjectAsAgent');
  input.value = '';
  err.textContent = '';
  if (agentCb) agentCb.checked = false; // always default OFF; not persisted
  modal.style.display = 'flex';
  setTimeout(function () { input.focus(); }, 100);
}

function closeNewProjectModal() {
  if (state._pendingCreatePath) {
    state._pendingCreatePath = null;
    disconnectWs();
  }
  var modal = document.getElementById('newProjectModal');
  modal.style.display = 'none';
  var input = document.getElementById('newProjectInput');
  var btn = modal.querySelector('.modal-btn.confirm');
  if (input) input.disabled = false;
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || 'Create'; }
}

async function submitNewProject() {
  var input = document.getElementById('newProjectInput');
  var err = document.getElementById('newProjectError');
  var btn = document.querySelector('#newProjectModal .modal-btn.confirm');
  var projectPath = input.value.trim();
  if (!projectPath) { err.textContent = 'Path cannot be empty'; return; }
  err.textContent = '';
  state._pendingCreatePath = projectPath;
  // Loading state: disable inputs, show spinner on button
  input.disabled = true;
  btn.disabled = true;
  btn.dataset.origText = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>Creating';
  await window.loadViewerLibs();
  var asAgent = !!(document.getElementById('newProjectAsAgent') && document.getElementById('newProjectAsAgent').checked);
  ensureWsAndSend({ action: 'create_project', projectPath: projectPath, device: state.appState.device || '', asAgent: asAgent });
}

var _deleteCountdownTimer = null;

function openDeleteModal() {
  if (!state.selected.size) return;
  var modal = document.getElementById('deleteModal');
  var n = state.selected.size;
  var isProject = state.selectType === 'project';
  var noun = (isProject ? 'project' : 'session') + (n > 1 ? 's' : '');
  document.getElementById('deleteModalTitle').textContent = 'Delete ' + n + ' ' + noun + '?';
  document.getElementById('deleteModalDesc').textContent = isProject
    ? 'This removes ' + (n > 1 ? 'these projects' : 'this project') + ' and all their session records from the list. Data on the device is kept unless you check below.'
    : 'This removes ' + (n > 1 ? 'these sessions' : 'this session') + ' from the list. Data on the device is kept unless you check below.';
  document.getElementById('deleteFilesCb').checked = false;
  var err = document.getElementById('deleteError'); if (err) err.textContent = '';
  resetDeleteBtn();
  modal.style.display = 'flex';
}

function resetDeleteBtn() {
  if (_deleteCountdownTimer) { clearInterval(_deleteCountdownTimer); _deleteCountdownTimer = null; }
  var btn = document.getElementById('deleteConfirmBtn');
  btn.disabled = false; btn.textContent = 'Delete';
}

// Checking "delete original data" arms a 5s countdown before Delete is clickable (guards misfires).
function onDeleteFilesToggle() {
  var btn = document.getElementById('deleteConfirmBtn');
  if (_deleteCountdownTimer) { clearInterval(_deleteCountdownTimer); _deleteCountdownTimer = null; }
  if (!document.getElementById('deleteFilesCb').checked) { btn.disabled = false; btn.textContent = 'Delete'; return; }
  var left = 5;
  btn.disabled = true; btn.textContent = 'Delete (' + left + ')';
  _deleteCountdownTimer = setInterval(function () {
    left--;
    if (left <= 0) { clearInterval(_deleteCountdownTimer); _deleteCountdownTimer = null; btn.disabled = false; btn.textContent = 'Delete'; }
    else btn.textContent = 'Delete (' + left + ')';
  }, 1000);
}

function closeDeleteModal() {
  resetDeleteBtn();
  document.getElementById('deleteModal').style.display = 'none';
}

// Single delete entry point: ① delete DDB rows (REST, authoritative) then, if opted
// in, ② ask the bridge to delete on-disk jsonl and await its result. Returns the
// combined { ddb, files } outcome so the caller has the final status in one place.
async function performDelete(device, isProject, ids, deleteFiles) {
  var body = { deviceName: device };
  if (isProject) body.projectHashes = ids; else body.sessionIds = ids;
  await apiPost('/api/bridge/delete', body);
  var filesResult = null;
  if (deleteFiles) {
    await window.loadViewerLibs(); // ensure WS is connected before relying on it
    filesResult = await new Promise(function (resolve) {
      var reqId = 'del-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      window._deleteFilesResolvers = window._deleteFilesResolvers || {};
      var done = false;
      var finish = function (r) { if (done) return; done = true; delete window._deleteFilesResolvers[reqId]; resolve(r); };
      window._deleteFilesResolvers[reqId] = finish;
      ensureWsAndSend(Object.assign({ action: 'delete_files', device: device, requestId: reqId }, isProject ? { projectHashes: ids } : { sessionIds: ids }));
      setTimeout(function () { finish({ ok: false, timeout: true }); }, 8000);
    });
  }
  return { ddb: true, files: filesResult };
}

async function submitDelete() {
  var ids = Array.from(state.selected);
  if (!ids.length) return;
  var device = state.appState.device || '';
  var deleteFiles = !!document.getElementById('deleteFilesCb').checked;
  var isProject = state.selectType === 'project';
  if (_deleteCountdownTimer) { clearInterval(_deleteCountdownTimer); _deleteCountdownTimer = null; }
  var btn = document.getElementById('deleteConfirmBtn');
  btn.disabled = true; btn.dataset.origText = 'Delete'; btn.innerHTML = '<span class="spinner"></span>Deleting';
  var result;
  try {
    result = await performDelete(device, isProject, ids, deleteFiles);
  } catch (e) {
    var err = document.getElementById('deleteError'); if (err) err.textContent = 'Delete failed: ' + e.message;
    btn.disabled = false; btn.textContent = 'Delete';
    return;
  }
  closeDeleteModal();
  if (isProject) loadProjects(device);
  else loadSessions(state.appState.device, state.appState.project.hash, state.appState.project.name);
  // DDB rows are gone (list already refreshed); warn if the bridge never confirmed the disk delete.
  if (deleteFiles && result.files && result.files.timeout) {
    showStats('Removed from list; device did not confirm file deletion (bridge offline?)');
  }
}

// New-session hero agent checkbox toggled — reflect in breadcrumb + send button.
function onNewAsAgentToggle(checked) {
  state.appState.isAgent = checked;
  updateBreadcrumb();
  if (typeof updateSendBtn === 'function') updateSendBtn();
}

async function startNewSession(projectHash) {
  await window.loadViewerLibs();
  state.appState.session = '__new__';
  state.appState.sessionPreview = 'New Session';
  // Reset tier — else a prior session's ai-title tier (3) blocks this session's first-prompt fallback (tier 1).
  state._titleTier = 0;
  // Default OFF every time (not remembered) — a regular session is already long-run under the pool.
  state.appState.isAgent = false;
  updateBreadcrumb();
  saveNav();
  // Reset WS message state for new session
  state.wsAllMessages = [];
  state.wsMessageCount = 0;
  state.wsRenderedCount = 0;
  state.wsLastTimestamp = '';
  state.wsHasMore = false;
  state.wsOldestTimestamp = '';
  state.wsLoadingOlder = false;
  state.wsSessionId = null;
  state.wsRunning = false;
  state.pendingSentMessages = [];
  state.lastDeliveredSeq = -1;
  if (typeof updateSpinner === 'function') updateSpinner();
  var content = document.getElementById('content');
  // Agent mode: always starts unchecked; choice is not persisted across sessions.
  content.innerHTML =
    '<div class="new-session-hero">'
      + '<div class="hero-logo">🔭</div>'
      + '<div class="hero-title">AgentPeek</div>'
      + '<label class="agent-toggle"><input type="checkbox" id="newAsAgent" onchange="onNewAsAgentToggle(this.checked)">Claude Agents Run in background</label>'
    + '</div>'
    + '<div class="messages" hidden></div>';
  document.body.classList.add('new-session');
  showInputBar(true);
  // Move input-bar into #content so it sits with the hero in centered flex group.
  // Restored to body on first send (see ws.js doSend) or on showInputBar(false).
  var bar = document.getElementById('input-bar');
  if (bar && bar.parentElement !== content) content.appendChild(bar);
  // HTML ships with a stop-icon as #send-btn placeholder; sync to disabled-send for empty input
  if (typeof updateSendBtn === 'function') updateSendBtn();
  connectWs(null, projectHash);
}

// ---- Messages ----
async function loadMessages(sessionId, preview, status) {
  // Update state + breadcrumb before any await — a fast follow-up nav must not be
  // overwritten when this call resumes.
  document.body.classList.remove('new-session');
  var myNav = ++_navVersion;
  state.appState.session = sessionId;
  state.appState.sessionPreview = preview || '';
  _revealedSessions.delete(sessionId);
  // List preview = bridge's getPreview (custom > ai > lastPrompt > firstUser); treat as ai-title tier floor.
  state._titleTier = preview ? 3 : 0;
  state.wsRunning = (status === 'running');
  // Bridge's pane-checked verdict at open time — authoritative for the ambiguous
  // trailing-user case (see deriveRunning). Used by the initial render here and
  // the sync_complete re-render; cleared once real-time frames take over.
  state.wsOpenStatus = status;
  updateBreadcrumb();
  // Skeleton before any await — loadViewerLibs can take a while and the old page would linger.
  var content = document.getElementById('content');
  content.innerHTML = skeletonMessages();
  showInputBar(true);
  await window.loadViewerLibs();
  if (_navVersion !== myNav) return;
  updateSendBtn();

  // 1. Subscribe WS first, then buffer+fetch (shared with reconnect recovery)
  state.wsAllMessages = [];
  state.wsMessageCount = 0;
  state.wsLastTimestamp = '';
  state.wsHasMore = false;
  state.wsOldestTimestamp = '';
  state.wsLoadingOlder = false;
  // Switching sessions: drop the prior session's optimistic bubbles + orphan
  // watermark so they can't match or orphan against this session's messages.
  state.pendingSentMessages = [];
  state.lastDeliveredSeq = -1;
  startWs(sessionId);

  try {
    var t0 = performance.now();
    var result = await bufferAndFetch(sessionId, '');
    if (_navVersion !== myNav) return;
    var latency = Math.round(performance.now() - t0);

    if (state.wsAllMessages.length === 0) {
      if (result.needSync) {
        var online = state.deviceOnlineMap[state.appState.device] !== false;
        content.innerHTML = online
          ? skeletonMessages()
          : '<div class="empty">Bridge offline — no cached messages</div>';
      } else {
        content.innerHTML = '<div class="empty">No messages</div>';
      }
      showInputBar(true);
      saveNav();
      return;
    }

    // Render
    content.innerHTML = '<div class="messages">' + renderMessages(state.wsAllMessages) + '</div>';
    showInputBar(true);

    updateTitleFromMessages();

    // Derive running from the tail. The list `status` is the bridge's
    // pane-checked verdict — authoritative for the ambiguous trailing-user case
    // (a reverted prompt looks 'running' in the stream but the pane is idle).
    state.wsRunning = deriveRunning(state.wsAllMessages, status);
    updateSendBtn();

    // Clamp before scrolling: clamp shrinks long messages, so scrolling first
    // would leave the viewport above the bottom. rAF re-scroll absorbs any
    // post-clamp reflow before paint (replaces the old visible 500ms jump).
    loadImages(content);
    clampOverflow(content.querySelector('.messages'));
    content.scrollTop = content.scrollHeight;
    requestAnimationFrame(function () {
      if (_navVersion !== myNav) return;
      content.scrollTop = content.scrollHeight;
    });
    maybeRevealStuckAgent(sessionId);
    state.wsRenderedCount = state.wsAllMessages.length;
    showStats(state.wsMessageCount + ' messages | ' + latency + 'ms');
  } catch (e) {
    if (_navVersion !== myNav) return;
    state._wsBuffer = null;
    content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>';
  }
  saveNav();
}

// ---- Scroll-to-bottom ----
function scrollToBottom() {
  var el = document.getElementById('content');
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

// Keep scroll-to-bottom button 12px above #input-bar regardless of platform/keyboard/safe-area.
function positionScrollBtn() {
  var bar = document.getElementById('input-bar');
  var btn = document.getElementById('scroll-bottom-btn');
  if (!bar || !btn) return;
  if (bar.offsetHeight === 0 || bar.style.display === 'none') { btn.style.bottom = ''; return; }
  var barTop = bar.getBoundingClientRect().top;
  var offTop = window.visualViewport ? window.visualViewport.offsetTop : 0;
  btn.style.bottom = (document.documentElement.clientHeight - offTop - barTop + 12) + 'px';
}
(function () {
  var bar = document.getElementById('input-bar');
  if (bar && window.ResizeObserver) {
    new ResizeObserver(positionScrollBtn).observe(bar);
  }
  window.addEventListener('resize', positionScrollBtn);
  positionScrollBtn();
})();

(function () {
  var btn = document.getElementById('scroll-bottom-btn');
  var content = document.getElementById('content');

  content.addEventListener('scroll', function () {
    if (!state.appState.session) return;
    var atBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 100;
    btn.classList.toggle('visible', !atBottom);

    // Load older messages when scrolling near top
    if (content.scrollTop < 800 && state.wsHasMore && !state.wsLoadingOlder) {
      loadOlderAndPrepend();
    }
  });

  // Tap top bar to scroll to top (skip Setup/Logout links)
  document.querySelector('.top-bar').addEventListener('click', function (e) {
    if (e.target.closest('.top-action')) return;
    if (state.appState.session) content.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();

async function loadOlderAndPrepend() {
  if (!state.appState.session || state.appState.session === '__new__') return;
  var content = document.getElementById('content');
  var container = content.querySelector('.messages');
  if (!container) return;

  // Show loading indicator at top
  var loader = document.createElement('div');
  loader.className = 'loading-older';
  loader.textContent = 'Loading...';
  container.insertBefore(loader, container.firstChild);

  var prevHeight = content.scrollHeight;

  var msgs = await loadOlderMessages(state.appState.session);
  // Remove loader
  if (loader.parentNode) loader.remove();
  if (!msgs || !msgs.length) return;

  // Render older messages and prepend
  var html = renderMessages(msgs);
  container.insertAdjacentHTML('afterbegin', html);
  loadImages(container);
  clampOverflow(container);

  // Restore scroll position so content doesn't jump
  var newHeight = content.scrollHeight;
  content.scrollTop += (newHeight - prevHeight);
}

// Auto-connect + restore last session
(function () {
  if (!state.KEY) return; // auth guard in index.html handles redirect
  // Inline shell already painted + replayed navigation — skip to avoid clearing its state.
  if (window.__inlineRendered) return;

  // Route immediately so skeleton shows without waiting for any network call
  var nav = sessionStorage.getItem('agentpeek-nav');
  var hash = location.hash.replace(/^#\/?/, '');
  if (hash) {
    history.replaceState(null, '', location.pathname + location.search);
    var seg = hash.split('/').map(decodeURIComponent);
    var hashProjectName = seg[1] ? seg[1].split('-').pop() || seg[1] : '';
    if (seg.length >= 3 && seg[2] && seg[2] !== '__new__') {
      state.appState = { device: seg[0], project: { hash: seg[1], name: hashProjectName }, session: null, sessionPreview: '' };
      loadMessages(seg[2], '');
    } else if (seg.length >= 2 && seg[1]) { loadSessions(seg[0], seg[1], hashProjectName); }
    else if (seg.length >= 1 && seg[0]) { loadProjects(seg[0]); }
    else { loadDevices(); }
  } else if (nav) {
    try {
      var s = JSON.parse(nav);
      if (s.session && s.session !== '__new__') {
        state.appState = { device: s.device, project: s.project, session: null, sessionPreview: '' };
        loadMessages(s.session, s.sessionPreview);
      } else if (s.project) {
        loadSessions(s.device, s.project.hash, s.project.name);
      } else if (s.device) {
        loadProjects(s.device);
      } else {
        loadDevices();
      }
    } catch(e) { loadDevices(); }
  } else {
    loadDevices();
  }
})();

// In Tauri (WKWebView/WebView2) target=_blank can't open a tab, so external links
// would navigate the webview itself. Intercept and hand off to the system browser
// via plugin-opener (scoped to http/https in capabilities). Real browsers keep
// target=_blank and open a tab natively.
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a.ext-link');
  if (!a || !a.href) return;
  if (!(window.isTauri || window.__TAURI_INTERNALS__)) return;
  e.preventDefault();
  import('@tauri-apps/plugin-opener').then(function (m) { m.openUrl(a.href); }).catch(function () {});
});

// Function bridges for inline HTML handlers + legacy IIFE consumers.
// All shared state lives in state.js, not on window.
Object.assign(window, {
  osName, timeAgo, formatSize, esc,
  showStats, showWsBanner, navHref, updateBreadcrumb, toggleBreadcrumbExpand,
  showInputBar, saveNav, openActiveSession, openSession, shortModel,
  loadDevices, loadProjects, loadSessions,
  createNewProject, closeNewProjectModal, submitNewProject,
  exitSelectMode, toggleSelected, openDeleteModal, closeDeleteModal, submitDelete, onDeleteFilesToggle,
  startNewSession, onNewAsAgentToggle, loadMessages, toggleRecentAgents,
  scrollToBottom, positionScrollBtn, loadOlderAndPrepend,
});
