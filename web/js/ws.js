// Fit mobile layout to the visual viewport throughout keyboard transitions.
import { state } from './state.js';
import { attachmentPreviewText, attachmentRef, fileAttachmentHtml } from './components/attachment.js';
import {
  clearComposerDraft,
  rekeyComposerDraft,
  syncComposerDraft,
} from './drafts/composer-draft.js';
import { dedupeCodexUserMessages } from './message-dedup.js';
import { FetchBarrierCoordinator } from './fetch-barrier.js';
import {
  replaceHistoryTail,
  captureHistoryViewport,
  restoreHistoryViewport,
} from './history-snapshot.js';
import {
  dedupeMessages,
  mergeMessages,
  commitMessageState,
  reconcilePendingMessages,
} from './message-state.js';
import { createMessageDom } from './message-dom.js';
import { refreshThinkingGroups } from './thinking.js';
import { updateWsStatusIndicator } from './components/ws-status.js';
import { showCenteredModal, hideCenteredModal } from './components/modal-viewport.js';
import { setButtonLoading } from './components/loading.js';
import {
  resolveActivityState,
  resolveControlActivity,
} from './runtime-status.js';
import {
  StreamCoordinator,
  StreamingDomRenderer,
  TurnEventQueue,
} from './streaming.js';
import { handleWsRpcMessage } from './ws-rpc.js';
import { RealtimeReceiver } from '../../bridge/realtime-direct-protocol.mjs';
import { ExecutionEventQueue } from './execution-events.js';

var _vpBaseHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
var _lastMobileViewportHeight = window.visualViewport ? window.visualViewport.height : 0;
var _keyboardOpenFrame = null;
var _followKeyboardOpen = false;
var _mobileKeyboardOpen = false;
var _inputFocusRequestsBottom = false;
var _isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
// Gate keyboard adaptation to touch devices: on desktop visualViewport also fires resize (scrollbar/chrome shifts, mermaid render), and the Android branch below would wrongly rewrite body height → input bar jumps.
var _isMobile = /Mobi|Android/i.test(navigator.userAgent) || _isIOS;
var _wsSendQueue = []; // payloads queued while socket not OPEN, flushed in order on connect
var _turnEventQueue = new TurnEventQueue();
var _streamCoordinator = new StreamCoordinator();
var _strictStreamRenderer = null;
var _checkpointResumedTurns = new Set();
var _queuedTurnIds = new Set();
var _activeExecutionIds = new Set();
var _executionEvents = new ExecutionEventQueue();
var _executionRecoveryTimers = new Map();
var _wsReconnectTimer = null;
var _wsConfigRequest = null;
var _realtimeReceiver = null;
var _wsConnectionGeneration = 0;
var _controlEventTimers = new Map();
var _gappedEndTimers = new Map();
var _suppressTurnEndRecovery = false;
var _handledControlEvents = new Set();
var _controlRequestState = new Map();
var _preAdoptionTurnEvents = new Map();
var _agentThreadRefreshTimer = null;
var _agentThreadRefreshVersion = 0;
var _historyFetchBarriers = new FetchBarrierCoordinator();
var _messagePaginationGeneration = 0;
var CONTROL_EVENT_FALLBACK_MS = 120;
var GAPPED_END_GRACE_MS = window.__APEEK_TEST__ ? 30 : 5000;
var MESSAGE_PAGE_SIZE = 200;
var _bottomFollowFrame = null;
var _pendingBottomFollow = null;

function placeFollowedContentAtBottom(content, container, sessionId) {
  if (!state.stickBottom
    || state.appState.session !== sessionId
    || content !== document.getElementById('content')
    || container !== content.querySelector('.messages')) {
    return;
  }
  var height = content.scrollHeight;
  if (height - content.clientHeight - content.scrollTop > 1) {
    content.scrollTop = height;
  }
}

function flushBottomFollow() {
  if (_bottomFollowFrame !== null) cancelAnimationFrame(_bottomFollowFrame);
  _bottomFollowFrame = null;
  var pending = _pendingBottomFollow;
  _pendingBottomFollow = null;
  if (pending) {
    placeFollowedContentAtBottom(pending.content, pending.container, pending.sessionId);
  }
}

function followBottomAfterLayout() {
  var content = document.getElementById('content');
  var container = content?.querySelector('.messages');
  var sessionId = state.appState.session;
  if (!state.stickBottom || !content || !container
    || content.querySelector('.skeleton-messages')) return;
  _pendingBottomFollow = { content, container, sessionId };
  if (_bottomFollowFrame === null) {
    _bottomFollowFrame = requestAnimationFrame(flushBottomFollow);
  }
}

if (window.visualViewport && _isMobile) {
  var syncMobileViewport = function () {
    var vv = window.visualViewport;
    var previousHeight = _lastMobileViewportHeight;
    var viewportShrinking = vv.height < previousHeight;
    var viewportGrowing = vv.height > previousHeight;
    _lastMobileViewportHeight = vv.height;
    var content = document.getElementById('content');
    var wasAtBottom = state.appState.session && state.appState.session !== '__new__' && content
      && content.scrollHeight - content.scrollTop - content.clientHeight < 100;

    _vpBaseHeight = Math.max(_vpBaseHeight, vv.height, window.innerHeight);
    var kbUp = vv.height < _vpBaseHeight * 0.75;
    var keyboardClosing = _mobileKeyboardOpen && !kbUp;
    var focusOpenedKeyboard = viewportShrinking && kbUp && _inputFocusRequestsBottom;
    if (viewportShrinking && (wasAtBottom || focusOpenedKeyboard)) {
      _followKeyboardOpen = true;
    }
    if (focusOpenedKeyboard) {
      _inputFocusRequestsBottom = false;
      state.stickBottom = true;
    }
    if (viewportGrowing) _followKeyboardOpen = false;
    _mobileKeyboardOpen = kbUp;
    if (keyboardClosing && state.stickBottom) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          if (!state.stickBottom) return;
          var currentContent = document.getElementById('content');
          if (currentContent) currentContent.scrollTop = currentContent.scrollHeight;
        });
      });
    }
    var chromeHeight = 0;
    if (_isIOS && kbUp
      && !document.querySelector('#projectTerminalPage, #gitStatusPage:not([hidden])')) {
      var topBar = document.querySelector('.top-bar');
      var breadcrumb = document.getElementById('breadcrumb');
      if (topBar) chromeHeight += topBar.offsetHeight;
      if (breadcrumb && getComputedStyle(breadcrumb).display !== 'none') {
        chromeHeight += breadcrumb.offsetHeight;
      }
    }
    document.body.style.bottom = 'auto';
    document.body.style.top = (_isIOS ? vv.offsetTop : 0) + 'px';
    document.body.style.height = (vv.height + chromeHeight) + 'px';
    document.body.style.transform = chromeHeight ? 'translateY(-' + chromeHeight + 'px)' : '';
    if (_isIOS) {
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.toggle('kb-up', kbUp);
    }
    if (window.positionScrollBtn) window.positionScrollBtn();
    if (_followKeyboardOpen && _keyboardOpenFrame === null) {
      _keyboardOpenFrame = requestAnimationFrame(function () {
        _keyboardOpenFrame = null;
        if (!_followKeyboardOpen) return;
        _followKeyboardOpen = false;
        state.stickBottom = true;
        var currentContent = document.getElementById('content');
        if (currentContent) currentContent.scrollTop = currentContent.scrollHeight;
      });
    }
  };
  window.visualViewport.addEventListener('resize', syncMobileViewport);
  if (_isIOS) window.visualViewport.addEventListener('scroll', syncMobileViewport);
  var messageInput = document.getElementById('msg-input');
  if (messageInput) {
    messageInput.addEventListener('focus', function () {
      _inputFocusRequestsBottom = !!state.appState.session
        && state.appState.session !== '__new__';
    });
    messageInput.addEventListener('blur', function () {
      _inputFocusRequestsBottom = false;
    });
  }
  syncMobileViewport();
}

// Match React Native's keyboardShouldPersistTaps="never": while a composer
// keyboard is open, the first tap outside its input area only dismisses it.
// Consume the whole pointer/click sequence so expandable IN/OUT content does
// not also toggle and disturb streaming bottom-follow.
if (_isMobile) {
  var _dismissKeyboardTap = false;
  var _dismissKeyboardTimer = null;
  var clearDismissKeyboardTap = function () {
    _dismissKeyboardTap = false;
    clearTimeout(_dismissKeyboardTimer);
    _dismissKeyboardTimer = null;
  };
  var consumeDismissKeyboardEvent = function (event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  window.addEventListener('pointerdown', function (event) {
    var input = document.activeElement;
    if (!input?.matches('#msg-input, #gitStatusPage:not([hidden]) .git-commit-input')
      || !_mobileKeyboardOpen
      || event.target === input
      || (input.id === 'msg-input' && event.target.closest?.('#input-bar'))) {
      return;
    }
    _dismissKeyboardTap = true;
    input.blur();
    consumeDismissKeyboardEvent(event);
    clearTimeout(_dismissKeyboardTimer);
    _dismissKeyboardTimer = setTimeout(clearDismissKeyboardTap, 500);
  }, true);

  window.addEventListener('pointerup', function (event) {
    if (_dismissKeyboardTap) consumeDismissKeyboardEvent(event);
  }, true);

  window.addEventListener('click', function (event) {
    if (!_dismissKeyboardTap) return;
    consumeDismissKeyboardEvent(event);
    clearDismissKeyboardTap();
  }, true);

  window.addEventListener('pointercancel', clearDismissKeyboardTap, true);
}

// Mirrors CC's SKIP_FIRST_PROMPT_PATTERN — kept in sync with bridge/session.mjs.
var SKIP_FIRST_PROMPT = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

function extractFirstPromptFromMsg(msg) {
  if (msg.type !== 'user') return '';
  var c = msg.content;
  var texts = [];
  if (typeof c === 'string') texts = [c];
  else if (Array.isArray(c)) {
    for (var i = 0; i < c.length; i++) {
      if (c[i] && c[i].type === 'text' && c[i].text) texts.push(c[i].text);
    }
  }
  for (var j = 0; j < texts.length; j++) {
    var t = attachmentPreviewText(texts[j]).replace(/\n/g, ' ').trim();
    if (!t) continue;
    var bash = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(t);
    if (bash) return '! ' + bash[1].trim();
    if (SKIP_FIRST_PROMPT.test(t)) continue;
    return t.length > 200 ? t.slice(0, 200).trim() + '…' : t;
  }
  return '';
}

function isInheritedAgentContext(message, messages) {
  if (state.appState.runtime !== 'codex'
    || !state.rootSessionId
    || state.activeThreadId === state.rootSessionId
    || message?.type !== 'user') {
    return false;
  }
  for (var candidate of messages || []) {
    if (!extractFirstPromptFromMsg(candidate)) continue;
    return candidate === message;
  }
  return false;
}

function updateTitleFromMessages() {
  var customTitle = '', aiTitle = '', lastPrompt = '', firstUser = '';
  for (var i = 0; i < state.wsAllMessages.length; i++) {
    var m = state.wsAllMessages[i];
    if (m.type === 'custom-title' && m.content) customTitle = m.content;
    if (m.type === 'ai-title' && m.content) aiTitle = m.content;
    if (m.type === 'last-prompt' && m.content) lastPrompt = m.content;
    if (!firstUser) {
      var fp = extractFirstPromptFromMsg(m);
      if (fp) firstUser = fp;
    }
  }
  var tier = customTitle ? 4 : aiTitle ? 3 : lastPrompt ? 2 : firstUser ? 1 : 0;
  if (state._titleRename?.sessionId === state.appState.session) {
    if (customTitle !== state._titleRename.name) return;
    state._titleRename = null;
  }
  if (tier === 0) return;
  if (tier < (state._titleTier || 0)) return;
  var title = attachmentPreviewText(customTitle || aiTitle || lastPrompt || firstUser);
  if (title === state.appState.sessionPreview) return;
  state.appState.sessionPreview = title;
  if (state.activeThreadId === state.rootSessionId) {
    state.rootSessionPreview = title;
  }
  state._titleTier = tier;
  updateBreadcrumb();
  saveNav();
}

// Skeleton → empty state + stop spinner, when a synced session has no real messages. Never wipe mid-send/stream: a fresh session has 0 DDB rows but a live bubble on screen.
function showEmptyMessages() {
  if (state.pendingSentMessages.length || state.wsRunning) return;
  var content = document.getElementById('content');
  if (content && !state.wsAllMessages.length) {
    var promptActive = typeof hasActivePermissionPrompt === 'function'
      && hasActivePermissionPrompt();
    if (!promptActive) {
      content.innerHTML = '<div class="messages runtime-' + state.appState.runtime
        + '"><div class="empty">No messages</div></div>';
    }
    if (typeof revealDeferredPermissionPrompt === 'function') {
      revealDeferredPermissionPrompt();
    }
  }
  state.wsRunning = false;
  updateSendBtn();
}

function connectWs(_, projectHash) {
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  if (projectHash) {
    state.wsProjectHash = projectHash;
    state.wsRequestId = crypto.randomUUID ? crypto.randomUUID() : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }
  if (!state.WS_URL) {
    // First launch + no cached _wsurl: one config request owns the eventual
    // connection. Concurrent callers (page setup + a fast first send) share it.
    var generation = _wsConnectionGeneration;
    if (_wsConfigRequest?.generation === generation) return;
    var request = { generation: generation, promise: null };
    _wsConfigRequest = request;
    request.promise = api('/api/bridge/config').then(function (cfg) {
      if (generation !== _wsConnectionGeneration) return;
      if (cfg.wsUrl) {
        state.WS_URL = cfg.wsUrl;
        localStorage.setItem('_wsurl', cfg.wsUrl);
        connectWs();
      }
    }).catch(function () {}).finally(function () {
      if (_wsConfigRequest === request) _wsConfigRequest = null;
    });
    return;
  }
  if (state.ws
    && (state.ws.readyState === WebSocket.OPEN
      || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.onmessage = null;
    state.ws.close();
    state.ws = null;
  }
  _realtimeReceiver?.dispose();
  _realtimeReceiver = null;
  state.wsRealtimeStatusText = '';
  state.ws = new WebSocket(state.WS_URL + '?apiKey=' + state.KEY + '&role=app&realtime=1');

  state.ws.onopen = function () {
    var receiver = new RealtimeReceiver({
      control: state.ws, key: state.KEY, receive: handleWsMessage,
      onStatusChange: function (status) {
        if (_realtimeReceiver === receiver) setRealtimeStatus(status);
      },
    });
    _realtimeReceiver = receiver;
    setWsStatus('connected');
    recoverSubscribedSession();
    if (_wsSendQueue.length) {
      var queued = _wsSendQueue;
      _wsSendQueue = [];
      for (var qi = 0; qi < queued.length; qi++) wsSend(queued[qi]);
    }
    if (window.prefetchCommands) window.prefetchCommands();
    window.refreshGitStatusOnReconnect?.();
    _realtimeReceiver.start();
  };

  state.ws.onmessage = function (e) {
    var message = JSON.parse(e.data);
    if (_realtimeReceiver?.handle(message)) return;
    handleWsMessage(message);
  };

  state.ws.onclose = function () {
    _realtimeReceiver?.dispose();
    _realtimeReceiver = null;
    state.wsRealtimeStatusText = '';
    if (window.resetCommandRequest) window.resetCommandRequest();
    setWsStatus('disconnected');
    if (state.appState.session || state.projectFilesOpen || state.gitStatusOpen) {
      setWsStatus('reconnecting');
      _wsReconnectTimer = setTimeout(function () {
        _wsReconnectTimer = null;
        if (state.appState.session || state.projectFilesOpen || state.gitStatusOpen) connectWs();
      }, 3000);
    }
  };

  state.ws.onerror = function () {};
}

function recoverSubscribedSession() {
  if (!state.wsSessionId) return false;
  if (_historyFetchBarriers.current(state.wsSessionId)) {
    subscribeSession(state.wsSessionId);
  } else {
    refreshSessionMessages();
  }
  return true;
}

function resumeSessionForeground() {
  if (!state.appState.session || !state.WS_URL) return false;
  if (state.ws?.readyState === WebSocket.OPEN) {
    refreshSessionMessages();
  } else if (state.ws?.readyState !== WebSocket.CONNECTING) {
    connectWs();
  }
  return true;
}

function handleWsMessage(msg) {
    routeTurnEvent(msg);
}

function strictEventKey(message) {
  return message?.turnId && Number.isInteger(message.seq)
    ? message.turnId + ':' + message.seq
    : '';
}

function isControlEvent(message) {
  return message?.action === 'permission_request'
    || message?.action === 'permission_resolved';
}

function dispatchControlEvent(message) {
  var eventKey = strictEventKey(message);
  if (eventKey && _handledControlEvents.has(eventKey)) return false;
  if (eventKey) {
    _handledControlEvents.add(eventKey);
    var timer = _controlEventTimers.get(eventKey);
    if (timer) clearTimeout(timer);
    _controlEventTimers.delete(eventKey);
  }

  var requestId = message.requestId || '';
  var requestState = requestId
    ? (_controlRequestState.get(requestId) || {
      requestSeq: -1,
      resolvedSeq: -1,
    })
    : null;
  var seq = Number.isInteger(message.seq) ? message.seq : Number.MAX_SAFE_INTEGER;

  if (message.action === 'permission_request') {
    if (requestState) {
      requestState.requestSeq = Math.max(requestState.requestSeq, seq);
      _controlRequestState.set(requestId, requestState);
      if (requestState.resolvedSeq >= seq) return true;
    }
    if (message.sessionId === state.wsSessionId) {
      state.wsRunning = false;
      updateSendBtn();
      if (typeof showPermissionPrompt === 'function') {
        showPermissionPrompt(message);
      }
    }
    return true;
  }

  if (requestState) {
    requestState.resolvedSeq = Math.max(requestState.resolvedSeq, seq);
    _controlRequestState.set(requestId, requestState);
  }
  if (message.sessionId === state.wsSessionId) {
    if (typeof resolvePermissionPrompt === 'function') {
      resolvePermissionPrompt(requestId);
    }
    state.wsRunning = resolveControlActivity({
      activityHint: message.activity,
      hasOutstandingTurns: hasOutstandingTurns(),
    }) === 'running';
    updateSendBtn();
  }
  return true;
}

function scheduleControlEventFallback(message) {
  var eventKey = strictEventKey(message);
  if (!eventKey || _handledControlEvents.has(eventKey)
    || _controlEventTimers.has(eventKey)) {
    return;
  }
  var timer = setTimeout(function () {
    _controlEventTimers.delete(eventKey);
    if (message.sessionId === state.wsSessionId) dispatchControlEvent(message);
  }, CONTROL_EVENT_FALLBACK_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  _controlEventTimers.set(eventKey, timer);
}

function bufferPreAdoptionTurnEvent(message) {
  if (state.appState.session !== '__new__'
    || state.wsSessionId
    || !message?.sessionId
    || !message.turnId
    || !Number.isInteger(message.seq)
    || !findPending(message.turnId)) {
    return false;
  }
  var events = _preAdoptionTurnEvents.get(message.turnId) || [];
  events.push(message);
  _preAdoptionTurnEvents.set(message.turnId, events);
  return true;
}

function drainPreAdoptionTurnEvents(sessionId, turnId) {
  var events = _preAdoptionTurnEvents.get(turnId) || [];
  _preAdoptionTurnEvents.delete(turnId);
  for (var event of events) {
    if (event.sessionId === sessionId) routeTurnEvent(event);
  }
}

function routeTurnEvent(message) {
  if (bufferPreAdoptionTurnEvent(message)) return;
  var barrier = _historyFetchBarriers.current(message.sessionId);
  if (barrier && message.sessionId === barrier.sessionId
    && (isStrictTurnEvent(message) || message.action === 'messages')) {
    barrier.capture(message);
    return;
  }
  if (message.executionId && Number.isInteger(message.executionSeq) && !message._executionOrdered) {
    for (var event of _executionEvents.push(message)) routeTurnEvent(event);
    scheduleExecutionRecovery(message);
    return;
  }
  if ((message.action === 'messages' || message.action === 'stream_end')
    && Array.isArray(message.messages)) {
    message = {
      ...message,
      messages: message.truncated === true
        ? []
        : message.messages.filter(item => item?.truncated !== true),
    };
  }
  if (!isStrictTurnEvent(message)) {
    dispatchWsMessage(message);
    return;
  }
  var ordered = _turnEventQueue.push(message);
  var orderedEnd = ordered.some(function (event) {
    return event.action === 'stream_end';
  });
  if (orderedEnd) clearGappedEndTimer(message.turnId);
  for (var index = 0; index < ordered.length; index++) {
    dispatchWsMessage(ordered[index]);
  }
  if (message.action === 'stream_end' && !orderedEnd) {
    var hasEndAuthority = Array.isArray(message.messages) && message.messages.length;
    if (hasEndAuthority && _turnEventQueue.isLateJoinCandidate(message.turnId)) {
      completeLateJoinTurn(message.turnId);
    } else if (hasEndAuthority
      && _turnEventQueue.isGappedEndCandidate(message.turnId)) {
      completeGappedTurn(message.turnId);
    } else if (_turnEventQueue.isLateJoinCandidate(message.turnId)
      || _turnEventQueue.isGappedEndCandidate(message.turnId)) {
      scheduleGappedEndCompletion(message);
    }
  } else if (_turnEventQueue.isResumeCandidate(message.turnId)) {
    resumeLateJoinAtCheckpoint(message.turnId);
  }
  if (isControlEvent(message)
    && !_handledControlEvents.has(strictEventKey(message))) {
    scheduleControlEventFallback(message);
  }
}

function scheduleExecutionRecovery(message) {
  var id = message.executionId;
  if (!_executionEvents.hasGap(id)) {
    clearTimeout(_executionRecoveryTimers.get(id));
    _executionRecoveryTimers.delete(id);
    return;
  }
  if (_executionRecoveryTimers.has(id)) return;
  var attempt = message._executionRecoveryAttempt || 0;
  var timer = setTimeout(async function () {
    try {
      if (state.wsSessionId !== message.sessionId) return;
      var result = await loadLatestMessages(message.sessionId, { preserveLive: true });
      if (!result?.ok || state.wsSessionId !== message.sessionId) return;
      for (var event of _executionEvents.recover(id)) routeTurnEvent(event);
    } catch (error) {
    } finally {
      _executionRecoveryTimers.delete(id);
      if (attempt < 2 && state.wsSessionId === message.sessionId && _executionEvents.hasGap(id)) {
        scheduleExecutionRecovery({ ...message, _executionRecoveryAttempt: attempt + 1 });
      }
    }
  }, [500, 1500, 3000][attempt]);
  _executionRecoveryTimers.set(id, timer);
}

function clearGappedEndTimer(turnId) {
  var timer = _gappedEndTimers.get(turnId);
  if (timer) clearTimeout(timer);
  _gappedEndTimers.delete(turnId);
}

function scheduleGappedEndCompletion(message) {
  if (_gappedEndTimers.has(message.turnId)) return;
  var timer = setTimeout(function () {
    _gappedEndTimers.delete(message.turnId);
    if (message.sessionId !== state.wsSessionId) return;
    if (_turnEventQueue.isLateJoinCandidate(message.turnId)) {
      completeLateJoinTurn(message.turnId);
    } else if (_turnEventQueue.isGappedEndCandidate(message.turnId)) {
      completeGappedTurn(message.turnId);
    }
  }, GAPPED_END_GRACE_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  _gappedEndTimers.set(message.turnId, timer);
}

function completeLateJoinTurn(turnId) {
  if (!_turnEventQueue.completeLateJoin(turnId)) return false;
  var lateJoins = _turnEventQueue.takeLateJoinCompletions();
  for (var lateIndex = 0; lateIndex < lateJoins.length; lateIndex++) {
    handleLateJoinCompletion(lateJoins[lateIndex]);
  }
  return true;
}

function completeGappedTurn(turnId) {
  if (!_turnEventQueue.completeGappedEnd(turnId)) return false;
  var completions = _turnEventQueue.takeLateJoinCompletions();
  for (var index = 0; index < completions.length; index++) {
    var completion = completions[index];
    if (!completion.gapped) {
      handleLateJoinCompletion(completion);
      continue;
    }
    handleGappedTurnCompletion(completion);
  }
  return true;
}

function handleGappedTurnCompletion(completion) {
  if (!completion || completion.sessionId !== state.wsSessionId) return false;
  updateExecutionEnd(completion.end);
  clearGappedEndTimer(completion.turnId);
  // A missing block-start means strict authority cannot be mapped onto the
  // partial coordinator state. Discard that preview, then render the complete
  // terminal authority as one anchored historical turn.
  _strictStatusAuthority = true;
  _streamCoordinator.settleTurn(completion.turnId);
  _streamCoordinator.takeOperations();
  _strictStreamRenderer?.discardTurn(completion.turnId);
  _queuedTurnIds.delete(completion.turnId);
  _checkpointResumedTurns.delete(completion.turnId);
  settlePendingAtTurnEnd(completion.turnId, completion.end);
  mergeLateJoinAuthority(completion, true);
  consumeExecutionInputs(completion.end || {});
  applyResolvedLiveActivity(hasOutstandingTurns() ? 'running' : 'completed');
  updateSendBtn();
  if (turnCompletionNeedsRecovery(completion)) {
    scheduleTurnEndRecovery(completion.sessionId);
  }
  return true;
}

function resumeLateJoinAtCheckpoint(turnId) {
  var recovery = _turnEventQueue.resumeAtNextCheckpoint(turnId);
  if (!recovery) return false;
  if (!document.querySelector('[data-anchor="' + turnId + '"]')) {
    var hasLoadedUser = !!document.querySelector('.messages > .msg-user');
    console.warn(
      hasLoadedUser
        ? '[ws] late-join turn has no user anchor; holding preview:'
        : '[ws] late-join history has no user messages; appending preview:',
      turnId,
    );
  }
  _checkpointResumedTurns.add(turnId);
  mergeLateJoinAuthority({
    sessionId: recovery.events[0]?.sessionId || state.wsSessionId,
    turnId: turnId,
    messages: recovery.messages,
  }, false);
  for (var event of recovery.events) dispatchWsMessage(event);
  return true;
}

// WS message dispatch — extracted from onmessage for the jsdom test harness.
function dispatchWsMessage(msg) {
    if (msg.action === 'messages' && msg.sessionId === state.wsSessionId) {
      if (msg.messages?.some(function (message) {
        return window.isSubagentNotificationMsg?.(message);
      })) {
        queueAgentThreadRefresh({ delays: [100, 800, 2000] });
      }
      var remainingMessages = handleStrictMessages(msg);
      if (!remainingMessages.length) return;
      msg = Object.assign({}, msg, { messages: remainingMessages });
      var activeStrictTurnId = _streamCoordinator.activeTurnId || '';
      var completeMessages = msg.messages.map(function (message) {
        if (!activeStrictTurnId
          || message.turnId
          || (message.type !== 'assistant' && message.type !== 'summary')) {
          return message;
        }
        return {
          ...message,
          turnId: activeStrictTurnId,
          _strictLifecycle: true,
        };
      });
      var startsExternalTurn = completeMessages.some(function (message) {
        return message.type === 'user'
          && !isInterruptMsg(message)
          && !isToolResultOnly(message);
      });
      if (startsExternalTurn) _strictStatusAuthority = false;
      var merged = commitMessages(completeMessages, {
        liveStateChanged: _strictStatusAuthority && !startsExternalTurn,
      });
      showStats(state.wsMessageCount + ' messages ('
        + merged.inserted.length + ' new via WS)');
    } else if (msg.action === 'permission_request'
      || msg.action === 'permission_resolved') {
      dispatchControlEvent(msg);
    } else if (msg.action === 'send_message_received') {
      var receivedPending = msg.turnId ? findPending(msg.turnId) : null;
      if (receivedPending) receivedPending.serverReceived = true;
    } else if (msg.action === 'send_message_result') {
      if (msg.deviceName && state.appState.device && msg.deviceName !== state.appState.device) return;
      if (msg.sessionId && state.wsSessionId && msg.sessionId !== state.wsSessionId
        && state.appState.session !== '__new__') return;
      // Acks are identity-only. An unscoped ack cannot safely choose among
      // multiple pending sends, so it never mutates optimistic UI state.
      if (state.pendingSentMessages.length) {
        var pending = msg.turnId ? findPending(msg.turnId) : null;
        if (pending && msg.errorCode === 'bridge_offline') {
          pending.serverReceived = false;
          schedulePendingTransportRetry(pending);
          return;
        }
        if (pending && msg.ok && msg.queued) {
          pending.queued = true;
          applyResolvedLiveActivity(
            hasOutstandingTurns() ? 'running' : 'completed',
          );
          updateSendBtn();
          return;
        }
        if (pending && !pending.delivered && handleCodexSendConflict(pending, msg)) return;
        if (pending && !pending.delivered) {
          finishCodexTakeover(pending);
          if (msg.ok && msg.commandOutput != null) {
            completeLocalCommand(pending, msg);
            applyCodexCommandAction(msg.commandAction);
          } else if (msg.ok && msg.commandNoEcho) {
            markPendingTime(pending);
            promoteEchoedBubble(pending, { timestamp: new Date().toISOString() });
          } else {
            resolvePending(pending, msg.ok, msg.error);
            if (msg.ok && pending.turnEnded) {
              promoteEchoedBubble(pending, {});
            }
          }
        }
      }
      if (!msg.ok && msg.turnId) {
        rememberLatestSend(msg.turnId, true);
      }
      applyResolvedLiveActivity(
        hasOutstandingTurns() ? 'running' : 'completed',
      );
      updateSendBtn();
      // New session: adopt only the result that belongs to this tab's pending
      // turn. Current Bridges echo requestId; legacy unscoped results are safe
      // only when their turnId matches this page's optimistic prompt.
      var matchesNewSessionResult = msg.requestId
        ? msg.requestId === state.wsRequestId
        : !!(msg.turnId && (
          pending
          || document.querySelector(
            '.msg-user[data-anchor="' + msg.turnId + '"]',
          )
        ));
      if (msg.sessionId
        && state.appState.session === '__new__'
        && matchesNewSessionResult) {
        state.appState.session = msg.sessionId;
        state.appState.sessionPreview = 'New Session';
        state.rootSessionId = msg.sessionId;
        state.rootSessionPreview = state.appState.sessionPreview;
        state.activeThreadId = msg.sessionId;
        state.activeThreadCanSend = true;
        state.threadRequestVersion++;
        state.sessionThreads = [{
          sessionId: msg.sessionId,
          preview: state.rootSessionPreview,
          status: 'running',
          threadKind: 'main',
          canSend: true,
          runtime: state.appState.runtime,
        }];
        updateBreadcrumb();
        saveNav();
        rekeyComposerDraft(msg.sessionId);
        state.wsRequestId = null;
        adoptNewSession(msg.sessionId);
        var loading = loadLatestMessages(msg.sessionId, { preserveLive: true });
        drainPreAdoptionTurnEvents(msg.sessionId, msg.turnId);
        loading.then(function () {
          if (state.wsSessionId === msg.sessionId) {
            state._syncedOnce = msg.sessionId;
          }
        }).catch(function () {});
      }
    } else if (msg.action === 'sync_complete') {
      if (msg.sessionId !== state.wsSessionId) return;
      // No real messages (not_found / synced 0) → clear skeleton, don't hang.
      if (msg.status === 'not_found' || msg.count === 0) {
        var hasLocalMessages = state.pendingSentMessages.length > 0
          || state.wsAllMessages.length > 0
          || !!document.querySelector('.messages .msg-user');
        if (!hasLocalMessages) showEmptyMessages();
        return;
      }
      if (state._syncedOnce === msg.sessionId) return;
      state._syncedOnce = msg.sessionId;
      // Re-fetch + render once. Don't call loadMessages — that resets sessionPreview/_titleTier
      // and re-triggers needSync, causing a render-loop with title flicker.
      loadLatestMessages(msg.sessionId).catch(function () {});
    } else if (msg.action === 'session_threads_changed') {
      if (msg.deviceName && msg.deviceName !== state.appState.device) return;
      var rootChange = (msg.roots || []).find(function (root) {
        return root.rootSessionId === state.rootSessionId
          && root.projectHash === state.appState.project?.hash;
      });
      if (!rootChange) return;
      queueAgentThreadRefresh({
        expected: rootChange,
        delays: [150, 900, 2200],
      });
    } else if (msg.action === 'bridge_recovery_complete') {
      if (!state.wsSessionId || msg.deviceName !== state.appState.device) return;
      queueAgentThreadRefresh({ delays: [150, 1000] });
      refreshSessionMessages();
    } else if (msg.action === 'session_title_changed') {
      window.applySessionTitle?.(msg);
    } else if (msg.action === 'rename_session') {
      if (msg.ok) window.applySessionTitle?.(msg);
      handleWsRpcMessage(msg);
    } else if (msg.action === 'project_files' || msg.action === 'git_status') {
      handleWsRpcMessage(msg);
    } else if (msg.action === 'file_ready') {
      if (window.handleFileReady) window.handleFileReady(msg);
    } else if (msg.action === 'file_progress') {
      if (window.handleFileProgress) window.handleFileProgress(msg);
    } else if (msg.action === 'command_catalog_ready') {
      if (window.handleCommandCatalogReady) window.handleCommandCatalogReady(msg);
    } else if (msg.action === 'command_options') {
      if (window.handleCommandOptions) window.handleCommandOptions(msg);
    } else if (msg.action === 'stream_turn_start') {
      if (isStrictTurnEvent(msg)) handleStrictTurnStart(msg);
    } else if (msg.action === 'stream_delta') {
      if (isStrictTurnEvent(msg)) handleStrictFrame(msg, 'delta');
    } else if (msg.action === 'stream_tool_input') {
      if (isStrictTurnEvent(msg)) handleStrictFrame(msg, 'input');
    } else if (msg.action === 'stream_block_start') {
      if (isStrictTurnEvent(msg)) handleStrictFrame(msg, 'start');
    } else if (msg.action === 'stream_block_stop') {
      if (isStrictTurnEvent(msg)) handleStrictFrame(msg, 'stop');
    } else if (msg.action === 'stream_end') {
      if (isStrictTurnEvent(msg)) handleStrictTurnEnd(msg);
    } else if (msg.action === 'delete_files_result') {
      var r = window._deleteFilesResolvers && window._deleteFilesResolvers[msg.requestId];
      if (r) { delete window._deleteFilesResolvers[msg.requestId]; r(msg); }
    } else if (msg.action === 'create_project_result') {
      if (state._pendingCreatePath && msg.projectPath === state._pendingCreatePath) {
        state._pendingCreatePath = null;
        if (msg.ok) {
          closeNewProjectModal();
          // Empty project isn't in the list yet (no session) — go straight to its
          // new-session input; the first message creates the session + PROJ#/SESS#.
          // Set project so the breadcrumb shows its name (we arrive from device level, not the list).
          // Fallback to the hash's trailing segment (…-test3 → test3) if projectName is absent.
          var pname = msg.projectName || (msg.projectHash || '').split('-').filter(Boolean).pop() || msg.projectHash;
          state.appState.project = { hash: msg.projectHash, name: pname };
          startNewSession(msg.projectHash);
        } else {
          disconnectWs();
          // Show error in modal, reset button
          var err = document.getElementById('newProjectError');
          var input = document.getElementById('newProjectInput');
          var btn = document.querySelector('#newProjectModal .modal-btn.confirm');
          if (err) err.textContent = msg.error || 'Unknown error';
          if (input) input.disabled = false;
          setButtonLoading(btn);
        }
      }
    }
}

function isStrictTurnEvent(message) {
  return message?.sessionId === state.wsSessionId
    && !!message.turnId
    && Number.isInteger(message.seq);
}

function strictMessageIdentity(envelope, message, index) {
  var turnId = envelope.turnId || '';
  if (!turnId || !Number.isInteger(envelope.seq)) return null;
  return {
    sessionId: envelope.sessionId,
    turnId: turnId,
    messageId: message.nativeId || message.uuid || '',
    seq: envelope.seq,
  };
}

function getStrictStreamRenderer() {
  if (_strictStreamRenderer) return _strictStreamRenderer;
  _strictStreamRenderer = new StreamingDomRenderer({
    document: document,
    scheduleFrame: function (callback) {
      return requestAnimationFrame(function (timestamp) {
        callback(timestamp);
        flushBottomFollow();
      });
    },
    getContainer: function () { return document.querySelector('.messages'); },
    findAnchor: function (turnId) {
      return turnId
        ? document.querySelector('[data-anchor="' + turnId + '"]')
        : null;
    },
    canAppendWithoutAnchor: function (container) {
      return !container?.querySelector(':scope > .msg-user');
    },
    renderMarkdown: function (element, text) {
      if (window.renderStreamMd) window.renderStreamMd(element, text);
      else element.textContent = text;
      if (window.renderMermaidBlocks && element.querySelector('.mermaid-block')) {
        window.renderMermaidBlocks(element);
      }
      if (window.renderKatexBlocks) window.renderKatexBlocks(element);
    },
    renderTool: renderStrictToolBlock,
    renderThinking: function (element) {
      if (window.renderThinking) {
        element.innerHTML = window.renderThinking({ thinking: '' });
      }
    },
    onBlockRevealComplete: function (turnId, blockId) {
      _streamCoordinator.completeBlockReveal(turnId, blockId);
      drainStrictStreamOperations();
    },
    onMutation: function (element, mutation) {
      var container = document.querySelector('.messages');
      if (mutation?.structureChanged
        || element?.classList.contains('assistant-turn')
        || element?.classList.contains('tool-node')) {
        markTurnAdjacency(container);
      }
      if (element?.classList.contains('tool-run-group-hidden')
        || element?.classList.contains('tool-run-row-hidden')) return;
      followBottomAfterLayout();
    },
  });
  return _strictStreamRenderer;
}

function renderStrictToolBlock(element, block) {
  var collapsed = element.querySelector(':scope > .tool-header.tool-details-toggle')
    ? element.classList.contains('tool-details-collapsed')
    : !!window.getToolDetailPolicy?.(state.appState.runtime)?.realtimeCollapsed;
  var raw = block.inputJson || '';
  var input = {};
  var parsed = false;
  if (raw) {
    try {
      input = JSON.parse(raw);
      parsed = true;
    } catch (error) {}
  }
  if (parsed && window.renderToolNode) {
    var toolUse = {
      type: 'tool_use',
      id: block.toolUseId || '',
      name: block.name || 'Tool',
      input: input,
    };
    window._lastToolState = '';
    element.innerHTML = renderToolNode(toolUse, null, state.appState.runtime, {
      collapsed: collapsed,
    });
    var toolState = window._lastToolState || 'tool-running';
    var commandClass = '';
    if (state.appState.runtime === 'codex'
      && window.isCodexMcpTool?.(toolUse)) {
      commandClass = ' codex-called';
    } else if (toolUse.name === 'Bash') {
      commandClass = state.appState.runtime === 'codex'
        ? (isLiveCodexExplore(toolUse.name, input) ? ' codex-explore' : ' codex-ran')
        : ' claude-bash';
    }
    element.className = 'tl-item tool-node ' + toolState + commandClass;
    window.setToolDetailsCollapsed?.(element, !!window._lastToolHasDetails && collapsed);
    if (block.toolUseId) element.dataset.toolId = block.toolUseId;
    if (toolUse.name === 'TodoWrite') {
      element.dataset.codexPlan = '1';
    }
    scheduleAgentThreadRefresh(toolUse.name);
    return;
  }
  var label = block.name || 'Tool';
  var description = raw ? previewPartialInput(raw) : '';
  var displayLabel = state.appState.runtime === 'codex' && label === 'Bash'
    ? 'Ran'
    : label;
  var fallbackCommandClass = label === 'Bash'
    ? (state.appState.runtime === 'codex' ? ' codex-ran' : ' claude-bash')
    : '';
  element.className = 'tl-item tool-node tool-running' + fallbackCommandClass;
  element.innerHTML = '<div class="tool-header"><span class="tool-name">'
    + esc(displayLabel) + '</span><span class="tool-desc">'
    + esc(description) + '</span><span class="tool-status">running</span></div>';
  window.setToolDetailsCollapsed?.(element, collapsed);
}

function applyToolResultMessages(messages) {
  var resultMessages = (messages || []).filter(isToolResultOnly);
  if (!resultMessages.length) return false;
  var container = document.querySelector('.messages');
  if (!container) return false;

  var toolUses = new Map();
  for (var message of state.wsAllMessages) {
    if (!Array.isArray(message?.content)) continue;
    for (var block of message.content) {
      if (block?.type === 'tool_use' && block.id) {
        toolUses.set(block.id, block);
      }
    }
  }

  var changed = false;
  for (var resultMessage of resultMessages) {
    for (var source of resultMessage.content || []) {
      if (source?.type !== 'tool_result'
        || !source.tool_use_id
        || source.codexSuperseded) {
        continue;
      }
      var toolUse = toolUses.get(source.tool_use_id);
      var node = container.querySelector(
        '[data-tool-id="' + source.tool_use_id + '"]',
      );
      if (!toolUse || !node) continue;

      var result = {
        ...source,
        ...(resultMessage.toolUseResult
          ? { _agentMeta: resultMessage.toolUseResult }
          : {}),
      };
      var collapsed = node.querySelector(':scope > .tool-header.tool-details-toggle')
        ? node.classList.contains('tool-details-collapsed')
        : !!window.getToolDetailPolicy?.(state.appState.runtime)?.realtimeCollapsed;
      var committed = node.classList.contains('stream-block-committed');
      window._lastToolState = '';
      node.innerHTML = renderToolNode(
        toolUse,
        result,
        state.appState.runtime,
        { collapsed: collapsed },
      );

      var classes = ['tl-item', 'tool-node'];
      if (committed) classes.push('stream-block-committed');
      if (state.appState.runtime === 'codex'
        && window.isCodexMcpTool?.(toolUse, result)) {
        classes.push('codex-called');
      } else if (state.appState.runtime === 'codex'
        && window.isCodexExploreTool?.(toolUse, result)) {
        classes.push('codex-explore');
      } else if (state.appState.runtime === 'codex'
        && toolUse.name === 'Bash') {
        classes.push('codex-ran');
      } else if (state.appState.runtime === 'claude'
        && toolUse.name === 'Bash') {
        classes.push('claude-bash');
      }
      if (state.appState.runtime === 'codex'
        && toolUse.name === 'WriteStdin'
        && !String(toolUse.input?.chars || '').length) {
        classes.push('codex-terminal-wait');
      }
      if (result.codexBackground === 'complete') {
        classes.push('codex-background-complete');
      }
      if (window._lastToolState) classes.push(window._lastToolState);
      node.className = classes.join(' ');
      if (toolUse.name === 'TodoWrite') node.dataset.codexPlan = '1';
      window.setToolDetailsCollapsed?.(node, collapsed);
      if (result.codexProcessId) {
        node.dataset.codexProcess = result.codexProcessId;
      }
      changed = true;
    }
  }
  if (changed) {
    if (state.appState.runtime === 'codex') {
      window.normalizeCodexWaitGroups?.(container);
    }
    window.markToolRunGroups?.(container);
    window.afterToolDomMutation?.(container);
  }
  return changed;
}

function scheduleAgentThreadRefresh(toolName) {
  if (toolName !== 'spawn_agent' && toolName !== 'Agent') return;
  queueAgentThreadRefresh({ delays: [500, 1500, 3500] });
}

function agentThreadSummaryMatches(threads, expected) {
  if (!expected) return false;
  var agents = (threads || []).filter(function (thread) {
    return thread.sessionId !== state.rootSessionId;
  });
  var running = agents.filter(function (thread) {
    return thread.status === 'running';
  }).length;
  var needsInput = agents.filter(function (thread) {
    return thread.status === 'needs_input';
  }).length;
  return agents.length === Number(expected.agentCount || 0)
    && running === Number(expected.runningAgentCount || 0)
    && needsInput === Number(expected.needsInputAgentCount || 0);
}

function queueAgentThreadRefresh(options) {
  options = options || {};
  if (!state.rootSessionId) return;
  var rootSessionId = state.rootSessionId;
  var delays = options.delays || [250];
  var expected = options.expected || null;
  var version = ++_agentThreadRefreshVersion;
  clearTimeout(_agentThreadRefreshTimer);

  function schedule(index) {
    if (index >= delays.length) return;
    _agentThreadRefreshTimer = setTimeout(async function () {
      _agentThreadRefreshTimer = null;
      if (version !== _agentThreadRefreshVersion
        || rootSessionId !== state.rootSessionId) return;
      var threads = null;
      try {
        threads = await window.refreshSessionThreads?.();
      } catch (error) {}
      if (version !== _agentThreadRefreshVersion
        || rootSessionId !== state.rootSessionId) return;
      if (expected && agentThreadSummaryMatches(threads, expected)) return;
      schedule(index + 1);
    }, delays[index]);
  }

  schedule(0);
}

function drainStrictStreamOperations() {
  if (_historyFetchBarriers.current(state.wsSessionId)
    || document.querySelector('.skeleton-messages')) return;
  var operations = _streamCoordinator.takeOperations();
  if (!operations.length) return;
  var completedTurn = false;
  getStrictStreamRenderer().applyOperations(operations);
  for (var operation of operations) {
    if (operation.type === 'createTurn') {
      state.wsRunning = true;
    } else if (operation.type === 'completeTurn') {
      completedTurn = true;
      _queuedTurnIds.delete(operation.turnId);
      _checkpointResumedTurns.delete(operation.turnId);
    }
  }
  applyResolvedLiveActivity(
    hasOutstandingTurns() ? 'running' : 'completed',
  );
  if (completedTurn && !state.wsRunning && typeof window.markSpinnerTurnEnd === 'function') {
    window.markSpinnerTurnEnd();
  }
  updateSendBtn();
}

function handleStrictTurnStart(message) {
  if (message.executionId) _activeExecutionIds.add(message.executionId);
  _strictStatusAuthority = true;
  _queuedTurnIds.delete(message.turnId);
  _streamCoordinator.startTurn(message);
  drainStrictStreamOperations();
  state.wsRunning = true;
  updateSendBtn();
}

function handleStrictFrame(message, type) {
  _streamCoordinator.ingestFrame({
    sessionId: message.sessionId,
    turnId: message.turnId,
    seq: message.seq,
    type: type,
    kind: message.kind,
    name: message.name,
    chunk: message.chunk,
  });
  drainStrictStreamOperations();
}

function handleStrictTurnEnd(message) {
  updateExecutionEnd(message);
  clearGappedEndTimer(message.turnId);
  _strictStatusAuthority = true;
  var endMessages = Array.isArray(message.messages)
    ? message.messages.slice()
    : [];
  var completed = endMessages.length
    ? Object.assign({}, message, { messages: endMessages })
    : message;
  if (_checkpointResumedTurns.has(message.turnId)) {
    mergeLateJoinAuthority({
      sessionId: message.sessionId,
      turnId: message.turnId,
      messages: endMessages,
      end: message,
    }, false, true);
  } else if (endMessages.length) {
    handleStrictMessages({
      action: 'messages',
      sessionId: message.sessionId,
      turnId: message.turnId,
      seq: message.seq,
      messages: endMessages,
      terminal: true,
    });
  }
  _streamCoordinator.endTurn(message);
  drainStrictStreamOperations();
  _turnEventQueue.closeTurn(message.turnId);
  _queuedTurnIds.delete(message.turnId);
  _checkpointResumedTurns.delete(message.turnId);
  settlePendingAtTurnEnd(message.turnId, message);
  consumeExecutionInputs(message);
  applyResolvedLiveActivity(
    hasOutstandingTurns() ? 'running' : 'completed',
  );
  updateSendBtn();
  if (message.recoveryRequired) {
    scheduleTurnEndRecovery(message.sessionId);
  }
}

function scheduleTurnEndRecovery(sessionId, attempt) {
  if (_suppressTurnEndRecovery) return;
  attempt = attempt || 0;
  var delays = [150, 800, 2000];
  setTimeout(function () {
    if (state.wsSessionId !== sessionId) return;
    loadLatestMessages(sessionId, { preserveLive: true }).then(function (result) {
      if (state.wsSessionId !== sessionId) return;
      if (attempt + 1 < delays.length
        && (!result || result.status === 'running')) {
        scheduleTurnEndRecovery(sessionId, attempt + 1);
      }
    }).catch(function () {
      if (attempt + 1 < delays.length) {
        scheduleTurnEndRecovery(sessionId, attempt + 1);
      }
    });
  }, delays[attempt]);
}

function handleLateJoinCompletion(completion) {
  updateExecutionEnd(completion.end);
  clearGappedEndTimer(completion.turnId);
  mergeLateJoinAuthority(completion, true);
  settlePendingAtTurnEnd(completion.turnId, completion.end);
  consumeExecutionInputs(completion.end || {});
  applyResolvedLiveActivity(
    hasOutstandingTurns() ? 'running' : 'completed',
  );
  updateSendBtn();
  if (turnCompletionNeedsRecovery(completion)) {
    scheduleTurnEndRecovery(completion.sessionId);
  }
}

function updateExecutionEnd(message) {
  if (!message?.executionId) return;
  if (message.continued === true) _activeExecutionIds.add(message.executionId);
  else _activeExecutionIds.delete(message.executionId);
}

function turnCompletionNeedsRecovery(completion) {
  return completion.end?.recoveryRequired === true;
}

function mergeLateJoinAuthority(completion, completed, terminal) {
  if (!completion || completion.sessionId !== state.wsSessionId) return;
  terminal = !!terminal || !!completed;
  var incoming = [];
  for (var source of completion.messages || []) {
    if (!source) continue;
    incoming.push(Object.assign({}, source, {
      turnId: source.turnId || completion.turnId || '',
    }));
  }
  if (completed) _strictStatusAuthority = true;
  if (completed) _queuedTurnIds.delete(completion.turnId);
  var merged = commitMessages(incoming, {
    authoritative: terminal,
  });
  _strictStreamRenderer?.attachTurnToAnchor(completion.turnId);
  if (completed) {
    var renderer = getStrictStreamRenderer();
    renderer.createTurn({ turnId: completion.turnId });
    renderer.applyOperation({
      type: 'completeTurn',
      turnId: completion.turnId,
    });
  }
  if (merged.inserted.length || merged.patched.length) {
    showStats(state.wsMessageCount + ' messages (late join)');
  }
  applyResolvedLiveActivity(
    hasOutstandingTurns() ? 'running' : 'completed',
  );
  updateSendBtn();
}

function handleStrictMessages(envelope) {
  var remaining = [];
  var completeMessages = [];
  var identities = [];
  for (var index = 0; index < envelope.messages.length; index++) {
    var message = envelope.messages[index];
    var identity = strictMessageIdentity(envelope, message, index);
    if (!identity) {
      remaining.push(message);
      continue;
    }
    Object.assign(message, identity, {
      _strictLifecycle: true,
    });
    identities.push(identity);
    completeMessages.push(message);
    _streamCoordinator.ingestAuthoritative({
      ...identity,
      message: message,
    });
  }
  if (completeMessages.length) {
    var needsInterruptDom = completeMessages.some(function (message) {
      return isInterruptMsg(message);
    });
    var needsPromptAnchor = completeMessages.some(function (message) {
      return message.type === 'user'
        && !isInterruptMsg(message)
        && !isToolResultOnly(message);
    }) && !document.querySelector(
      '[data-anchor="' + envelope.turnId + '"]',
    );
    var hasRenderedTurn = !!document.querySelector(
      '[data-turn-id="' + envelope.turnId + '"]',
    );
    var streamTurn = _streamCoordinator.getTurn(envelope.turnId);
    var hasRenderableBlocks = !!streamTurn
      && streamTurn.orderedBlocks().some(function (block) {
        return block.isRenderable();
      });
    var streamOwnsTurn = hasRenderedTurn || hasRenderableBlocks;
    commitMessages(completeMessages, {
      authoritative: !!envelope.terminal,
      deferDom: !needsInterruptDom
        && !needsPromptAnchor
        && (!envelope.terminal || streamOwnsTurn),
      streamTurnIds: streamOwnsTurn
        ? undefined
        : [],
    });
  } else {
    drainStrictStreamOperations();
  }
  if (_strictStreamRenderer) {
    for (var identity of identities) {
      _strictStreamRenderer.attachTurnToAnchor(identity.turnId);
    }
  }
  if (completeMessages.length) {
    showStats(state.wsMessageCount + ' messages (strict live)');
  }
  consumeExecutionInputs(envelope);
  return remaining;
}

function consumeExecutionInputs(envelope) {
  for (var id of envelope.consumedInputIds || []) {
    _queuedTurnIds.delete(id);
    var pending = findPending(id);
    if (!pending || pending.failed) continue;
    var echo = messageEchoed(pending);
    if (echo) promoteEchoedBubble(pending, echo);
    else {
      document.getElementById(id)?.remove();
      removePending(pending);
    }
  }
}

function resetStreamSessionState(keepHistoryRequest = false) {
  if (!keepHistoryRequest) _historyFetchBarriers.invalidate();
  _messagePaginationGeneration++;
  state.wsLoadingOlder = false;
  if (_strictStreamRenderer) _strictStreamRenderer.reset({ remove: !keepHistoryRequest });
  _strictStreamRenderer = null;
  _streamCoordinator.resetSession('');
  _turnEventQueue.reset();
  _checkpointResumedTurns.clear();
  _queuedTurnIds.clear();
  _activeExecutionIds.clear();
  _executionEvents.reset();
  for (var timer of _executionRecoveryTimers.values()) clearTimeout(timer);
  _executionRecoveryTimers.clear();
  _turnSendOrder.clear();
  for (var timer of _controlEventTimers.values()) clearTimeout(timer);
  _controlEventTimers.clear();
  for (var endTimer of _gappedEndTimers.values()) clearTimeout(endTimer);
  _gappedEndTimers.clear();
  _suppressTurnEndRecovery = false;
  _handledControlEvents.clear();
  _controlRequestState.clear();
  _preAdoptionTurnEvents.clear();
  clearTimeout(_agentThreadRefreshTimer);
  _agentThreadRefreshTimer = null;
  _agentThreadRefreshVersion++;
  resetTurnLifecycle();
  _strictStatusAuthority = false;
}

function selectWsSession(sessionId) {
  var rootSessionId = state.rootSessionId || sessionId || '';
  if (state.wsSessionId === sessionId
    && state.wsRootSessionId === rootSessionId) return;
  if (state.wsSessionId) {
    wsSend({
      action: 'unsubscribe',
      sessionId: state.wsSessionId,
      rootSessionId: state.wsRootSessionId || state.wsSessionId,
    });
  }
  window.resetToolDetails?.();
  resetStreamSessionState();
  state.wsSessionId = sessionId;
  state.wsRootSessionId = rootSessionId;
}

function subscribeSession(sessionId) {
  selectWsSession(sessionId);
  wsSend({
    action: 'subscribe',
    sessionId: sessionId,
    rootSessionId: state.wsRootSessionId || sessionId,
  });
  wsSend({
    action: 'reveal_permission',
    sessionId: sessionId,
    device: state.appState.device || '',
  });
}

// The first send creates a native session while its stream is already active.
// Adopt that server id without resetting the buffer and anchor for the same turn.
function adoptNewSession(sessionId) {
  if (state.wsSessionId && state.wsSessionId !== sessionId) {
    wsSend({
      action: 'unsubscribe',
      sessionId: state.wsSessionId,
      rootSessionId: state.wsRootSessionId || state.wsSessionId,
    });
  }
  state.wsSessionId = sessionId;
  state.wsRootSessionId = state.rootSessionId || sessionId;
  wsSend({
    action: 'subscribe',
    sessionId: sessionId,
    rootSessionId: state.wsRootSessionId,
  });
  wsSend({
    action: 'reveal_permission',
    sessionId: sessionId,
    device: state.appState.device || '',
  });
}

function wsSend(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
  }
}

// Non-OPEN → queue + reconnect (onopen flushes); use for user actions that must not drop.
function wsSendReliable(data) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(data));
    return;
  }
  _wsSendQueue.push(data);
  if (!state.ws || state.ws.readyState === WebSocket.CLOSING || state.ws.readyState === WebSocket.CLOSED) {
    connectWs();
  }
}

function setWsStatus(status) {
  state.wsStatusText = status;
  updateWsStatusIndicator();
}

function setRealtimeStatus(status) {
  var previous = state.wsRealtimeStatusText;
  state.wsRealtimeStatusText = status;
  updateWsStatusIndicator();
  if (status !== previous && (previous === 'connected' || previous === 'reconnecting')) {
    refreshSessionMessages({ preservePending: true });
  }
}

function disconnectWs() {
  _realtimeReceiver?.dispose();
  _realtimeReceiver = null;
  state.wsRealtimeStatusText = '';
  _wsConnectionGeneration++;
  if (window.resetCommandRequest) window.resetCommandRequest();
  if (_wsReconnectTimer) {
    clearTimeout(_wsReconnectTimer);
    _wsReconnectTimer = null;
  }
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
    state.ws = null;
  }
  state.wsSessionId = null;
  state.wsRootSessionId = null;
  state.wsRunning = false;
  window.resetToolDetails?.();
  resetStreamSessionState();
  updateSpinner();
  setWsStatus('');
}

function ensureWsAndSend(data) {
  wsSendReliable(data);
}

var _latestTurnId = '';
var _latestTurnOrder = -1;
var _latestSendFailed = false;
var _interruptedTurns = {};
var _strictStatusAuthority = false;
function isLiveCodexExplore(name, input) {
  if (state.appState.runtime !== 'codex' || name !== 'Bash') return false;
  var actions = Array.isArray(input?.codexCommandActions) ? input.codexCommandActions : [];
  return actions.length > 0 && actions.every(function (action) {
    return ['read', 'list_files', 'search'].includes(action?.type);
  });
}

// Decode \uXXXX / \n etc. from a (possibly incomplete) JSON fragment for readable streaming preview.
function decodeJsonEscapes(s) {
  return String(s).replace(/\\u([0-9a-fA-F]{4})/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\\n/g, ' ').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// One-line header desc from partial JSON: decoded fragment, matching the final card's truncated-JSON desc.
function previewPartialInput(partial) {
  return decodeJsonEscapes(partial).slice(0, 200);
}

function resetTurnLifecycle() {
  _latestTurnId = '';
  _latestTurnOrder = -1;
  _latestSendFailed = false;
  _interruptedTurns = {};
}

function rememberLatestSend(turnId, failed, explicitOrder) {
  var pending = findPending(turnId);
  var order = Number.isInteger(explicitOrder)
    ? explicitOrder
    : (Number.isInteger(pending?.seq) ? pending.seq : null);
  if (turnId !== _latestTurnId && order == null) return;
  if (turnId !== _latestTurnId && order < _latestTurnOrder) return;
  if (turnId !== _latestTurnId) {
    _latestTurnId = turnId;
    _latestTurnOrder = order;
    _latestSendFailed = false;
  }
  if (failed) _latestSendFailed = true;
}

function hasOutstandingTurns() {
  return outstandingTurnIds().length > 0;
}

function outstandingTurnIds() {
  var turnIds = [];
  function add(turnId) {
    if (turnId && !turnIds.includes(turnId)) turnIds.push(turnId);
  }
  for (var turnId of _streamCoordinator.activeTurnIds()) add(turnId);
  for (var executionId of _activeExecutionIds) add(executionId);
  for (var queuedTurnId of _queuedTurnIds) add(queuedTurnId);
  for (var pendingMessage of state.pendingSentMessages) {
    if (!pendingMessage.failed) add(pendingMessage.id);
  }
  return turnIds;
}

function latestOutstandingTurnId() {
  var latestPending = null;
  for (var pending of state.pendingSentMessages) {
    if (pending.failed || pending.sessionId !== state.wsSessionId) continue;
    if (!latestPending || (pending.seq || 0) > (latestPending.seq || 0)) {
      latestPending = pending;
    }
  }
  if (latestPending) return latestPending.id;
  var queued = Array.from(_queuedTurnIds);
  if (queued.length) return queued[queued.length - 1];
  var active = _streamCoordinator.activeTurnIds();
  if (active.length) return active[active.length - 1];
  return '';
}

function activeTurnForInterrupt() {
  if (_streamCoordinator.activeTurnId
    && !_interruptedTurns[_streamCoordinator.activeTurnId]) {
    return _streamCoordinator.activeTurnId;
  }
  if (_latestTurnId && !_latestSendFailed
    && !_interruptedTurns[_latestTurnId]) {
    return _latestTurnId;
  }
  return '';
}

// Cross-turn connector adjacency via explicit classes — replaces :has(+)/+ which WebKit (Safari) won't re-invalidate on live inserts. Call only when a turn is added/removed, never per frame.
function markTurnAdjacency(container) {
  if (!container) return;
  refreshThinkingGroups(container);
  if (state.appState.runtime === 'codex') {
    window.normalizeCodexTimeline?.(container);
  } else {
    window.markToolRunGroups?.(container);
  }
  window.afterToolDomMutation?.(container);
  var kids = container.children;
  for (var i = 0; i < kids.length; i++) {
    var el = kids[i];
    if (!el.classList || !el.classList.contains('assistant-turn')) continue;
    var next = el.nextElementSibling;
    el.classList.toggle('has-next-turn', !!(next && next.classList.contains('assistant-turn')));
    var prev = el.previousElementSibling;
    el.classList.toggle('follows-turn', !!(prev && prev.classList.contains('assistant-turn')));
  }
}
window.markTurnAdjacency = markTurnAdjacency;

function startWs(sessionId) {
  state._syncedOnce = null;
  if (!state.ws) {
    selectWsSession(sessionId);
    connectWs();
  }
  else subscribeSession(sessionId);
  // Prefetch slash commands. When ws already exists this sends now; on a fresh
  // connect the socket isn't OPEN yet so this no-ops and onopen handles it.
  if (window.prefetchCommands) window.prefetchCommands();
}

function currentActivity() {
  if (typeof hasActivePermissionPrompt === 'function'
    && hasActivePermissionPrompt()) {
    return 'needs_input';
  }
  return state.wsRunning ? 'running' : 'completed';
}

function applyResolvedLiveActivity(activity) {
  state.wsRunning = activity === 'running';
}

function prepareCompleteMessages(messages) {
  return dedupeCodexUserMessages((messages || []).filter(Boolean).map(
    function (message) {
      if (!Object.hasOwn(message, '_strictManaged')) return message;
      var confirmed = { ...message };
      delete confirmed._strictManaged;
      return confirmed;
    },
  ));
}

function onlyHiddenToolUpdates(messages, includeCollapsedResults = false) {
  return Array.isArray(messages) && messages.length > 0
    && messages.every(function (message) {
      return Array.isArray(message.content) && message.content.length > 0
        && message.content.every(function (block) {
          if (block.type !== 'tool_use' && block.type !== 'tool_result') return false;
          var toolId = block.type === 'tool_use' ? block.id : block.tool_use_id;
          var node = document.querySelector('.messages [data-tool-id="' + toolId + '"]');
          return node?.classList.contains('tool-run-group-hidden')
            || (includeCollapsedResults && block.type === 'tool_result'
              && node?.classList.contains('tool-details-collapsed')
              && !!node.querySelector('.tool-body'));
        });
    });
}

function commitMessages(messages, options = {}) {
  var wasFollowingBottom = state.stickBottom;
  var hiddenOnlyUpdate = onlyHiddenToolUpdates(messages, true);
  var mergeResult = mergeMessages({
    localMessages: state.wsAllMessages,
    incomingMessages: dedupeMessages(prepareCompleteMessages(messages)),
    authoritative: !!options.authoritative,
    replaceConflicts: true,
  });
  var pending = reconcilePendingMessages(state.pendingSentMessages, mergeResult.messages);
  var activity = resolveActivityState({
    liveStateChanged: !!options.liveStateChanged,
    liveActivity: currentActivity(),
    messages: mergeResult.messages,
    runtime: state.appState.runtime,
    hasOutstandingTurns: hasOutstandingTurns(),
    outstandingTurnIds: outstandingTurnIds(),
  });
  var streamTurnIds = options.streamTurnIds || _streamCoordinator.activeTurnIds();
  var dom = createMessageDom({
    state: state,
    document: document,
    runtime: function () { return state.appState.runtime; },
    renderMessages: renderMessages,
    streamTurnIds: streamTurnIds,
    markTurnAdjacency: markTurnAdjacency,
    loadImages: loadImages,
    clampOverflow: clampOverflow,
    renderMermaidBlocks: window.renderMermaidBlocks,
    renderKatexBlocks: window.renderKatexBlocks,
    updateTitleFromMessages: updateTitleFromMessages,
  });
  var adoptsActiveStreamTurn = mergeResult.patched
    .concat(mergeResult.identityUpdated)
    .some(function (change) {
      return !change.before?.turnId && streamTurnIds.includes(change.after?.turnId);
    });
  commitMessageState(state, mergeResult.messages);
  for (var promotion of pending.promoted) {
    promoteEchoedBubble(promotion.pending, promotion.echo);
  }
  if (!options.deferDom || adoptsActiveStreamTurn) dom.applyChanges(mergeResult);
  if (!window.__APEEK_TEST__) {
    for (var conflict of mergeResult.conflicts) {
      console.warn('Message identity/content conflict', conflict);
    }
  }
  state.pendingSentMessages = pending.remaining;
  drainStrictStreamOperations();
  var wasRunning = state.wsRunning;
  state.wsRunning = activity === 'running';
  if (wasRunning && activity === 'completed') window.markSpinnerTurnEnd?.();
  updateSendBtn();
  if (typeof updateSpinner === 'function') updateSpinner();
  dom.finalize();
  applyToolResultMessages(messages);
  if (options.restoreBottom !== false && wasFollowingBottom && state.stickBottom
    && !hiddenOnlyUpdate
    && !onlyHiddenToolUpdates(messages)) {
    followBottomAfterLayout();
  }
  return mergeResult;
}

function displayHistorySnapshot(data, pendingNodes) {
  var content = document.getElementById('content');
  if (!content) return false;
  var viewport = captureHistoryViewport(content);
  var permissionPrompt = content.querySelector('#permission-prompt');
  var container = document.createElement('div');
  container.className = 'messages runtime-' + state.appState.runtime;
  container.innerHTML = '<div class="loading-older' + (state.wsHasMore ? '' : ' exhausted')
    + '">Loading...</div>' + renderMessages(state.wsAllMessages, state.appState.runtime);
  for (var pendingNode of pendingNodes) {
    var echo = Array.from(container.children).find(function (node) {
      return node.dataset.anchor === pendingNode.dataset.anchor
        || (pendingNode.dataset.messageId && node.dataset.messageId === pendingNode.dataset.messageId);
    });
    var rows = [echo || pendingNode];
    while (echo?.nextElementSibling?.classList.contains('assistant-turn')) {
      echo = echo.nextElementSibling;
      rows.push(echo);
    }
    container.append(...rows);
  }
  if (!state.wsAllMessages.length && !pendingNodes.length) {
    if (data.needSync && state.deviceOnlineMap[state.appState.device] !== false
      && typeof skeletonMessages === 'function') {
      content.innerHTML = skeletonMessages();
      return true;
    }
    container.innerHTML = '<div class="empty">'
      + (data.needSync ? 'Bridge offline — no cached messages' : 'No messages') + '</div>';
  }
  if (permissionPrompt) container.appendChild(permissionPrompt);
  content.replaceChildren(container);
  state.wsRenderedCount = state.wsAllMessages.length;
  markTurnAdjacency(container);
  loadImages(container);
  clampOverflow(container);
  window.renderMermaidBlocks?.(container);
  window.renderKatexBlocks?.(container);
  if (typeof revealDeferredPermissionPrompt === 'function') revealDeferredPermissionPrompt();
  if (state.stickBottom) followBottomAfterLayout();
  else restoreHistoryViewport(content, viewport);
  return true;
}

async function loadLatestMessages(sessionId, options = {}) {
  if (state.wsSessionId !== sessionId) return { ok: false, stale: true };
  selectWsSession(sessionId);
  var active = _historyFetchBarriers.current(sessionId);
  if (active) {
    if (options.preserveLive) active.preserveLive = true;
    if (options.preservePending) active.preservePending = true;
    return active.promise;
  }
  var barrier = _historyFetchBarriers.open({
    sessionId: sessionId,
    pendingIds: state.pendingSentMessages.map(function (pending) { return pending.id; }),
  });
  barrier.preserveLive = !!options.preserveLive;
  barrier.preservePending = !!options.preservePending;
  barrier.promise = (async function () {
    subscribeSession(sessionId);
    var data = {};
    var restError = null;
    try {
      data = await fetchLatestMessages(sessionId);
    } catch (error) {
      restError = error;
    }
    if (!_historyFetchBarriers.isCurrent(barrier) || state.wsSessionId !== sessionId) {
      return { ok: false, stale: true };
    }
    barrier.beginCommit();
    var changed = false;
    try {
      if (!restError && barrier.preserveLive) {
        commitMessages(data.messages || [], { liveStateChanged: true });
        if (!state.wsOldestTimestamp) {
          state.wsHasMore = !!data.hasMore;
          state.wsOldestTimestamp = data.oldestTimestamp || '';
        }
      } else if (!restError) {
        var snapshot = replaceHistoryTail(state.wsAllMessages,
          dedupeCodexUserMessages(data.messages || []));
        changed = JSON.stringify(state.wsAllMessages) !== JSON.stringify(snapshot.messages)
          || !!document.querySelector('.stream-preview, .stream-committed, [data-pending], .skeleton-messages')
          || !document.querySelector('.messages')?.childElementCount;
        for (var pending of state.pendingSentMessages.slice()) {
          if (!barrier.preservePending && barrier.pendingIds.has(pending.id)) removePending(pending);
        }
        var pendingNodes = state.pendingSentMessages.map(function (pending) {
          pending.echoScanFrom = 0;
          return document.getElementById(pending.id);
        }).filter(Boolean);
        resetStreamSessionState(true);
        commitMessageState(state, snapshot.messages);
        for (var pending of state.pendingSentMessages.slice()) {
          var echo = messageEchoed(pending);
          if (echo) {
            echo.turnId = pending.id;
            promoteEchoedBubble(pending, echo);
          } else {
            _turnSendOrder.set(pending.id, pending.seq);
            if (!pending.failed) _queuedTurnIds.add(pending.id);
            rememberLatestSend(pending.id, pending.failed, pending.seq);
          }
        }
        if (!snapshot.preservedCount) {
          state.wsHasMore = !!data.hasMore;
          state.wsOldestTimestamp = data.oldestTimestamp || '';
        }
        if (changed) displayHistorySnapshot({
          ...data, needSync: data.needSync && !barrier.events.length,
        }, pendingNodes);
        state.wsRunning = resolveActivityState({
          restStatus: data.status || '',
          messages: state.wsAllMessages,
          runtime: state.appState.runtime,
          hasOutstandingTurns: hasOutstandingTurns(),
          outstandingTurnIds: outstandingTurnIds(),
        }) === 'running';
      }
    } finally {
      _historyFetchBarriers.close(barrier);
    }
    if (restError && barrier.events.length && document.querySelector('.skeleton-messages')) {
      displayHistorySnapshot({}, []);
    }
    _suppressTurnEndRecovery = !barrier.preserveLive && !restError && data.status === 'completed';
    try {
      for (var event of barrier.events) routeTurnEvent(event);
      drainStrictStreamOperations();
    } finally {
      _suppressTurnEndRecovery = false;
    }
    updateTitleFromMessages();
    updateSendBtn();
    if (typeof updateSpinner === 'function') updateSpinner();
    return {
      ok: !restError,
      error: restError,
      status: data.status || '',
    };
  })().catch(function (error) {
    _historyFetchBarriers.close(barrier);
    throw error;
  });
  return barrier.promise;
}

function fetchLatestMessages(sessionId) {
  var params = { session: sessionId, limit: MESSAGE_PAGE_SIZE };
  if (state.appState.device) params.device = state.appState.device;
  if (state.appState.project?.hash) params.project = state.appState.project.hash;
  return api('/api/bridge/messages', params);
}

/**
 * Load older messages (triggered by scroll-to-top).
 * Prepends to wsAllMessages and returns the loaded messages for DOM prepend.
 */
async function loadOlderMessages(sessionId) {
  if (state.wsLoadingOlder || !state.wsHasMore || !state.wsOldestTimestamp) return null;
  if (state.wsSessionId !== sessionId) return null;
  var generation = _messagePaginationGeneration;
  state.wsLoadingOlder = true;
  try {
    var data = await api('/api/bridge/messages', {
      session: sessionId,
      before: state.wsOldestTimestamp,
      limit: MESSAGE_PAGE_SIZE,
    });
    if (data.historyReset) {
      await loadLatestMessages(sessionId, { preservePending: true });
      return null;
    }
    if (generation !== _messagePaginationGeneration
      || state.wsSessionId !== sessionId) {
      return null;
    }
    var msgs = dedupeCodexUserMessages(data.messages || []);
    state.wsHasMore = data.hasMore;
    state.wsOldestTimestamp = data.oldestTimestamp || '';
    var firstConfirmed = state.wsAllMessages[0];
    var pageWindow = firstConfirmed
      ? msgs.concat([firstConfirmed])
      : msgs;
    var mergeResult = mergeMessages({
      localMessages: state.wsAllMessages,
      incomingMessages: pageWindow,
    });
    commitMessageState(state, mergeResult.messages);
    return mergeResult.inserted.map(function (entry) {
      return entry.message;
    });
  } finally {
    if (generation === _messagePaginationGeneration
      && state.wsSessionId === sessionId) {
      state.wsLoadingOlder = false;
    }
  }
}

async function refreshSessionMessages(options) {
  if (!state.wsSessionId) return null;
  try {
    return await loadLatestMessages(state.wsSessionId, options);
  } catch (error) {
    return null;
  }
}

function sendMessage() {
  var input = document.getElementById('msg-input');
  var text = input.value.trim();
  var images = state.stagedImages.slice();

  if (!text && !images.length) return;
  if (images.some(function (file) { return !file.uploaded || !file.key; })) return;
  if (!state.activeThreadCanSend) return;
  if (!images.length && handleCodexClientCommand(text, input)) return;
  if (!text && images.length) text = images.some(function (file) { return file.kind === 'file'; })
    ? 'Please review the attached files' : 'Please review the attached image';
  // Allow sending without wsSessionId for new sessions (projectHash is used)
  if (!state.wsSessionId && state.appState.session !== '__new__') return;
  // Agent sessions require at least 4 characters for the task description
  var agentCb = document.getElementById('newAsAgent');
  if (state.appState.session === '__new__' && agentCb && agentCb.checked && text.length < 4) return;

  // Images already uploaded — just assemble refs.
  // Keep image markdown refs on the SAME line as text (separated by spaces) — putting `!`
  // at line start triggers Ink's shell-out mode in CC, causing bash syntax errors.
  var readyImages = images.filter(function (img) { return img.uploaded && img.key; });
  if (readyImages.length) {
    var refs = readyImages.map(function (img) {
      return img.kind === 'file' ? attachmentRef(img) : '![](baton-bridge:' + img.key + ')';
    }).join(' ');
    doSend(text + ' ' + refs, text, readyImages);
  } else {
    doSend(text, text, []);
  }

  state.stagedImages = [];
  renderStagedImages();
  input.value = '';
  input.style.height = 'auto';
  clearComposerDraft();
  if (typeof stopDictation === 'function') stopDictation();  // sending ends dictation too
  if (!/Mobi|Android/i.test(navigator.userAgent)) input.focus();
}

function handleCodexClientCommand(text, input) {
  if (state.appState.runtime !== 'codex') return false;
  var match = /^\/(copy|new|clear|resume|mention|exit)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return false;
  var command = match[1];
  var args = (match[2] || '').trim();
  if (command === 'new' || command === 'clear') {
    var project = state.appState.project;
    input.value = '';
    input.style.height = 'auto';
    clearComposerDraft();
    updateSendBtn();
    if (project && window.startNewSession) window.startNewSession(project.hash);
    return true;
  }
  if (command === 'resume') {
    input.value = '';
    input.style.height = 'auto';
    clearComposerDraft();
    updateSendBtn();
    if (args && window.loadMessages) {
      window.loadMessages(args.indexOf('codex:') === 0 ? args : 'codex:' + args, args);
    } else if (window.navigateUp) {
      window.navigateUp();
    }
    return true;
  }
  if (command === 'mention') {
    input.value = '@';
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    input.focus();
    syncComposerDraft();
    updateSendBtn();
    return true;
  }
  if (command === 'exit') {
    input.value = '';
    input.style.height = 'auto';
    clearComposerDraft();
    updateSendBtn();
    if (window.navigateUp) window.navigateUp();
    return true;
  }

  var response = '';
  for (var i = state.wsAllMessages.length - 1; i >= 0; i--) {
    var message = state.wsAllMessages[i];
    if (message.type !== 'assistant' || message._localCommand) continue;
    if (Array.isArray(message.content)) {
      response = message.content
        .filter(function (block) { return block && block.type === 'text'; })
        .map(function (block) { return block.text || ''; })
        .join('\n')
        .trim();
    } else if (typeof message.content === 'string') {
      response = message.content.trim();
    }
    if (response) break;
  }
  if (response && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(response).catch(function () {});
  } else if (response) {
    var copyArea = document.createElement('textarea');
    copyArea.value = response;
    copyArea.style.position = 'fixed';
    copyArea.style.opacity = '0';
    document.body.appendChild(copyArea);
    copyArea.select();
    try { document.execCommand('copy'); } catch (e) {}
    copyArea.remove();
  }
  input.value = '';
  input.style.height = 'auto';
  clearComposerDraft();
  var original = input.placeholder;
  input.placeholder = response ? 'Copied last response' : 'No response to copy';
  setTimeout(function () { input.placeholder = original; }, 1600);
  updateSendBtn();
  return true;
}

// Textarea: Enter sends, Shift+Enter newline, auto-grow, toggle send/stop button
var _stopSvg = '<svg viewBox="0 0 24 24" width="18" height="18"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor"/></svg>';
var _sendSvg = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>';
function updateSendBtn(options) {
  options = options || {};
  var btn = document.getElementById('send-btn');
  var textLen = document.getElementById('msg-input').value.trim().length;
  var agentCb = document.getElementById('newAsAgent');
  var isNewAgent = state.appState.session === '__new__' && agentCb && agentCb.checked;
  var hasText = textLen >= (isNewAgent ? 4 : 1);
  var hasInput = hasText || state.stagedImages.length > 0;
  var filesPending = state.stagedImages.some(function (file) { return !file.uploaded || !file.key; });
  var cls = !state.activeThreadCanSend
    ? ''
    : (hasInput ? 'has-text' : (state.wsRunning ? 'is-stop' : ''));
  var icon = cls === 'is-stop' ? 'stop' : 'send';
  // Only rewrite innerHTML when the icon actually changes. Rewriting it every stream frame
  // detaches the SVG mid-tap, dropping a click that landed on it (had to tap 2-3×).
  if (btn.dataset.icon !== icon) { btn.innerHTML = icon === 'stop' ? _stopSvg : _sendSvg; btn.dataset.icon = icon; }
  if (btn.className !== cls) btn.className = cls;
  btn.disabled = !state.activeThreadCanSend || (hasInput ? filesPending : !state.wsRunning);
  if (!options.skipSpinner && typeof updateSpinner === 'function') updateSpinner();
  if (typeof updateMicButton === 'function') updateMicButton();
}
function onSendBtnClick() {
  var input = document.getElementById('msg-input');
  var isMobile = /Mobi|Android/i.test(navigator.userAgent);
  var kbWasUp = isMobile && window.visualViewport && window.visualViewport.height < _vpBaseHeight * 0.75;
  // New-session first send: dismiss keyboard before the centered→bottom swap
  var isFirstNewSessionSend = document.body.classList.contains('new-session');

  if (input.value.trim() || state.stagedImages.length) {
    if (isMobile && kbWasUp && isFirstNewSessionSend) {
      input.blur();
      var doSendAfterKbDown = function () { sendMessage(); updateSendBtn(); };
      if (window.visualViewport) {
        var onResize = function () {
          if (window.visualViewport.height >= _vpBaseHeight * 0.95) {
            window.visualViewport.removeEventListener('resize', onResize);
            doSendAfterKbDown();
          }
        };
        window.visualViewport.addEventListener('resize', onResize);
        setTimeout(function () {
          window.visualViewport.removeEventListener('resize', onResize);
          doSendAfterKbDown();
        }, 350);
      } else {
        setTimeout(doSendAfterKbDown, 250);
      }
      return;
    }

    sendMessage();
    updateSendBtn();
    // Keep keyboard open on mobile after sending
    if (isMobile && kbWasUp) input.focus();
  } else if (state.wsRunning) {
    interruptSession();
  }

  if (isMobile && !kbWasUp) input.blur();
}
function interruptSession() {
  if (!state.wsSessionId) return;
  // A permission prompt owns the interrupt: cancelling it denies+interrupts CC, so don't also send a bare interrupt.
  if (typeof hasActivePermissionPrompt === 'function' && hasActivePermissionPrompt()) {
    cancelPermissionPrompt();
    return;
  }
  var activeTurnId = activeTurnForInterrupt();
  wsSendReliable({
    action: 'interrupt',
    sessionId: state.wsSessionId,
    device: state.appState.device || '',
    ...(activeTurnId ? { turnId: activeTurnId } : {}),
  });
  applyResolvedLiveActivity(
    hasOutstandingTurns() ? 'running' : 'completed',
  );
  updateSendBtn();
}
var restoreScrollFrame = null;
(function () {
  var el = document.getElementById('msg-input');
  function resizeInputPreservingMessages() {
    var content = document.getElementById('content');
    var preserveScroll = content
      && state.appState.session
      && state.appState.session !== '__new__';
    var previousScrollTop = preserveScroll ? content.scrollTop : 0;
    var followBottom = preserveScroll && (
      state.stickBottom
      || content.scrollHeight - content.scrollTop - content.clientHeight < 100
    );

    el.style.height = 'auto';
    var measuredHeight = el.scrollHeight;
    if (measuredHeight > 0) el.style.height = measuredHeight + 'px';

    if (!preserveScroll) return;
    var restoreScroll = function () {
      content.scrollTop = followBottom ? content.scrollHeight : previousScrollTop;
    };
    restoreScroll();
    if (restoreScrollFrame !== null) cancelAnimationFrame(restoreScrollFrame);
    restoreScrollFrame = requestAnimationFrame(function () {
      restoreScrollFrame = null;
      restoreScroll();
    });
  }

  el.addEventListener('keydown', function (e) {
    // IME composition: Enter confirms the candidate, not a send. Sending here
    // clears the input, then compositionend re-fills it → duplicate send + leftover text.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); updateSendBtn(); }
  });
  el.addEventListener('input', function () {
    resizeInputPreservingMessages();
    // Typing changes only input controls. Runtime state changes update the
    // spinner through the existing no-argument updateSendBtn() calls.
    updateSendBtn({ skipSpinner: true });
  });
})();
// Global Esc → interrupt the running turn, like CC. Bubble phase so overlays
// that own Esc (slash popup handles it in capture phase; file/image viewers
// close first) keep priority — we only act when nothing else claimed the key.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (e.isComposing || e.keyCode === 229) return;
  // Yield to open overlays/modals that give Esc its own meaning.
  if (document.getElementById('permission-prompt')) return;
  var fileO = document.getElementById('fileOverlay');
  if (fileO && fileO.style.display === 'flex') return;
  var imgO = document.getElementById('imgOverlay');
  if (imgO && imgO.style.display === 'flex') return;
  var newP = document.getElementById('newProjectModal');
  if (newP && newP.style.display === 'flex') return;
  var takeover = document.getElementById('codexTakeoverModal');
  if (takeover && takeover.style.display === 'flex') return;
  if (!state.wsRunning) return;
  e.preventDefault();
  interruptSession();
});

var _sendOrder = 0;
var _turnSendOrder = new Map();

function doSend(fullText, displayText, images) {
  if (restoreScrollFrame !== null) {
    cancelAnimationFrame(restoreScrollFrame);
    restoreScrollFrame = null;
  }
  var previousTurnId = latestOutstandingTurnId();
  state.wsRunning = true;
  var device = state.appState.device || '';
  // Unique per-send id, round-tripped through the bridge in send_message_result
  // so the ack maps back to THIS exact bubble (not "the first pending", which
  // mis-pairs when several sends are in flight). Doubles as the DOM element id.
  var seq = _sendOrder++;
  var sentAt = Date.now();
  var msgId = 'sent-' + (crypto.randomUUID
    ? crypto.randomUUID()
    : sentAt + '-' + Math.random().toString(36).slice(2));
  rememberLatestSend(msgId, false, seq);
  _turnSendOrder.set(msgId, seq);
  _queuedTurnIds.add(msgId);
  updateSendBtn();
  var sendPayload;
  if (state.appState.session === '__new__' && state.wsProjectHash) {
    if (!state.wsRequestId) {
      state.wsRequestId = crypto.randomUUID
        ? crypto.randomUUID()
        : 'req-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    }
    var asAgent = state.appState.runtime === 'claude'
      && !!(document.getElementById('newAsAgent') && document.getElementById('newAsAgent').checked);
    sendPayload = { action: 'send_message', projectHash: state.wsProjectHash, requestId: state.wsRequestId, turnId: msgId, previousTurnId: previousTurnId, text: fullText, device: device, runtime: state.appState.runtime, asAgent: asAgent };
  } else {
    // projectHash lets the bridge resolve cwd even if the jsonl is gone (deleted session).
    var ph = state.appState.project && state.appState.project.hash;
    sendPayload = { action: 'send_message', sessionId: state.wsSessionId, projectHash: ph, turnId: msgId, previousTurnId: previousTurnId, text: fullText, device: device };
  }
  wsSendReliable(sendPayload);

  // Empty session has no .messages yet; create one or the bubble + preview have nowhere to render.
  var empty = document.querySelector('.empty');
  if (empty) empty.remove();
  var contentEl = document.getElementById('content');
  if (contentEl && !contentEl.querySelector('.messages')) {
    contentEl.insertAdjacentHTML('beforeend', '<div class="messages"></div>');
  }

  // Exit new-session centered layout once the user sends the first message
  if (document.body.classList.contains('new-session')) {
    document.body.classList.remove('new-session');
    var hero = document.querySelector('.new-session-hero');
    if (hero) hero.remove();
    var msgs = document.querySelector('.messages');
    if (msgs) msgs.removeAttribute('hidden');
    // Restore input-bar to body (it was moved into #content for centered layout)
    var bar = document.getElementById('input-bar');
    if (bar && bar.parentElement !== document.body) document.body.appendChild(bar);
  }

  // Keep fullText (with image refs) so a retry re-sends the exact same payload;
  // sessionId pins the message to its session so a timeout that fires after the
  // user navigated away doesn't self-heal against the wrong conversation.
  // echoScanFrom: only user rows arriving AFTER this send count as its echo (else a historical same-text row false-retires the bubble — kills short/repeated sends).
  var pendingSend = { id: msgId, seq: seq, text: displayText, fullText: fullText, images: images, isImage: images.length > 0, sessionId: state.wsSessionId, sentAt: sentAt, echoScanFrom: state.wsAllMessages.length, sendPayload: sendPayload, serverReceived: false, transportRetries: 0 };
  state.pendingSentMessages.push(pendingSend);
  var container = document.querySelector('.messages');
  if (container) {
    var imgHtml = images.map(function (img) {
      if (img.kind === 'file') return fileAttachmentHtml(img);
      return '<div class="img-placeholder loaded"><img src="' + img.dataUrl + '" onclick="viewImage(this.src)" /></div>';
    }).join('');
    var attachHtml = imgHtml ? '<div class="msg-attachments">' + imgHtml + '</div>' : '';
    // data-anchor is the durable placement id: survives echo promotion (unlike data-pending) so the reply lands here.
    container.insertAdjacentHTML('beforeend',
      '<div class="msg-user" id="' + msgId + '" data-pending="1" data-anchor="' + msgId + '">' + attachHtml
      + '<div class="msg-text" onclick="toggleExpand(this)">' + esc(displayText) + '</div>'
      + '<div class="msg-meta"><span class="msg-time sending-status">sending...</span></div></div>');
    clampOverflow(container);
    state.stickBottom = true; // sending a message = follow the incoming reply
    document.getElementById('content').scrollTop =
      document.getElementById('content').scrollHeight;
  }
  schedulePendingTransportRetry(pendingSend);
  scheduleSendTimeout(msgId);
}

// If neither the send_message_result ack nor the echoed-message dedup clears a
// pending bubble within this window, reconcile against the server: the message
// may well have reached CC and only the ack/echo was lost.
var SEND_TIMEOUT_MS = 12000;
var SERVER_RECEIPT_TIMEOUT_MS = window.__APEEK_TEST__ ? 20 : 2000;

function schedulePendingTransportRetry(pending) {
  if (!pending || pending.delivered || pending.transportRetries >= 1) return;
  clearTimeout(pending.transportTimer);
  pending.transportTimer = setTimeout(function () {
    if (pending.delivered || pending.serverReceived
      || pending.transportRetries >= 1) return;
    pending.transportRetries++;
    wsSendReliable(pending.sendPayload);
  }, SERVER_RECEIPT_TIMEOUT_MS);
}

function scheduleSendTimeout(msgId) {
  var timer = setTimeout(function () { reconcilePendingSend(msgId); }, SEND_TIMEOUT_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function findPending(msgId) {
  for (var i = 0; i < state.pendingSentMessages.length; i++) {
    if (state.pendingSentMessages[i].id === msgId) return state.pendingSentMessages[i];
  }
  return null;
}

function removePending(pending) {
  clearTimeout(pending?.transportTimer);
  var idx = state.pendingSentMessages.indexOf(pending);
  if (idx !== -1) state.pendingSentMessages.splice(idx, 1);
}

var _codexTakeover = null;

function pendingStatus(pending, text, color) {
  var el = document.getElementById(pending.id);
  var status = el && el.querySelector('.sending-status');
  if (!status) return;
  status.textContent = text;
  status.style.color = color || '#d29922';
}

function handleCodexSendConflict(pending, msg) {
  var writer = msg.writer || {};
  if (msg.errorCode !== 'codex_active_writer'
    || writer.status !== 'running'
    || !writer.canTerminate
    || !writer.pid) return false;
  pending.awaitingTakeover = true;
  state.wsRunning = false;
  updateSendBtn();
  pendingStatus(pending, 'Waiting for confirmation');

  _codexTakeover = { pending: pending, writer: writer, sending: false };
  var modal = document.getElementById('codexTakeoverModal');
  if (!modal) return true;
  var desc = document.getElementById('codexTakeoverDesc');
  var error = document.getElementById('codexTakeoverError');
  var confirm = document.getElementById('codexTakeoverConfirm');
  var cancel = document.getElementById('codexTakeoverCancel');
  desc.textContent = (writer.label || 'A Codex terminal')
    + ' is running this session. Taking over will close it, send this message, and release the session when the turn finishes.';
  error.textContent = '';
  confirm.style.display = '';
  setButtonLoading(confirm);
  confirm.textContent = 'Take over and send';
  cancel.disabled = false;
  showCenteredModal(modal);
  return true;
}

function finishCodexTakeover(pending) {
  if (!_codexTakeover || _codexTakeover.pending !== pending) return;
  pending.awaitingTakeover = false;
  _codexTakeover = null;
  var modal = document.getElementById('codexTakeoverModal');
  hideCenteredModal(modal);
}

function closeCodexTakeoverModal() {
  if (!_codexTakeover || _codexTakeover.sending) return;
  var pending = _codexTakeover.pending;
  finishCodexTakeover(pending);
  if (!pending.delivered) resolvePending(pending, false, 'Not sent');
}

function confirmCodexTakeover() {
  if (!_codexTakeover || _codexTakeover.sending) return;
  var pending = _codexTakeover.pending;
  var writer = _codexTakeover.writer;
  if (!writer?.canTerminate || !writer.pid || !pending.sendPayload) return;
  _codexTakeover.sending = true;
  pending.awaitingTakeover = false;
  state.wsRunning = true;
  updateSendBtn();
  pendingStatus(pending, 'Taking over Codex...');
  var confirm = document.getElementById('codexTakeoverConfirm');
  var cancel = document.getElementById('codexTakeoverCancel');
  setButtonLoading(confirm, 'Taking over');
  if (cancel) cancel.disabled = true;
  wsSendReliable(Object.assign({}, pending.sendPayload, {
    takeover: true,
    expectedWriterPid: writer.pid,
  }));
  scheduleSendTimeout(pending.id);
}

// Single terminal state for an ack. Success stamps the existing optimistic
// bubble; its exact turn echo later promotes that same anchor in place.
// Failure shows "Not delivered · Retry" and stops the spinner.
function resolvePending(pending, ok, error) {
  clearTimeout(pending.transportTimer);
  pending.queued = false;
  pending.delivered = true;
  pending.failed = !ok;
  if (ok) {
    markPendingTime(pending);
  } else {
    _queuedTurnIds.delete(pending.id);
    rememberLatestSend(pending.id, true);
    markPendingFailed(pending, error);
    applyResolvedLiveActivity(
      hasOutstandingTurns() ? 'running' : 'completed',
    );
    updateSendBtn();
  }
}

function completeLocalCommand(pending, result) {
  _queuedTurnIds.delete(pending.id);
  markPendingTime(pending);
  promoteEchoedBubble(pending, { timestamp: new Date().toISOString() });
  var output = String(result.commandOutput || '');
  var message = {
    uuid: 'codex-command:' + pending.id,
    nativeId: 'codex:command:' + pending.id,
    turnId: pending.id,
    type: 'assistant',
    content: [{ type: 'text', text: output }],
    timestamp: new Date().toISOString(),
    _localCommand: true,
    _commandPanel: result.commandPanel
      ? Object.assign({ rawText: output }, result.commandPanel)
      : null,
  };
  commitMessages([message], {
    liveStateChanged: true,
  });
  applyResolvedLiveActivity(
    hasOutstandingTurns() ? 'running' : 'completed',
  );
  updateSendBtn();
}

function applyCodexCommandAction(action) {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'open-session' && action.sessionId && window.loadMessages) {
    window.loadMessages(action.sessionId, action.preview || '');
  } else if (action.type === 'leave-session' && window.navigateUp) {
    window.navigateUp();
  }
}

// A durable echo belongs to a pending bubble only through its exact turn id.
function messageMatchesPending(message, turnId) {
  if (pendingTurnIdForMessage(message) === turnId
    || message.uuid === turnId
    || message.uuid === String(turnId).replace(/^sent-/, '')
    || message.nativeId === 'codex:user:' + turnId
    || message.nativeId === 'live:user:' + turnId
    || message.nativeId === 'codex:turn:' + turnId + ':user') {
    return true;
  }
  var aliases = new Set(message.identityAliases || []);
  return aliases.has('turn:' + turnId)
    || aliases.has('pending:' + turnId)
    || aliases.has('native:codex:user:' + turnId)
    || aliases.has('native:live:user:' + turnId);
}

function pendingTurnIdForMessage(message) {
  for (var alias of message?.identityAliases || []) {
    var value = String(alias || '');
    if (value.indexOf('pending:') === 0) {
      return value.slice('pending:'.length);
    }
  }
  var nativeId = String(message?.nativeId || '');
  var uuid = String(message?.uuid || '');
  if (nativeId.indexOf('codex:item:') === 0
    || uuid.indexOf('codex:item:') === 0) {
    return '';
  }
  if (message?.turnId) return String(message.turnId);
  if (nativeId.indexOf('codex:user:') === 0) {
    return nativeId.slice('codex:user:'.length);
  }
  if (nativeId.indexOf('live:user:') === 0) {
    return nativeId.slice('live:user:'.length);
  }
  return '';
}

function messageEchoed(pending) {
  // Scan only rows after this send (echoScanFrom); a historical same-text row isn't its echo.
  var from = pending.echoScanFrom || 0;
  for (var i = from; i < state.wsAllMessages.length; i++) {
    var m = state.wsAllMessages[i];
    if (m.type !== 'user' || isInterruptMsg(m) || isToolResultOnly(m)) continue;
    if (messageMatchesPending(m, pending.id)) return m;
  }
  return null;
}

function settlePendingAtTurnEnd(turnId, end) {
  var pending = findPending(turnId);
  if (!pending || pending.failed) return false;
  pending.turnEnded = true;
  // A terminal runtime error can arrive before its send_message_result.
  // Keep the pending record until that ack decides whether the prompt itself
  // was accepted, so a later failure still has an exact bubble to update.
  if (end?.error && !pending.delivered) return false;
  var terminalEcho = Array.isArray(end?.messages)
    ? end.messages.find(function (message) {
        return message?.type === 'user'
          && !isInterruptMsg(message)
          && !isToolResultOnly(message)
          && messageMatchesPending(message, pending.id);
      })
    : null;
  var echoed = terminalEcho || messageEchoed(pending);
  if (!echoed) return false;
  promoteEchoedBubble(pending, echoed);
  return true;
}

function markPendingTime(pending) {
  var el = document.getElementById(pending.id);
  if (!el) return;
  var sentAt = new Date(pending.sentAt || Date.now());
  el.dataset.ts = sentAt.toISOString();
  var status = el.querySelector('.sending-status');
  if (status) {
    status.textContent = sentAt.toLocaleTimeString();
    status.style.color = '#6e7681';
  }
}

async function checkPendingEcho(pending) {
  var sessionId = state.wsSessionId;
  var data = await fetchLatestMessages(sessionId);
  if (sessionId !== state.wsSessionId || findPending(pending.id) !== pending) return;
  var echo = (data.messages || []).find(function (message) {
    return message.type === 'user' && !isInterruptMsg(message)
      && !isToolResultOnly(message) && messageMatchesPending(message, pending.id);
  });
  if (echo) commitMessages([{ ...echo, turnId: pending.id }], { restoreBottom: false });
}

function markPendingFailed(pending, error) {
  var el = document.getElementById(pending.id);
  if (!el) return;
  var status = el.querySelector('.sending-status');
  if (!status) return;
  var label = error ? esc(error) : 'Not delivered';
  status.innerHTML = label + ' · <span class="send-retry" onclick="retryPendingSend(\'' + pending.id + '\')">Retry</span>';
  status.style.color = '#f85149';
}

// Timeout reconciliation: only acts if the bubble is still pending (ack/dedup
// didn't already resolve it). Pulls latest messages from DDB, then either
// self-heals (message arrived, ack/echo was just lost) or flags for retry.
async function reconcilePendingSend(msgId) {
  var pending = findPending(msgId);
  if (!pending || pending.delivered) return;               // already resolved
  if (pending.queued) return;                              // accepted into the Bridge's causal queue
  if (pending.awaitingTakeover) return;                    // user has not chosen whether to take over
  if (pending.sessionId !== state.wsSessionId) return;     // user navigated away; leave it
  var remaining = SEND_TIMEOUT_MS - (Date.now() - (pending.sentAt || 0));
  if (remaining > 50) {
    setTimeout(function () { reconcilePendingSend(msgId); }, remaining);
    return;
  }
  try { await checkPendingEcho(pending); } catch (e) {}
  pending = findPending(msgId);
  if (!pending || pending.delivered) return;               // ack/dedup fired during the fetch
  // Message actually landed (ack/echo just lost) → success; else flag for retry.
  resolvePending(pending, messageEchoed(pending), null);
}

// Manual retry: re-check the server first, then reuse the same durable user
// bubble and turn id. A retry changes transport state, never user-message order.
async function retryPendingSend(msgId) {
  var pending = findPending(msgId);
  if (!pending) return;
  try { await checkPendingEcho(pending); } catch (e) {}
  var echoed = messageEchoed(pending);
  if (echoed) {
    promoteEchoedBubble(pending, echoed);
    return;
  }
  pending.delivered = false;
  pending.failed = false;
  pending.queued = false;
  pending.serverReceived = false;
  pending.turnEnded = false;
  pending.transportRetries = 0;
  _queuedTurnIds.add(pending.id);
  rememberLatestSend(pending.id, false, pending.seq);
  pendingStatus(pending, 'sending...');
  applyResolvedLiveActivity('running');
  updateSendBtn();
  wsSendReliable(pending.sendPayload);
  schedulePendingTransportRetry(pending);
  scheduleSendTimeout(pending.id);
}

// Promote the optimistic bubble in place (never remove+re-insert): its [data-anchor] must survive so anchorForStream still finds it.
function promoteEchoedBubble(pending, msg) {
  clearTimeout(pending.transportTimer);
  // The authoritative echo can beat the final send ack. Settle the visible
  // optimistic bubble from its original send time before retiring its pending
  // record, so rapid sends never show ack-arrival order as their timestamps.
  markPendingTime(pending);
  var idx = state.pendingSentMessages.indexOf(pending);
  if (idx !== -1) state.pendingSentMessages.splice(idx, 1);
  var el = document.getElementById(pending.id);
  if (el) {
    if (msg.uuid) el.dataset.messageId = msg.uuid;
    if (msg.nativeId) el.dataset.nativeId = msg.nativeId;
    if (msg.turnId) el.dataset.anchor = msg.turnId;
    if (msg.timestamp) {
      el.dataset.serverTs = msg.timestamp;
    }
    el.removeAttribute('data-pending');
  }
}

// Function bridges for inline HTML handlers + IIFE consumers.
// All shared state lives in state.js, not on window.
Object.assign(window, {
  updateTitleFromMessages,
  syncMobileViewport,
  connectWs, subscribeSession, wsSend, wsSendReliable, setWsStatus, disconnectWs, ensureWsAndSend,
  resumeSessionForeground,
  startWs, loadLatestMessages, loadOlderMessages, refreshSessionMessages,
  sendMessage, updateSendBtn, onSendBtnClick, interruptSession, doSend,
  closeCodexTakeoverModal, confirmCodexTakeover,
  retryPendingSend, isInheritedAgentContext,
});

// Test-only hook for replaying the real WS dispatcher.
if (typeof window !== 'undefined' && window.__APEEK_TEST__) {
  window.__wsTest = {
    handleWsMessage: handleWsMessage,
    flushLateJoinCompletion: completeLateJoinTurn,
    resumeLateJoinAtCheckpoint: resumeLateJoinAtCheckpoint,
    commitMessages: commitMessages,
  };
}
