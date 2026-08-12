export const CODEX_LIVE_SOURCE = Symbol('codexLiveSource');

export function codexUserLiveKey(clientId) {
  return clientId ? `user:${clientId}` : '';
}

export function codexTurnUserLiveKey(turnId) {
  return turnId ? `turn:${turnId}:user` : '';
}

export function codexTurnErrorLiveKey(turnId) {
  return turnId ? `turn:${turnId}:error` : '';
}

export function codexItemLiveKey(itemId) {
  return itemId ? `item:${itemId}` : '';
}

export function codexTurnUserNativeId(turnId) {
  return turnId ? `codex:turn:${turnId}:user` : '';
}

export function codexTurnErrorNativeId(turnId) {
  return turnId ? `codex:turn:${turnId}:error` : '';
}

export function codexUserNativeId(clientId) {
  return clientId ? `codex:user:${clientId}` : '';
}

export function codexItemNativeId(itemId) {
  return itemId ? `codex:item:${itemId}` : '';
}

export function tagCodexLiveSource(message, key) {
  if (!message || !key) return message;
  Object.defineProperty(message, CODEX_LIVE_SOURCE, {
    configurable: true,
    enumerable: false,
    value: key,
  });
  return message;
}

export function codexLiveSource(message) {
  return message?.[CODEX_LIVE_SOURCE] || '';
}

function timestamp(value) {
  if (typeof value === 'string' && value) return value;
  const date = Number.isFinite(value) ? new Date(value) : new Date();
  return date.toISOString();
}

export function codexErrorMessage(error) {
  let value = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text) return '';
      try {
        value = JSON.parse(text);
        continue;
      } catch {
        return text;
      }
    }
    if (!value || typeof value !== 'object') {
      return value == null ? '' : String(value);
    }
    if (value.error != null) {
      value = value.error;
      continue;
    }
    if (value.message != null) {
      value = value.message;
      continue;
    }
    if (value.detail != null) {
      value = value.detail;
      continue;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return typeof value === 'string' ? value.trim() : '';
}

export function codexTurnErrorLiveMessage(turnId, error, at, uuid = '') {
  const detail = codexErrorMessage(error);
  const liveKey = codexTurnErrorLiveKey(turnId);
  if (!detail || !liveKey) return null;
  return {
    liveKey,
    message: {
      uuid: uuid || `codex_live_error_${turnId}`,
      nativeId: codexTurnErrorNativeId(turnId),
      type: 'assistant',
      content: [{ type: 'text', text: `Error: ${detail}` }],
      timestamp: timestamp(at),
      stopReason: 'end_turn',
    },
  };
}

export function codexUserItemText(item) {
  return (item?.content || []).map((part) => {
    if (part?.type === 'text') return part.text || '';
    if (part?.type === 'localImage') return `![Image](${part.path || ''})`;
    if (part?.type === 'image') return `![Image](${part.url || ''})`;
    return '';
  }).filter(Boolean).join('\n');
}

export function codexCompletedLiveMessages(
  item,
  completedAtMs,
  fallbackText = '',
  context = {},
) {
  if (!item?.id) return [];
  const at = timestamp(completedAtMs);
  if (item.type === 'userMessage') {
    const text = codexUserItemText(item);
    const liveKey = codexUserLiveKey(item.clientId)
      || codexTurnUserLiveKey(context.turnId);
    if (!text || !liveKey) return [];
    return [{
      liveKey,
      message: {
        uuid: `codex_live_user_${item.id}`,
        nativeId: codexUserNativeId(item.clientId)
          || codexTurnUserNativeId(context.turnId),
        type: 'user',
        content: text,
        timestamp: at,
      },
    }];
  }
  if (item.type === 'agentMessage') {
    const text = item.text || fallbackText;
    if (!text) return [];
    return [{
      liveKey: codexItemLiveKey(item.id),
      message: {
        uuid: `codex_live_agent_${item.id}`,
        nativeId: codexItemNativeId(item.id),
        type: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: at,
      },
    }];
  }
  if (item.type === 'reasoning') {
    const thinking = [...(item.content || []), ...(item.summary || [])].join('\n')
      || fallbackText;
    if (!thinking) return [];
    return [{
      liveKey: codexItemLiveKey(item.id),
      message: {
        uuid: `codex_live_reasoning_${item.id}`,
        nativeId: codexItemNativeId(item.id),
        type: 'assistant',
        content: [{ type: 'thinking', thinking }],
        timestamp: at,
      },
    }];
  }
  if (item.type === 'plan' && item.text) {
    return [{
      liveKey: codexItemLiveKey(item.id),
      message: {
        uuid: `codex_live_plan_${item.id}`,
        nativeId: codexItemNativeId(item.id),
        type: 'assistant',
        content: [{ type: 'text', text: item.text }],
        timestamp: at,
      },
    }];
  }
  return [];
}

function commandActions(actions) {
  return (actions || []).map((action) => ({
    ...action,
    type: action?.type === 'listFiles' ? 'list_files' : action?.type,
  }));
}

function diffSides(diff) {
  const oldLines = [];
  const newLines = [];
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-')) oldLines.push(line.slice(1));
    else if (line.startsWith('+')) newLines.push(line.slice(1));
    else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  return { old_string: oldLines.join('\n'), new_string: newLines.join('\n') };
}

export function codexPreviewBlocks(item) {
  if (!item?.id) return [];
  if (item.type === 'agentMessage') {
    return [{ kind: 'text' }];
  }
  if (item.type === 'reasoning') return [{ kind: 'thinking' }];
  if (item.type === 'plan') return [{ kind: 'text' }];
  if (item.type === 'commandExecution') {
    return [{
      kind: 'tool_use',
      name: 'Bash',
      input: {
        command: item.command || '',
        cwd: item.cwd || '',
        codexCommandActions: commandActions(item.commandActions),
      },
    }];
  }
  if (item.type === 'fileChange') {
    return (item.changes || []).map((change) => ({
      kind: 'tool_use',
      name: 'Edit',
      input: {
        file_path: change.path || '',
        ...diffSides(change.diff),
      },
    }));
  }
  if (item.type === 'mcpToolCall') {
    return [{
      kind: 'tool_use',
      name: item.tool || 'Tool',
      input: {
        ...(item.arguments && typeof item.arguments === 'object'
          ? item.arguments
          : { input: item.arguments }),
        codexMcpServer: item.server || '',
        codexMcpTool: item.tool || '',
      },
    }];
  }
  if (item.type === 'webSearch') {
    return [{
      kind: 'tool_use',
      name: 'WebSearch',
      input: {
        query: item.query || '',
        ...(item.action ? { action: item.action.type || 'search' } : {}),
      },
    }];
  }
  return [];
}
