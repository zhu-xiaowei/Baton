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
  el.innerHTML = parts.join(' &rsaquo; ');
  el.style.display = parts.length > 1 ? 'block' : 'none';
}

// ---- Devices ----
async function loadDevices() {
  appState = { device: null, project: null, session: null, sessionPreview: '' };
  disconnectWs();
  updateBreadcrumb();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading devices...</div>';

  try {
    var data = await api('/api/bridge/devices');
    if (data.devices.length === 0) { content.innerHTML = '<div class="empty">No devices found</div>'; return; }
    content.innerHTML = '<div class="list">' + data.devices.map(function (d) {
      return '<div class="item" onclick="loadProjects(\'' + esc(d.deviceName) + '\')">'
        + '<div class="title">' + esc(d.deviceName) + '</div>'
        + '<div class="subtitle">' + osName(d.os) + '</div>'
        + '<div class="meta"><span>' + d.projectCount + ' projects</span><span>' + d.sessionCount + ' sessions</span><span>' + timeAgo(d.lastActive) + '</span></div>'
        + '</div>';
    }).join('') + '</div>';
    showStats(data.devices.length + ' device(s)');
  } catch (e) { content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// ---- Projects ----
async function loadProjects(device) {
  appState = { device: device, project: null, session: null, sessionPreview: '' };
  disconnectWs();
  updateBreadcrumb();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading projects...</div>';

  try {
    var data = await api('/api/bridge/projects', { device: device });
    content.innerHTML = '<div class="list">' + data.projects.map(function (p) {
      return '<div class="item" onclick="loadSessions(\'' + esc(device) + '\',\'' + esc(p.projectHash) + '\',\'' + esc(p.projectName) + '\')">'
        + '<div class="title">' + esc(p.projectName) + '</div>'
        + '<div class="subtitle">' + esc(p.projectPath) + '</div>'
        + '<div class="meta"><span>' + p.sessionCount + ' sessions</span><span>' + p.activeCount + ' active</span><span>' + timeAgo(p.lastActive) + '</span></div>'
        + '</div>';
    }).join('') + '</div>';
    showStats(data.projects.length + ' project(s)');
  } catch (e) { content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// ---- Sessions ----
async function loadSessions(device, projectHash, projectName) {
  disconnectWs();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading sessions...</div>';

  try {
    var data = await api('/api/bridge/sessions', { device: device, project: projectHash });
    appState = { device: device, project: { hash: projectHash, name: projectName || projectHash }, session: null, sessionPreview: '' };
    updateBreadcrumb();
    content.innerHTML = '<div class="list">' + data.sessions.map(function (s) {
      return '<div class="item" onclick="loadMessages(\'' + esc(s.sessionId) + '\', \'' + esc(s.preview || '') + '\')">'
        + '<div class="title"><span class="badge ' + (s.isRunning ? 'running' : 'stopped') + '">' + (s.isRunning ? 'Running' : 'Stopped') + '</span> ' + esc(s.preview || 'No preview') + '</div>'
        + '<div class="subtitle">' + esc(s.model || 'unknown model') + '</div>'
        + '<div class="meta"><span>' + s.sessionId.slice(0, 8) + '...</span><span>' + formatSize(s.size) + '</span><span>' + timeAgo(s.lastActive) + '</span></div>'
        + '</div>';
    }).join('') + '</div>';
    showStats(data.sessions.length + ' session(s)');
  } catch (e) { content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// ---- Messages ----
async function loadMessages(sessionId, preview) {
  appState.session = sessionId;
  appState.sessionPreview = preview || '';
  updateBreadcrumb();
  var content = document.getElementById('content');
  content.innerHTML = '<div class="loading">Loading messages...</div>';

  try {
    var t0 = performance.now();
    var data = await api('/api/bridge/messages', { session: sessionId });
    var latency = Math.round(performance.now() - t0);

    if (data.messages.length === 0) {
      content.innerHTML = data.needSync
        ? '<div class="loading">Syncing history from bridge...</div>'
        : '<div class="empty">No messages</div>';
      startWs(sessionId);
      wsMessageCount = 0;
      wsAllMessages = [];
      showStats('Waiting for sync...');
      return;
    }

    content.innerHTML = '<div class="messages">' + renderMessages(data.messages) + '</div>';

    requestAnimationFrame(function () { content.scrollTop = content.scrollHeight; });
    loadImages(content);
    wsMessageCount = data.messages.length;
    wsAllMessages = data.messages.slice();
    showStats(wsMessageCount + ' messages | ' + latency + 'ms');

    startWs(sessionId);
  } catch (e) { content.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; }
}

// Auto-connect
(function () {
  var saved = localStorage.getItem('agentpeek-config');
  if (saved) {
    var c = JSON.parse(saved);
    if (c.server && c.key) setTimeout(connect, 100);
  }
})();
