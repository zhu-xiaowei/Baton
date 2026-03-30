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
      var hasNewUserMsg = false;
      for (var i = 0; i < msg.messages.length; i++) {
        var m = msg.messages[i];
        wsAllMessages.push(m);
        wsMessageCount++;
        if (m.type === 'user' && !isToolResultOnly(m) && !isInterruptMsg(m)) hasNewUserMsg = true;
      }

      if (hasNewUserMsg) {
        // New user message = turn boundary changed, full re-render
        var content = document.getElementById('content');
        content.innerHTML = '<div class="messages">' + renderMessages(wsAllMessages) + '</div>';
        content.scrollTop = content.scrollHeight;
        loadImages(content);
      } else {
        // Only re-render the last assistant turn
        updateLastTurn();
      }
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

function updateLastTurn() {
  // Find messages after the last user text message (= the active turn)
  var lastUserIdx = -1;
  for (var i = wsAllMessages.length - 1; i >= 0; i--) {
    var m = wsAllMessages[i];
    if (m.type === 'user' && !isToolResultOnly(m) && !isInterruptMsg(m)) {
      lastUserIdx = i;
      break;
    }
  }
  var turnMessages = wsAllMessages.slice(lastUserIdx + 1);
  var turnHtml = renderLastTurn(turnMessages, wsAllMessages);

  var container = document.querySelector('.messages');
  if (!container) return;

  // Replace or append last .assistant-turn
  var lastTurn = container.querySelector('.assistant-turn:last-child');
  if (lastTurn) {
    lastTurn.outerHTML = turnHtml;
  } else {
    container.insertAdjacentHTML('beforeend', turnHtml);
  }
  var el = document.getElementById('content');
  el.scrollTop = el.scrollHeight;
  loadImages(container);
  showStats(wsMessageCount + ' messages (live)');
}

function startWs(sessionId) {
  wsSessionId = sessionId;
  if (!ws) connectWs();
  else subscribeSession(sessionId);
}
