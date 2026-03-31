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
        requestAnimationFrame(function () {
          content.scrollTo({ top: content.scrollHeight, behavior: 'smooth' });
        });
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

  // Incremental update: only append new items or update the last one
  var lastTurn = container.querySelector('.assistant-turn:last-child');
  if (lastTurn) {
    var temp = document.createElement('div');
    temp.innerHTML = turnHtml;
    var newTurn = temp.firstElementChild;
    if (!newTurn) return;
    var existingItems = lastTurn.querySelectorAll(':scope > .tl-item');
    var newItems = newTurn.querySelectorAll(':scope > .tl-item');
    if (newItems.length > existingItems.length) {
      // Append only the new items
      for (var i = existingItems.length; i < newItems.length; i++) {
        lastTurn.appendChild(newItems[i].cloneNode(true));
      }
      // Update the last existing item (may have gotten its tool_result)
      if (existingItems.length > 0) {
        var lastExisting = existingItems[existingItems.length - 1];
        var lastNew = newItems[existingItems.length - 1];
        if (lastExisting.innerHTML !== lastNew.innerHTML) {
          lastExisting.innerHTML = lastNew.innerHTML;
        }
      }
    } else if (newItems.length === existingItems.length && existingItems.length > 0) {
      // Same count: only update the last item (streaming text update)
      var lastE = existingItems[existingItems.length - 1];
      var lastN = newItems[newItems.length - 1];
      if (lastE.innerHTML !== lastN.innerHTML) {
        lastE.innerHTML = lastN.innerHTML;
      }
    }
  } else {
    container.insertAdjacentHTML('beforeend', turnHtml);
  }
  var el = document.getElementById('content');
  function scrollIfNearBottom() {
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }
  scrollIfNearBottom();
  // Catch async diff renders (tool.js setTimeout 50ms)
  setTimeout(scrollIfNearBottom, 150);
  loadImages(container);
  showStats(wsMessageCount + ' messages (live)');
}

function startWs(sessionId) {
  wsSessionId = sessionId;
  if (!ws) connectWs();
  else subscribeSession(sessionId);
}
