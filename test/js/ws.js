// WebSocket connection management
var ws = null;
var wsSessionId = null;
var wsMessageCount = 0;
var wsStatusText = '';
var wsAllMessages = []; // track all messages for tool pairing
var wsProjectHash = null; // for new session creation

function connectWs(_, projectHash) {
  if (!WS_URL) return;
  if (projectHash) wsProjectHash = projectHash;
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
    } else if (msg.action === 'permission_request') {
      if (msg.sessionId === wsSessionId) showPermissionPrompt(msg);
    } else if (msg.action === 'send_message_result') {
      // New session: bridge created tmux + CC, returned sessionId
      if (msg.sessionId && appState.session === '__new__') {
        appState.session = msg.sessionId;
        appState.sessionPreview = 'New Session';
        updateBreadcrumb();
        saveNav();
        wsSessionId = msg.sessionId;
        subscribeSession(msg.sessionId);
      }
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

    // tool_result → append OUT to matching tool_use node
    if (isToolResultOnly(msg)) {
      if (Array.isArray(msg.content)) {
        for (var ri = 0; ri < msg.content.length; ri++) {
          var rb = msg.content[ri];
          if (rb.type === 'tool_result' && rb.tool_use_id) {
            var node = container.querySelector('[data-tool-id="' + rb.tool_use_id + '"]');
            if (node && !node.querySelector('.tool-body-out')) {
              var outContent = typeof rb.content === 'string' ? rb.content
                : Array.isArray(rb.content) ? rb.content.map(function(c) { return c.text || ''; }).join('') : '';
              if (outContent) {
                var bodyEl = node.querySelector('.tool-body');
                if (bodyEl) {
                  bodyEl.insertAdjacentHTML('beforeend',
                    '<div class="tool-body-out"><span class="tool-label">OUT</span><pre class="tool-out-pre">' + esc(outContent) + '</pre></div>');
                } else {
                  node.insertAdjacentHTML('beforeend',
                    '<div class="tool-body"><div class="tool-body-out"><span class="tool-label">OUT</span><pre class="tool-out-pre">' + esc(outContent) + '</pre></div></div>');
                }
              }
            }
          }
        }
      }
      continue;
    }
    if (isInterruptMsg(msg)) continue;

    // User message: dedup against pending sent messages, or render new bubble
    if (msg.type === 'user') {
      if (tryDedup(msg)) continue;  // matched a pending sent msg — skip rendering
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

  // After all messages rendered — check if last message needs a prompt
  dismissPermissionPrompt();
  checkPendingPrompts(wsAllMessages);

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

// Track pending (optimistically rendered) messages for dedup
var pendingSentMessages = [];

function sendMessage() {
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var images = stagedImages.slice();

  if (!text && !images.length) return;
  if (!text && images.length) text = '请查看这张图片';
  // Allow sending without wsSessionId for new sessions (projectHash is used)
  if (!wsSessionId && appState.session !== '__new__') return;

  // Images already uploaded — just assemble refs
  var readyImages = images.filter(function (img) { return img.uploaded && img.key; });
  if (readyImages.length) {
    var refs = readyImages.map(function (img) { return '![](claude-bridge:' + img.key + ')'; }).join('\n');
    doSend(text + '\n' + refs, text, readyImages);
  } else {
    doSend(text, text, []);
  }

  stagedImages = [];
  renderStagedImages();
  input.value = '';
  input.focus();
}

function doSend(fullText, displayText, images) {
  if (appState.session === '__new__' && wsProjectHash) {
    wsSend({ action: 'send_message', projectHash: wsProjectHash, text: fullText });
  } else {
    wsSend({ action: 'send_message', sessionId: wsSessionId, text: fullText });
  }

  // Remove placeholder text
  var empty = document.querySelector('.empty');
  if (empty) empty.remove();

  var msgId = 'sent-' + Date.now();
  pendingSentMessages.push({ id: msgId, text: displayText, isImage: images.length > 0 });
  var container = document.querySelector('.messages');
  if (container) {
    var imgHtml = images.map(function (img) {
      return '<div class="img-placeholder loaded"><img src="' + img.dataUrl + '" onclick="viewImage(this.src)" /></div>';
    }).join('');
    var attachHtml = imgHtml ? '<div class="msg-attachments">' + imgHtml + '</div>' : '';
    container.insertAdjacentHTML('beforeend',
      '<div class="msg-user" id="' + msgId + '">' + attachHtml
      + '<div class="msg-text">' + esc(displayText) + '</div>'
      + '<div class="msg-time sending-status">sending... ' + new Date().toLocaleTimeString() + '</div></div>');
    document.getElementById('content').scrollTo({ top: 99999, behavior: 'smooth' });
  }
}

// ---- Permission Prompt ----

function showPermissionPrompt(msg) {
  // Remove any existing prompt
  dismissPermissionPrompt();

  // Disable bottom input bar while prompt is active
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = true;
    inputBar.querySelectorAll('.input-row button').forEach(function(b) { b.disabled = true; });
    inputBar.querySelector('#msg-input').placeholder = 'Please respond to the prompt above...';
  }

  var container = document.querySelector('.messages');
  if (!container) return;

  var html = '<div class="permission-prompt" id="permission-prompt">';
  html += '<div class="permission-header"><div class="permission-title">' + esc(msg.title || 'Confirm?') + '</div>'
    + '<button class="permission-close" onclick="cancelPermissionPrompt()" title="Cancel (Esc)">&times;</button></div>';
  if (msg.description) {
    html += '<pre class="permission-desc">' + esc(msg.description) + '</pre>';
  }
  html += '<div class="permission-options">';
  var options = msg.options || [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }];
  for (var i = 0; i < options.length; i++) {
    var opt = options[i];
    var btnClass = opt.value === 'n' || opt.value === 'no' ? 'permission-btn deny' : 'permission-btn allow';
    html += '<button class="' + btnClass + '" data-value="' + esc(opt.value) + '" '
      + 'data-has-input="' + (opt.hasInput ? '1' : '0') + '" '
      + 'onclick="handlePermissionOption(this)">'
      + (opt.key ? '<span class="permission-key">' + esc(opt.key) + '</span> ' : '')
      + '<span class="permission-label">' + esc(opt.label) + '</span>'
      + (opt.description ? '<span class="permission-desc-inline">' + esc(opt.description) + '</span>' : '')
      + '</button>';
    if (opt.hasInput) {
      html += '<div class="permission-input-wrap" id="perm-input-' + i + '" style="display:none">'
        + '<input class="permission-input" placeholder="' + esc(opt.placeholder || '') + '" '
        + 'onkeydown="if(event.key===\'Enter\')submitPermissionWithInput(this,\'' + esc(opt.value) + '\')" />'
        + '<button class="permission-submit" onclick="submitPermissionWithInput(this.previousElementSibling,\'' + esc(opt.value) + '\')">Send</button>'
        + '</div>';
    }
  }
  html += '</div></div>';

  container.insertAdjacentHTML('beforeend', html);
  var el = document.getElementById('content');
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

function handlePermissionOption(btn) {
  var value = btn.getAttribute('data-value');
  var hasInput = btn.getAttribute('data-has-input') === '1';

  if (hasInput) {
    // Toggle input field
    var wrap = btn.nextElementSibling;
    if (wrap && wrap.classList.contains('permission-input-wrap')) {
      var visible = wrap.style.display !== 'none';
      wrap.style.display = visible ? 'none' : 'flex';
      if (!visible) wrap.querySelector('input').focus();
      return;
    }
  }

  // Direct action — send value as keystroke
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, approved: value });
  dismissPermissionPrompt();
}

function submitPermissionWithInput(input, value) {
  var text = input.value.trim();
  if (!text) return; // require input
  // Send as type:N:text — bridge navigates to option, types text, Enter
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, approved: value + ':' + text });
  dismissPermissionPrompt();
}

function cancelPermissionPrompt() {
  // Send Escape to Claude Code
  wsSend({ action: 'permission_reply', sessionId: wsSessionId, approved: 'escape' });
  dismissPermissionPrompt();
}

function dismissPermissionPrompt() {
  var el = document.getElementById('permission-prompt');
  if (el) el.remove();
  // Re-enable bottom input bar
  var inputBar = document.getElementById('input-bar');
  if (inputBar) {
    inputBar.querySelector('#msg-input').disabled = false;
    inputBar.querySelectorAll('.input-row button').forEach(function(b) { b.disabled = false; });
    inputBar.querySelector('#msg-input').placeholder = 'Send a message...';
  }
}

// ---- Client-side prompt detection ----

/** Build prompt info from a tool_use block. Returns null if not a user-facing prompt. */
function buildClientPrompt(toolName, toolInput) {
  if (toolName === 'AskUserQuestion') {
    var q = (toolInput.questions && toolInput.questions[0]) || toolInput;
    var question = q.question || q.text || '';
    var header = q.header || '';
    var rawOptions = q.options || [];
    var options = rawOptions.map(function (opt, i) {
      return {
        label: opt.label,
        description: opt.description || '',
        value: 'arrow:' + i,
        key: String(i + 1)
      };
    });
    // "Type something" — navigate to the option after the last real option, then type
    var typeIdx = rawOptions.length; // Claude Code adds "Type something" right after options
    options.push({
      label: 'Type something...',
      value: 'type:' + typeIdx,
      key: String(rawOptions.length + 1),
      hasInput: true,
      placeholder: 'Type your response...'
    });
    return {
      type: 'ask_user',
      title: header ? '[' + header + '] ' + question : question,
      options: options
    };
  }
  if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') {
    return {
      type: 'plan_approval',
      title: 'Accept this plan?',
      options: [
        { label: 'Yes, and auto-accept', value: 'arrow:0', key: '1' },
        { label: 'Yes, and manually approve edits', value: 'arrow:1', key: '2' },
        { label: 'No, keep planning', value: 'type:2', key: '3', hasInput: true, placeholder: 'Tell Claude what to do instead...' }
      ]
    };
  }
  // Bash / shell commands
  if (toolName === 'Bash' || toolName === 'bash') {
    var cmd = toolInput.command || toolInput.cmd || JSON.stringify(toolInput);
    return {
      type: 'tool_permission',
      title: 'Run command?',
      description: cmd,
      options: [
        { label: 'Yes', value: 'arrow:0', key: '1' },
        { label: 'Yes, always', value: 'arrow:1', key: '2' },
        { label: 'No', value: 'arrow:2', key: '3' }
      ]
    };
  }
  // File operations
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    var fp = toolInput.file_path || toolInput.path || '';
    return {
      type: 'tool_permission',
      title: toolName + ': ' + fp,
      description: toolName === 'Write' ? 'Create/overwrite file' : 'Edit file',
      options: [
        { label: 'Yes', value: 'arrow:0', key: '1' },
        { label: 'Yes, allow all edits', value: 'arrow:1', key: '2' },
        { label: 'No', value: 'arrow:2', key: '3' }
      ]
    };
  }
  // Not a user-facing prompt tool
  return null;
}

/** Check if the last message has an unresolved prompt. */
function checkPendingPrompts(messages) {
  if (!messages.length) return;
  var last = messages[messages.length - 1];
  if (last.type !== 'assistant' || !Array.isArray(last.content)) return;
  for (var i = last.content.length - 1; i >= 0; i--) {
    var b = last.content[i];
    if (b.type === 'tool_use') {
      var prompt = buildClientPrompt(b.name, b.input);
      if (prompt) showPermissionPrompt(prompt);
      return;
    }
  }
}

// ---- Image Staging & Sending ----

var stagedImages = []; // { dataUrl, key, uploaded }

function onImagePicked(input) {
  if (!input.files) return;
  for (var i = 0; i < input.files.length; i++) stageImageFile(input.files[i]);
  input.value = '';
}

function onInputPaste(e) {
  var items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  var hasImage = false;
  for (var i = 0; i < items.length; i++) {
    if (items[i].type.indexOf('image/') === 0) {
      hasImage = true;
      stageImageFile(items[i].getAsFile());
    }
  }
  if (hasImage) e.preventDefault();
}

function stageImageFile(file) {
  if (!file) return;
  var entry = { dataUrl: '', key: '', uploaded: false };
  stagedImages.push(entry);
  renderStagedImages();

  var reader = new FileReader();
  reader.onload = function () {
    var img = new Image();
    img.onload = function () {
      // Compress
      var scale = Math.min(1, 720 / Math.max(img.width, img.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      var base64 = dataUrl.split(',')[1];
      var raw = atob(base64);
      var hashStr = raw.slice(0, 8192) + String(raw.length);
      var h = 0;
      for (var hi = 0; hi < hashStr.length; hi++) { h = ((h << 5) - h + hashStr.charCodeAt(hi)) | 0; }
      var key = Math.abs(h).toString(16).padStart(8, '0') + raw.length.toString(16) + '.jpg';

      entry.dataUrl = dataUrl;
      entry.key = key;
      renderStagedImages();

      // Upload immediately
      fetch(SERVER + '/api/bridge/upload-image', {
        method: 'POST',
        headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key, data: base64 })
      }).then(function (res) {
        if (!res.ok) throw new Error('Upload failed');
        return res.json();
      }).then(function () {
        entry.uploaded = true;
        renderStagedImages();
      }).catch(function () {
        // Remove failed entry
        var fi = stagedImages.indexOf(entry);
        if (fi >= 0) stagedImages.splice(fi, 1);
        renderStagedImages();
      });
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function renderStagedImages() {
  var row = document.getElementById('img-preview-row');
  if (!stagedImages.length) { row.style.display = 'none'; row.innerHTML = ''; return; }
  row.style.display = 'flex';
  row.innerHTML = stagedImages.map(function (img, i) {
    var overlay = img.uploaded ? '' : '<div class="img-upload-overlay"><svg class="img-spinner" viewBox="0 0 36 36"><circle cx="18" cy="18" r="16" fill="none" stroke="rgba(255,255,255,0.3)" stroke-width="3"/><circle cx="18" cy="18" r="16" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="100" stroke-dashoffset="' + (img.dataUrl ? '25' : '90') + '" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1s" repeatCount="indefinite"/></circle></svg></div>';
    var src = img.dataUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    return '<div class="img-thumb" onclick="viewStagedImage(' + i + ')">'
      + '<img src="' + src + '">' + overlay
      + '<button class="img-remove" onclick="event.stopPropagation();removeStagedImage(' + i + ')">&times;</button></div>';
  }).join('');
}

function removeStagedImage(i) {
  stagedImages.splice(i, 1);
  renderStagedImages();
}

var galleryIndex = 0;
function viewStagedImage(i) {
  galleryIndex = i;
  showGallery();
}

function showGallery() {
  var img = stagedImages[galleryIndex];
  if (!img || !img.dataUrl) return;
  var overlay = document.getElementById('imgOverlay');
  var overlayImg = document.getElementById('imgOverlayImg');
  overlayImg.src = img.dataUrl;
  overlay.style.display = 'flex';
  overlay.onclick = null;
  // Build nav buttons if multiple
  var nav = overlay.querySelector('.gallery-nav');
  if (nav) nav.remove();
  if (stagedImages.length > 1) {
    var navHtml = '<div class="gallery-nav">'
      + '<button onclick="event.stopPropagation();galleryPrev()"' + (galleryIndex <= 0 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg></button>'
      + '<span>' + (galleryIndex + 1) + ' / ' + stagedImages.length + '</span>'
      + '<button onclick="event.stopPropagation();galleryNext()"' + (galleryIndex >= stagedImages.length - 1 ? ' disabled' : '') + '><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg></button>'
      + '</div>';
    overlay.insertAdjacentHTML('beforeend', navHtml);
  }
  overlay.onclick = function (e) { if (e.target === overlay) { overlay.style.display = 'none'; } };
}

function galleryPrev() { if (galleryIndex > 0) { galleryIndex--; showGallery(); } }
function galleryNext() { if (galleryIndex < stagedImages.length - 1) { galleryIndex++; showGallery(); } }

document.addEventListener('keydown', function (e) {
  var overlay = document.getElementById('imgOverlay');
  if (!overlay || overlay.style.display !== 'flex') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); galleryPrev(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); galleryNext(); }
  else if (e.key === 'Escape') overlay.style.display = 'none';
});

/** Extract plain text from a message's content field */
function extractMsgText(msg) {
  if (!msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    var tb = msg.content.find(function (c) { return c.type === 'text'; });
    return tb ? (tb.text || '') : '';
  }
  return '';
}

/** Strip ![](…) image references from text for comparison */
function stripImageRefs(text) {
  return text.replace(/!\[.*?\]\([^)]+\)/g, '').trim();
}

/** Check if an incoming user message matches a pending sent message. If so, mark as delivered instead of appending. */
function tryDedup(msg) {
  if (msg.type !== 'user') return false;
  var text = extractMsgText(msg).trim();
  if (!text) return false;

  var stripped = stripImageRefs(text);
  for (var i = 0; i < pendingSentMessages.length; i++) {
    var pendingText = pendingSentMessages[i].text.trim();
    if (pendingText === stripped || pendingText === text) {
      var el = document.getElementById(pendingSentMessages[i].id);
      if (el) {
        var status = el.querySelector('.sending-status');
        if (status) {
          // Show ✓ then update to actual timestamp
          var ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '';
          status.innerHTML = '<span style="color:#3fb950">&#10003;</span> ' + ts;
          setTimeout(function () {
            status.innerHTML = ts;
            status.style.color = '#6e7681';
          }, 2000);
        }
      }
      pendingSentMessages.splice(i, 1);
      return true;
    }
  }
  return false;
}
