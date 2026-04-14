// App state, routing, page loading
var appState = { device: null, project: null, session: null, sessionPreview: '' };

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

function showStats(text) {
  var el = document.getElementById('stats');
  el.style.display = 'flex';
  var wsColor = wsStatusText === 'connected' ? '#3fb950' : wsStatusText === 'reconnecting' ? '#d29922' : '#f85149';
  var wsHtml = wsStatusText ? '<span><span class="ws-dot" style="background:' + wsColor + '"></span>WS ' + wsStatusText + '</span>' : '';
  el.innerHTML = '<span>' + text + '</span>' + wsHtml;
}

function updateBreadcrumb() {
  var el = document.getElementById('breadcrumb');
  var parts = ['<span onclick="loadDevices()">Devices</span>'];
  if (appState.device) {
    parts.push('<span onclick="loadProjects(\'' + esc(appState.device) + '\')">' + esc(appState.device) + '</span>');
  }
  if (appState.project) {
    parts.push('<span onclick="loadSessions(\'' + esc(appState.device) + '\',\'' + esc(appState.project.hash) + '\',\'' + esc(appState.project.name) + '\')">' + esc(appState.project.name) + '</span>');
  }
  if (appState.session) {
    var label = appState.sessionPreview || appState.session.slice(0, 8) + '...';
    parts.push('<span>' + esc(label) + '</span>');
  }
  var newBtn = '';
  var _addSvg = '<svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="8" cy="8" r="6.5" stroke-width="1.2"/><line x1="8" y1="5" x2="8" y2="11" stroke-width="1"/><line x1="5" y1="8" x2="11" y2="8" stroke-width="1"/></svg>';
  if (appState.project) {
    newBtn = '<button class="new-session-btn" onclick="startNewSession(\'' + esc(appState.project.hash) + '\')" title="New Session">' + _addSvg + '</button>';
  } else if (appState.device && !appState.project) {
    newBtn = '<button class="new-session-btn" onclick="createNewProject()" title="New Project">' + _addSvg + '</button>';
  }
  el.innerHTML = '<div class="breadcrumb-nav">' + parts.join(' &rsaquo; ') + '</div>' + newBtn;
  el.style.display = parts.length > 1 ? 'flex' : 'none';
}

function showInputBar(visible) {
  document.getElementById('input-bar').style.display = visible ? 'flex' : 'none';
}

function saveNav() {
  sessionStorage.setItem('agentpeek-nav', JSON.stringify(appState));
}

// ---- Devices ----
async function loadDevices() {
  appState = { device: null, project: null, session: null, sessionPreview: '' };
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading devices...</div>';

  try {
    var data = await api('/api/bridge/devices');
    if (data.devices.length === 0) { content.innerHTML = '<div class="empty">No devices found</div>'; return; }
    content.innerHTML = '<div class="list">' + data.devices.map(function (d) {
      var rc = d.runningCount || 0, ic = d.idleCount || 0;
      var dotClass = d.online ? 'online' : 'offline';
      return '<div class="item" onclick="loadProjects(\'' + esc(d.deviceName) + '\')">'
        + '<div class="item-top"><span class="device-dot ' + dotClass + '"></span><span class="title">' + esc(d.deviceName) + '</span><span class="item-time">' + timeAgo(d.lastActive) + '</span></div>'
        + '<div class="item-bottom"><span class="subtitle">' + osName(d.os) + ' &middot; ' + d.projectCount + ' projects</span><span class="item-status">' + rc + ' running &middot; ' + ic + ' idle</span></div>'
        + '</div>';
    }).join('') + '</div>';
    showStats(data.devices.length + ' device(s)');
  } catch (e) { content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// ---- Projects ----
async function loadProjects(device) {
  appState = { device: device, project: null, session: null, sessionPreview: '' };
  disconnectWs();
  showInputBar(false);
  updateBreadcrumb();
  saveNav();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading projects...</div>';

  try {
    var data = await api('/api/bridge/projects', { device: device });
    content.innerHTML = '<div class="list">' + data.projects.map(function (p) {
      var rc = p.runningCount || 0, ic = p.idleCount || 0;
      return '<div class="item" onclick="loadSessions(\'' + esc(device) + '\',\'' + esc(p.projectHash) + '\',\'' + esc(p.projectName) + '\')">'
        + '<div class="item-top"><span class="title">' + esc(p.projectName) + '</span><span class="item-time">' + timeAgo(p.lastActive) + '</span></div>'
        + '<div class="subtitle">' + esc(p.projectPath) + '</div>'
        + '<div class="item-bottom"><span class="meta-left">' + p.sessionCount + ' sessions</span><span class="item-status">' + rc + ' running &middot; ' + ic + ' idle</span></div>'
        + '</div>';
    }).join('') + '</div>';
    showStats(data.projects.length + ' project(s)');
  } catch (e) { content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// ---- Sessions ----
async function loadSessions(device, projectHash, projectName) {
  disconnectWs();
  showInputBar(false);
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading sessions...</div>';

  try {
    var data = await api('/api/bridge/sessions', { device: device, project: projectHash });
    appState = { device: device, project: { hash: projectHash, name: projectName || projectHash }, session: null, sessionPreview: '' };
    updateBreadcrumb();
    saveNav();
    content.innerHTML = '<div class="list">'
      + data.sessions.map(function (s) {
      return '<div class="item" data-sid="' + esc(s.sessionId) + '" data-preview="' + esc(s.preview || '') + '" data-status="' + esc(s.status || '') + '" onclick="loadMessages(this.dataset.sid, this.dataset.preview, this.dataset.status)">'
        + '<div class="item-top"><span class="title"><span class="badge ' + (s.status || 'stopped') + '">' + (s.status === 'running' ? 'Running' : s.status === 'idle' ? 'Idle' : 'Stopped') + '</span> ' + esc(s.preview || 'No preview') + '</span><span class="item-time">' + timeAgo(s.lastActive) + '</span></div>'
        + '<div class="meta">' + esc(s.model || 'unknown model') + ' &middot; ' + s.sessionId.slice(0, 8) + '... &middot; ' + formatSize(s.size) + '</div>'
        + '</div>';
    }).join('') + '</div>';
    showStats(data.sessions.length + ' session(s)');
  } catch (e) { content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
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
  wsSessionId = null;
  pendingSentMessages = [];
  var content = document.getElementById('content');
  content.innerHTML = '<div class="messages"><div class="empty">Send a message to start a new session</div></div>';
  showInputBar(true);
  connectWs(null, projectHash);
}

// ---- Messages ----
async function loadMessages(sessionId, preview, status) {
  appState.session = sessionId;
  appState.sessionPreview = preview || '';
  wsRunning = (status === 'running');
  updateSendBtn();
  updateBreadcrumb();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading messages...</div>';

  // 1. Subscribe WS first, then buffer+fetch (shared with reconnect recovery)
  wsAllMessages = [];
  wsMessageCount = 0;
  wsLastTimestamp = '';
  startWs(sessionId);

  try {
    var t0 = performance.now();
    var result = await bufferAndFetch(sessionId, '');
    var latency = Math.round(performance.now() - t0);

    if (wsAllMessages.length === 0) {
      content.innerHTML = result.needSync
        ? '<div class="loading">Syncing history from bridge...</div>'
        : '<div class="empty">No messages</div>';
      showInputBar(true);
      showStats('Waiting for sync...');
      saveNav();
      return;
    }

    // Render
    content.innerHTML = '<div class="messages">' + renderMessages(wsAllMessages) + '</div>';
    showInputBar(true);

    // Update breadcrumb with latest ai-title
    for (var i = wsAllMessages.length - 1; i >= 0; i--) {
      if (wsAllMessages[i].type === 'ai-title' && wsAllMessages[i].content) {
        appState.sessionPreview = typeof wsAllMessages[i].content === 'string' ? wsAllMessages[i].content : '';
        updateBreadcrumb(); saveNav();
        break;
      }
    }

    content.scrollTop = content.scrollHeight;
    setTimeout(function () { content.scrollTop = content.scrollHeight; }, 500);
    loadImages(content);
    clampOverflow(content.querySelector('.messages'));
    checkPendingPrompts(wsAllMessages);
    wsRenderedCount = wsAllMessages.length;
    showStats(wsMessageCount + ' messages | ' + latency + 'ms');
  } catch (e) {
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

(function () {
  var btn = document.getElementById('scroll-bottom-btn');
  var content = document.getElementById('content');

  // Show/hide button based on scroll position
  content.addEventListener('scroll', function () {
    if (!appState.session) return;
    var atBottom = content.scrollHeight - content.scrollTop - content.clientHeight < 100;
    btn.style.display = atBottom ? 'none' : 'flex';
  });

  // Tap top bar to scroll to top (skip Setup/Logout links)
  document.querySelector('.top-bar').addEventListener('click', function (e) {
    if (e.target.closest('.top-action')) return;
    if (appState.session) content.scrollTo({ top: 0, behavior: 'smooth' });
  });
})();

// Auto-connect + restore last session
(function () {
  if (!KEY) return; // auth guard in index.html handles redirect
  var nav = sessionStorage.getItem('agentpeek-nav');
  initConnection().then(function (ok) {
    if (!ok) { document.getElementById('content').innerHTML = '<div class="empty">Connection failed. <a href="landing.html" style="color:#58a6ff">Re-enter API key</a></div>'; return; }
    if (nav) {
      try {
        var s = JSON.parse(nav);
        if (s.session) {
          appState = { device: s.device, project: s.project, session: null, sessionPreview: '' };
          loadMessages(s.session, s.sessionPreview);
        } else if (s.project) {
          loadSessions(s.device, s.project.hash, s.project.name);
        } else if (s.device) {
          loadProjects(s.device);
        } else {
          loadDevices();
        }
      } catch { loadDevices(); }
    } else {
      loadDevices();
    }
  });
})();
