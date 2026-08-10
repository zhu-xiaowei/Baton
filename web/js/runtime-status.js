import './components/message.js';

(function () {
  function isMetadata(message) {
    return message.type === 'ai-title'
      || message.type === 'custom-title'
      || message.type === 'last-prompt';
  }

  function assistantRunning(message) {
    return message.stopReason == null || message.stopReason === 'tool_use';
  }

  function isInteractiveToolResult(message, messages) {
    if (!Array.isArray(message.content)) return false;
    var interactiveIds = new Set();
    for (var i = 0; i < messages.length; i++) {
      var content = messages[i]?.content;
      if (!Array.isArray(content)) continue;
      for (var j = 0; j < content.length; j++) {
        var block = content[j];
        if (block.type === 'tool_use'
          && ['AskUserQuestion', 'ExitPlanMode', 'exit_plan_mode'].includes(block.name)) {
          interactiveIds.add(block.id);
        }
      }
    }
    return message.content.some(function (block) {
      if (block.type !== 'tool_result' || !interactiveIds.has(block.tool_use_id)) return false;
      var text = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map(function (item) { return item.text || ''; }).join('')
          : '';
      return text.indexOf('tool use was rejected') === -1;
    });
  }

  function deriveClaudeRunning(messages, authStatus) {
    var atTail = true;
    for (var i = messages.length - 1; i >= 0; i--) {
      var message = messages[i];
      if (!message || isMetadata(message)) continue;
      if (window.isLocalCommandStdout(message)) return false;
      if (message.type === 'assistant') return assistantRunning(message);
      if (message.type === 'user') {
        if (window.isInterruptMsg(message) || window.isLocalCommandMarker(message)) return false;
        if (window.isToolResultOnly(message)) {
          if (atTail
            && message.content.every(function (block) { return block.is_error; })
            && !isInteractiveToolResult(message, messages)) {
            return false;
          }
          atTail = false;
          continue;
        }
        if (atTail && authStatus === 'completed') return false;
        return true;
      }
      atTail = false;
    }
    return false;
  }

  function deriveCodexRunning(messages) {
    for (var i = messages.length - 1; i >= 0; i--) {
      var message = messages[i];
      if (!message || isMetadata(message)) continue;
      if (message.type === 'assistant') return assistantRunning(message);
      if (message.type === 'user') {
        if (window.isInterruptMsg(message)) return false;
        if (window.isToolResultOnly(message)) continue;
        return true;
      }
    }
    return false;
  }

  var adapters = Object.freeze({
    claude: deriveClaudeRunning,
    codex: deriveCodexRunning,
  });

  window.runtimeStatusAdapters = adapters;
  window.deriveRunning = function (messages, authStatus, runtime) {
    if (!Array.isArray(messages)) return false;
    var adapter = adapters[runtime === 'codex' ? 'codex' : 'claude'];
    return adapter(messages, authStatus);
  };
})();
