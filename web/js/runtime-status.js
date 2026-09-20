const TERMINAL_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
]);

/**
 * @param {{messages?: object[], runtime?: string, authStatus?: string}} options
 * @returns {'running'|'completed'}
 */
export function deriveActivityFromMessages(options = {}) {
  var messages = Array.isArray(options.messages) ? options.messages : [];
  return options.runtime === 'codex'
    ? deriveCodexActivity(messages)
    : deriveClaudeActivity(messages, options.authStatus || '');
}

/**
 * @param {{liveStateChanged?: boolean, liveActivity?: string, restStatus?: string, messages?: object[], runtime?: string, hasOutstandingTurns?: boolean, outstandingTurnIds?: string[]}} options
 * @returns {'running'|'needs_input'|'completed'}
 */
export function resolveActivityState(options = {}) {
  if (options.liveStateChanged) {
    return normalizeActivity(options.liveActivity);
  }
  var restStatus = normalizeActivity(options.restStatus, '');
  if (restStatus === 'needs_input') return 'needs_input';
  if (restStatus === 'completed') {
    if (!options.hasOutstandingTurns) return 'completed';
    var outstandingTurnIds = Array.isArray(options.outstandingTurnIds)
      ? options.outstandingTurnIds.filter(Boolean)
      : [];
    if (outstandingTurnIds.length) {
      return outstandingTurnIds.every(function (turnId) {
        return historyAnswersTurn(options.messages || [], turnId);
      }) ? 'completed' : 'running';
    }
    return hasAnsweredTail(options.messages || [])
      ? 'completed'
      : 'running';
  }
  if (restStatus === 'running') {
    return hasTerminalAssistantTail(options.messages || [])
      ? 'completed'
      : 'running';
  }
  if (options.hasOutstandingTurns) return 'running';
  return deriveActivityFromMessages({
    messages: options.messages,
    runtime: options.runtime,
    authStatus: restStatus,
  });
}

function messageMatchesTurnPrompt(message, turnId) {
  if (message?.type !== 'user' || isToolResultOnly(message)) return false;
  if (message.turnId === turnId
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

function historyAnswersTurn(messages, turnId) {
  var promptIndex = messages.findIndex(function (message) {
    return messageMatchesTurnPrompt(message, turnId);
  });
  if (promptIndex < 0) return false;
  for (var index = promptIndex + 1; index < messages.length; index++) {
    var message = messages[index];
    if (!message || isMetadata(message)
      || isToolResultOnly(message)
      || isSubagentNotification(message)) {
      continue;
    }
    if (message.type === 'assistant' || message.type === 'summary') return true;
    if (message.type === 'user') return false;
  }
  return false;
}

function hasAnsweredTail(messages) {
  for (var index = messages.length - 1; index >= 0; index--) {
    var message = messages[index];
    if (!message || isMetadata(message)) continue;
    if (message.type === 'assistant' || message.type === 'summary') return true;
    if (message.type !== 'user') continue;
    if (isInterruptMessage(message) || isLocalCommandMarker(message)) return true;
    if (isToolResultOnly(message) || isSubagentNotification(message)) continue;
    return false;
  }
  return false;
}

/**
 * @param {{activityHint?: string, hasOutstandingTurns?: boolean}} options
 * @returns {'running'|'needs_input'|'completed'}
 */
export function resolveControlActivity(options = {}) {
  var activityHint = normalizeActivity(options.activityHint, '');
  if (activityHint) return activityHint;
  return options.hasOutstandingTurns ? 'running' : 'completed';
}

function normalizeActivity(value, fallback = 'completed') {
  return value === 'running' || value === 'needs_input' || value === 'completed'
    ? value
    : fallback;
}

function userText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.map(function (block) {
      return block?.text || '';
    }).join('');
  }
  return '';
}

function isMetadata(message) {
  return message?.type === 'ai-title'
    || message?.type === 'custom-title'
    || message?.type === 'last-prompt';
}

function isInterruptMessage(message) {
  if (message?.type !== 'user' || !Array.isArray(message.content)) return false;
  var text = message.content.length === 1 && message.content[0]?.type === 'text'
    ? message.content[0].text || ''
    : '';
  return text === '[Request interrupted by user]'
    || text === '[Request interrupted by user for tool use]';
}

function isToolResultOnly(message) {
  return message?.type === 'user'
    && Array.isArray(message.content)
    && message.content.every(function (block) {
      return block?.type === 'tool_result';
    });
}

function isSubagentNotification(message) {
  return message?.type === 'user'
    && /^\s*<subagent_notification>[\s\S]*<\/subagent_notification>\s*$/i
      .test(userText(message));
}

function isLocalCommandStdout(message) {
  return message?.type === 'user'
    && /<local-command-stdout>/.test(userText(message));
}

function isLocalCommandMarker(message) {
  if (message?.type !== 'user') return false;
  var text = userText(message);
  if (/^\s*<(?:local-command-caveat|task-notification|system-reminder)/.test(text)) {
    return true;
  }
  return /^\s*<command-name>\/?clear<\/command-name>/.test(text);
}

function assistantRunning(message) {
  return message?.stopReason == null || message.stopReason === 'tool_use';
}

function isInteractiveToolResult(message, messages) {
  if (!Array.isArray(message?.content)) return false;
  var interactiveIds = new Set();
  for (var source of messages) {
    if (!Array.isArray(source?.content)) continue;
    for (var block of source.content) {
      if (block?.type === 'tool_use'
        && ['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode'].includes(block.name)) {
        interactiveIds.add(block.id);
      }
    }
  }
  return message.content.some(function (block) {
    if (block?.type !== 'tool_result'
      || !interactiveIds.has(block.tool_use_id)) {
      return false;
    }
    var text = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map(function (item) { return item?.text || ''; }).join('')
        : '';
    return text.indexOf('tool use was rejected') === -1;
  });
}

function deriveClaudeActivity(messages, authStatus) {
  var atTail = true;
  for (var index = messages.length - 1; index >= 0; index--) {
    var message = messages[index];
    if (!message || isMetadata(message)) continue;
    if (isLocalCommandStdout(message)) return 'completed';
    if (message.type === 'assistant') {
      return assistantRunning(message) ? 'running' : 'completed';
    }
    if (message.type === 'user') {
      if (isInterruptMessage(message) || isLocalCommandMarker(message)) {
        return 'completed';
      }
      if (isToolResultOnly(message)) {
        if (atTail
          && message.content.every(function (block) { return block.is_error; })
          && !isInteractiveToolResult(message, messages)) {
          return 'completed';
        }
        atTail = false;
        continue;
      }
      if (atTail && authStatus === 'completed') return 'completed';
      return 'running';
    }
    atTail = false;
  }
  return 'completed';
}

function deriveCodexActivity(messages) {
  for (var index = messages.length - 1; index >= 0; index--) {
    var message = messages[index];
    if (!message || isMetadata(message)) continue;
    if (message.type === 'assistant') {
      return assistantRunning(message) ? 'running' : 'completed';
    }
    if (message.type === 'user') {
      if (isInterruptMessage(message)) return 'completed';
      if (isToolResultOnly(message)) continue;
      return 'running';
    }
  }
  return 'completed';
}

function hasTerminalAssistantTail(messages) {
  for (var index = messages.length - 1; index >= 0; index--) {
    var message = messages[index];
    if (message?.type === 'assistant' || message?.type === 'summary') {
      return message.type === 'assistant'
        && TERMINAL_STOP_REASONS.has(message.stopReason);
    }
    if (message?.type === 'user'
      && !isInterruptMessage(message)
      && !isToolResultOnly(message)
      && !isSubagentNotification(message)) {
      return false;
    }
  }
  return false;
}
