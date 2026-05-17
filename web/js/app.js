// App state, routing, page loading
var appState = { device: null, project: null, session: null, sessionPreview: '' };
var deviceOnlineMap = {};
var _navVersion = 0;

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
  if (appState.device) {
    parts.push('<a href="' + navHref('projects', {device: appState.device}) + '" onclick="loadProjects(\'' + esc(appState.device) + '\');return false;">' + esc(appState.device) + '</a>');
  }
  if (appState.project) {
    parts.push('<a href="' + navHref('sessions', {device: appState.device, projectHash: appState.project.hash}) + '" onclick="loadSessions(\'' + esc(appState.device) + '\',\'' + esc(appState.project.hash) + '\',\'' + esc(appState.project.name) + '\');return false;">' + esc(appState.project.name) + '</a>');
  }
  if (appState.session) {
    var label = appState.sessionPreview || appState.session.slice(0, 8) + '...';
    parts.push('<span>' + esc(label) + '</span>');
  }
  var _addSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  var _gearHtml = '<a href="setup.html" class="top-gear" title="Settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></a>';
  var topRight = document.getElementById('top-right');
  if (appState.project) {
    topRight.innerHTML = '<button class="new-session-btn" onclick="startNewSession(\'' + esc(appState.project.hash) + '\')" title="New Session">' + _addSvg + '</button>';
  } else if (appState.device && !appState.project) {
    topRight.innerHTML = '<button class="new-session-btn" onclick="createNewProject()" title="New Project">' + _addSvg + '</button>';
  } else {
    topRight.innerHTML = _gearHtml;
  }
  var titleHtml = '';
  if (appState.session) {
    parts.pop();
    var titleText = esc(appState.sessionPreview || appState.session.slice(0, 8) + '...');
    titleHtml = '<span class="breadcrumb-sep">/</span><span class="breadcrumb-title">' + titleText + '</span>';
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
  document.getElementById('input-bar').style.display = visible ? 'flex' : 'none';
  if (!visible) { document.getElementById('scroll-bottom-btn').style.display = 'none'; wsRunning = false; updateSpinner(); }
}

function saveNav() {
  sessionStorage.setItem('agentpeek-nav', JSON.stringify(appState));
}

// ---- Active session card click ----
function openActiveSession(el) {
  var d = el.dataset;
  appState = {
    device: d.device,
    project: { hash: d.phash, name: d.pname },
    session: null,
    sessionPreview: ''
  };
  loadMessages(d.sid, d.preview, d.status);
}

function shortModel(m) {
  return (m || 'unknown').replace(/^claude-/, '');
}

// ---- Devices ----
async function loadDevices() {
  var myNav = ++_navVersion;
  appState = { device: null, project: null, session: null, sessionPreview: '' };
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  var content = document.getElementById('content');

  // Skeleton
  content.innerHTML = '<div class="section-title">Active Sessions</div>'
    + '<div id="active-section" class="active-grid">' + skeletonCards(4) + '</div>'
    + '<div class="section-title">Devices</div>'
    + '<div id="devices-section" class="list">' + skeletonItems(2) + '</div>';

  // Fire both independently
  api('/api/bridge/active-sessions').then(function (activeData) {
    if (_navVersion !== myNav) return;
    var el = document.getElementById('active-section');
    var titleEl = el && el.previousElementSibling;
    if (!el) return;
    if (!activeData.sessions || activeData.sessions.length === 0) {
      el.remove();
      if (titleEl) titleEl.remove();
      return;
    }
    if (titleEl) titleEl.textContent = 'Active Sessions (' + activeData.sessions.length + ')';
    el.innerHTML = activeData.sessions.map(function (s) {
      return '<div class="active-card ' + esc(s.status) + '"'
        + ' data-sid="' + esc(s.sessionId) + '"'
        + ' data-preview="' + esc(s.preview || '') + '"'
        + ' data-status="' + esc(s.status) + '"'
        + ' data-device="' + esc(s.deviceName) + '"'
        + ' data-phash="' + esc(s.projectHash) + '"'
        + ' data-pname="' + esc(s.projectName) + '"'
        + ' onclick="openActiveSession(this)">'
        + '<div class="card-header"><span class="card-project">' + esc(s.projectName) + '</span><span class="badge ' + esc(s.status) + '">' + (s.status === 'running' ? 'Running' : 'Idle') + '</span></div>'
        + '<div class="card-title">' + esc(s.preview || 'No preview') + '</div>'
        + '<div class="card-bottom"><span class="card-device">' + esc(s.deviceName) + '</span><span class="card-time">' + timeAgo(s.lastActive) + '</span></div>'
        + '</div>';
    }).join('');
  }).catch(function () {
    if (_navVersion !== myNav) return;
    var el = document.getElementById('active-section');
    var titleEl = el && el.previousElementSibling;
    if (el) el.remove();
    if (titleEl) titleEl.remove();
  });

  api('/api/bridge/devices').then(function (devData) {
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
    devData.devices.forEach(function (d) { deviceOnlineMap[d.deviceName] = d.online; });
    el.innerHTML = devData.devices.map(function (d) {
      var rc = d.runningCount || 0, ic = d.idleCount || 0;
      var dotClass = d.online ? 'online' : 'offline';
      return '<div class="item" onclick="loadProjects(\'' + esc(d.deviceName) + '\')">'
        + '<div class="item-top"><span class="device-dot ' + dotClass + '"></span><span class="title">' + esc(d.deviceName) + '</span><span class="item-time">' + timeAgo(d.lastActive) + '</span></div>'
        + '<div class="item-bottom"><span class="subtitle">' + osName(d.os) + ' &middot; ' + d.projectCount + ' projects</span><span class="item-status">' + rc + ' running &middot; ' + ic + ' idle</span></div>'
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
  appState = { device: device, project: null, session: null, sessionPreview: '' };
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="list">' + skeletonItems(4) + '</div>';

  try {
    var data = await api('/api/bridge/projects', { device: device });
    if (_navVersion !== myNav) return;
    content.innerHTML = '<div class="list">' + data.projects.map(function (p) {
      var rc = p.runningCount || 0, ic = p.idleCount || 0;
      var projHref = '#/' + encodeURIComponent(device) + '/' + encodeURIComponent(p.projectHash);
      return '<a class="item" href="' + projHref + '" onclick="loadSessions(\'' + esc(device) + '\',\'' + esc(p.projectHash) + '\',\'' + esc(p.projectName) + '\');return false;">'
        + '<div class="item-top"><span class="title">' + esc(p.projectName) + '</span><span class="item-time">' + timeAgo(p.lastActive) + '</span></div>'
        + '<div class="subtitle">' + esc(p.projectPath) + '</div>'
        + '<div class="item-bottom"><span class="meta-left">' + p.sessionCount + ' sessions</span><span class="item-status">' + rc + ' running &middot; ' + ic + ' idle</span></div>'
        + '</a>';
    }).join('') + '</div>';
    showStats(data.projects.length + ' project(s)');
  } catch (e) { if (_navVersion === myNav) content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// ---- Sessions ----
async function loadSessions(device, projectHash, projectName) {
  var myNav = ++_navVersion;
  disconnectWs();
  showInputBar(false);
  var content = document.getElementById('content');
  content.innerHTML = '<div class="list">' + skeletonItems(5) + '</div>';

  try {
    var data = await api('/api/bridge/sessions', { device: device, project: projectHash });
    if (_navVersion !== myNav) return;
    appState = { device: device, project: { hash: projectHash, name: projectName || projectHash }, session: null, sessionPreview: '' };
    updateBreadcrumb();
    saveNav();
    content.innerHTML = '<div class="list">'
      + data.sessions.map(function (s) {
      var sessionHref = '#/' + encodeURIComponent(device) + '/' + encodeURIComponent(projectHash) + '/' + s.sessionId;
      return '<a class="item" href="' + sessionHref + '" data-sid="' + esc(s.sessionId) + '" data-preview="' + esc(s.preview || '') + '" data-status="' + esc(s.status || '') + '" onclick="if(window.getSelection().toString())return false;loadMessages(this.dataset.sid, this.dataset.preview, this.dataset.status);return false;">'
        + '<div class="item-top"><span class="title"><span class="badge ' + (s.status || 'stopped') + '">' + (s.status === 'running' ? 'Running' : s.status === 'idle' ? 'Idle' : 'Stopped') + '</span> ' + esc(s.preview || 'No preview') + '</span><span class="item-time">' + timeAgo(s.lastActive) + '</span></div>'
        + '<div class="meta">' + esc(s.model || 'unknown model') + ' &middot; ' + s.sessionId.slice(0, 8) + '... &middot; ' + formatSize(s.size) + '</div>'
        + '</a>';
    }).join('') + '</div>';
    showStats(data.sessions.length + ' session(s)');
  } catch (e) { if (_navVersion === myNav) content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

function createNewProject() {
  var modal = document.getElementById('newProjectModal');
  var input = document.getElementById('newProjectInput');
  var err = document.getElementById('newProjectError');
  input.value = '';
  err.textContent = '';
  modal.style.display = 'flex';
  setTimeout(function () { input.focus(); }, 100);
}

function closeNewProjectModal() {
  if (_pendingCreatePath) {
    _pendingCreatePath = null;
    disconnectWs();
  }
  var modal = document.getElementById('newProjectModal');
  modal.style.display = 'none';
  var input = document.getElementById('newProjectInput');
  var btn = modal.querySelector('.modal-btn.confirm');
  if (input) input.disabled = false;
  if (btn) { btn.disabled = false; btn.textContent = btn.dataset.origText || 'Create'; }
}

function submitNewProject() {
  var input = document.getElementById('newProjectInput');
  var err = document.getElementById('newProjectError');
  var btn = document.querySelector('#newProjectModal .modal-btn.confirm');
  var projectPath = input.value.trim();
  if (!projectPath) { err.textContent = 'Path cannot be empty'; return; }
  err.textContent = '';
  _pendingCreatePath = projectPath;
  // Loading state: disable inputs, show spinner on button
  input.disabled = true;
  btn.disabled = true;
  btn.dataset.origText = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>Creating';
  ensureWsAndSend({ action: 'create_project', projectPath: projectPath, device: appState.device || '' });
}

function startNewSession(projectHash) {
  appState.session = '__new__';
  appState.sessionPreview = 'New Session';
  updateBreadcrumb();
  saveNav();
  // Reset WS message state for new session
  wsAllMessages = [];
  wsMessageCount = 0;
  wsRenderedCount = 0;
  wsLastTimestamp = '';
  wsHasMore = false;
  wsOldestTimestamp = '';
  wsLoadingOlder = false;
  wsSessionId = null;
  pendingSentMessages = [];
  var content = document.getElementById('content');
  content.innerHTML = '<div class="messages"><div class="empty">Send a message to start a new session</div></div>';
  showInputBar(true);
  connectWs(null, projectHash);
}

// ---- Messages ----
async function loadMessages(sessionId, preview, status) {
  var myNav = ++_navVersion;
  appState.session = sessionId;
  appState.sessionPreview = preview || '';
  wsRunning = (status === 'running');
  updateSendBtn();
  updateBreadcrumb();
  var content = document.getElementById('content');
  content.innerHTML = skeletonMessages();

  // 1. Subscribe WS first, then buffer+fetch (shared with reconnect recovery)
  wsAllMessages = [];
  wsMessageCount = 0;
  wsLastTimestamp = '';
  wsHasMore = false;
  wsOldestTimestamp = '';
  wsLoadingOlder = false;
  startWs(sessionId);

  try {
    var t0 = performance.now();
    var result = await bufferAndFetch(sessionId, '');
    if (_navVersion !== myNav) return;
    var latency = Math.round(performance.now() - t0);

    if (wsAllMessages.length === 0) {
      if (result.needSync) {
        var online = deviceOnlineMap[appState.device] !== false;
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
    content.innerHTML = '<div class="messages">' + renderMessages(wsAllMessages) + '</div>';
    showInputBar(true);

    updateTitleFromMessages();

    // Infer running state from last assistant message (covers page refresh where status param is missing)
    if (!status) {
      for (var ri = wsAllMessages.length - 1; ri >= 0; ri--) {
        if (wsAllMessages[ri].type === 'assistant') {
          wsRunning = wsAllMessages[ri].stopReason !== 'end_turn';
          break;
        }
      }
    }
    updateSendBtn();

    content.scrollTop = content.scrollHeight;
    setTimeout(function () { content.scrollTop = content.scrollHeight; }, 500);
    loadImages(content);
    clampOverflow(content.querySelector('.messages'));
    checkPendingPrompts(wsAllMessages);
    wsRenderedCount = wsAllMessages.length;
    showStats(wsMessageCount + ' messages | ' + latency + 'ms');
  } catch (e) {
    if (_navVersion !== myNav) return;
    _wsBuffer = null;
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
  var h = bar.offsetHeight;
  if (h === 0 || bar.style.display === 'none') { btn.style.bottom = ''; return; }
  btn.style.bottom = (h + 12) + 'px';
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
    if (!appState.session) return;
    var atBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 100;
    btn.style.display = atBottom ? 'none' : 'flex';

    // Load older messages when scrolling near top
    if (content.scrollTop < 800 && wsHasMore && !wsLoadingOlder) {
      loadOlderAndPrepend();
    }
  });

  // Tap top bar to scroll to top (skip Setup/Logout links)
  document.querySelector('.top-bar').addEventListener('click', function (e) {
    if (e.target.closest('.top-action')) return;
    if (appState.session) content.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();

async function loadOlderAndPrepend() {
  if (!appState.session || appState.session === '__new__') return;
  var content = document.getElementById('content');
  var container = content.querySelector('.messages');
  if (!container) return;

  // Show loading indicator at top
  var loader = document.createElement('div');
  loader.className = 'loading-older';
  loader.textContent = 'Loading...';
  container.insertBefore(loader, container.firstChild);

  var prevHeight = content.scrollHeight;

  var msgs = await loadOlderMessages(appState.session);
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
  if (!KEY) return; // auth guard in index.html handles redirect
  var nav = sessionStorage.getItem('agentpeek-nav');
  initConnection().then(function (ok) {
    if (!ok) { document.getElementById('content').innerHTML = '<div class="empty">Connection failed. <a href="landing.html" style="color:#58a6ff">Re-enter API key</a></div>'; return; }
    // URL hash takes priority (supports Cmd+Click new tab), then clear it
    var hash = location.hash.replace(/^#\/?/, '');
    if (hash) {
      history.replaceState(null, '', location.pathname + location.search);
      var seg = hash.split('/').map(decodeURIComponent);
      var hashProjectName = seg[1] ? seg[1].split('-').pop() || seg[1] : '';
      if (seg.length >= 3 && seg[2] && seg[2] !== '__new__') {
        appState = { device: seg[0], project: { hash: seg[1], name: hashProjectName }, session: null, sessionPreview: '' };
        loadMessages(seg[2], '');
      } else if (seg.length >= 2 && seg[1]) { loadSessions(seg[0], seg[1], hashProjectName); }
      else if (seg.length >= 1 && seg[0]) { loadProjects(seg[0]); }
      else { loadDevices(); }
    } else if (nav) {
      try {
        var s = JSON.parse(nav);
        if (s.session && s.session !== '__new__') {
          appState = { device: s.device, project: s.project, session: null, sessionPreview: '' };
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
  });
})();
