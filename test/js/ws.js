// WebSocket connection management
var ws = null;
var wsSessionId = null;
var wsMessageCount = 0;
var wsStatusText = '';
var wsAllMessages = []; // track all messages for tool pairing

function connectWs() {
  if (!WS_URL) return;
  if (ws) { ws.close(); ws = null; }
  ws = new WebSocket(WS_URL + '?apiKey=' + KEY + '&role=app');

  ws.onopen = function () {
    setWsStatus('connected');
    if (wsSessionId) subscribeSession(wsSessionId);
  };

  ws.onmessage = function (e) {
    var msg = JSON.parse(e.data);
    if (msg.action === 'messages' && msg.sessionId === wsSessionId) {
      for (var i = 0; i < msg.messages.length; i++) {
        wsAllMessages.push(msg.messages[i]);
        wsMessageCount++;
      }
      updateLastTurn();
      showStats(wsMessageCount + ' messages (' + msg.messages.length + ' new via WS)');
    } else if (msg.action === 'sync_complete') {
      if (msg.sessionId === wsSessionId) loadMessages(msg.sessionId);
    }
  };

  ws.onclose = function () {
    setWsStatus('disconnected');
    if (appState.session) {
      setWsStatus('reconnecting');
      setTimeout(function () { if (appState.session) connectWs(); }, 3000);
    }
  };

  ws.onerror = function () {};
}

function subscribeSession(sessionId) {
  if (wsSessionId && wsSessionId !== sessionId) {
    wsSend({ action: 'unsubscribe', sessionId: wsSessionId });
  }
  wsSessionId = sessionId;
  wsSend({ action: 'subscribe', sessionId: sessionId });
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function setWsStatus(status) {
  wsStatusText = status;
  var el = document.getElementById('stats');
  if (el.style.display !== 'none') {
    var span = el.querySelector('span');
    showStats(span ? span.textContent : '');
  }
}

function disconnectWs() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
    wsSessionId = null;
    setWsStatus('');
  }
}

// Track last rendered message index to only append new ones
var wsRenderedCount = 0;

function updateLastTurn() {
  var container = document.querySelector('.messages');
  if (!container) return;

  // Only render messages that haven't been rendered yet
  var newMessages = wsAllMessages.slice(wsRenderedCount);
  wsRenderedCount = wsAllMessages.length;

  // Stop any running agent timers when new messages arrive
  if (newMessages.length > 0) {
    container.querySelectorAll('.agent-timer:not([data-stopped])').forEach(function (t) {
      t.dataset.stopped = '1';
      var meta = null;
      // Try to find toolUseResult metadata from tool_result messages
      for (var j = 0; j < newMessages.length; j++) {
        if (newMessages[j].toolUseResult) { meta = newMessages[j].toolUseResult; break; }
      }
      if (meta) {
        var secs = Math.round((meta.totalDurationMs || 0) / 1000);
        t.textContent = (meta.totalToolUseCount || 0) + ' tool calls, ' + secs + 's';
      }
    });
  }

  for (var i = 0; i < newMessages.length; i++) {
    var msg = newMessages[i];
    if (isToolResultOnly(msg) || isInterruptMsg(msg)) continue;

    // User message: render bubble and append
    if (msg.type === 'user') {
      var userHtml = renderUserBubble(msg);
      if (userHtml) container.insertAdjacentHTML('beforeend', userHtml);
      continue;
    }

    if (msg.type !== 'assistant') continue;

    var html = renderSingleMessage(msg, wsAllMessages);
    if (!html) continue;

    // Append to existing turn or create new one
    var lastTurn = container.querySelector('.assistant-turn:last-child');
    if (lastTurn) {
      lastTurn.insertAdjacentHTML('beforeend', html);
    } else {
      container.insertAdjacentHTML('beforeend', '<div class="assistant-turn">' + html + '</div>');
    }
  }

  var el = document.getElementById('content');
  function scrollIfNearBottom() {
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }
  scrollIfNearBottom();
  setTimeout(scrollIfNearBottom, 150);
  loadImages(container);
  showStats(wsMessageCount + ' messages (live)');
}

function startWs(sessionId) {
  wsSessionId = sessionId;
  if (!ws) connectWs();
  else subscribeSession(sessionId);
}
