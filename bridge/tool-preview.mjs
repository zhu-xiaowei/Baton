export const TOOL_PREVIEW_CHARACTERS = 500;
let previewsEnabled = false;

export function configureToolPreviews(enabled) { previewsEnabled = enabled === true; }
export function toolPreviewsEnabled() { return previewsEnabled; }
export function prepareToolMessage(message) { return toolPreview(message, undefined, previewsEnabled); }
export function prepareToolMessages(messages, editToolIds, prepared = false) {
  return toolPreviews(messages, editToolIds, previewsEnabled, prepared);
}

const IDENTITY_FIELDS = new Set(['id', 'tool_use_id', 'session_id', 'file_path', 'path']);

export function toolResultStats(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const keys = ['totalDurationMs', 'totalToolUseCount']
    .filter(key => Object.hasOwn(metadata, key) && Number.isFinite(metadata[key]));
  if (!keys.length) return null;
  if (Object.keys(metadata).length === keys.length) return metadata;
  return Object.fromEntries(keys.map(key => [key, metadata[key]]));
}

export function markEditResult(block, toolName) {
  if (toolName === 'Edit') block._toolName = 'Edit';
  return block;
}

export function compactToolFields(block) {
  if (!block || !['tool_use', 'tool_result'].includes(block.type)) return block;
  const value = block.type === 'tool_use' ? block.input : block;
  if (!value || typeof value !== 'object') return block;
  let compact = value;
  if (block.type === 'tool_result' && Object.hasOwn(value, '_toolName')) {
    const { _toolName, ...rest } = value;
    compact = rest;
  }
  if (block.type === 'tool_use' && block.name === 'Bash'
    && Object.hasOwn(value, 'command') && typeof value.command === 'string'
    && Object.hasOwn(value, 'cmd') && value.cmd === value.command) {
    const { cmd, ...rest } = value;
    compact = rest;
  }
  if (Array.isArray(value.codexCommandActions)) {
    let changed = false;
    const actions = value.codexCommandActions.map(action => {
      if (!action || !Object.hasOwn(action, 'cmd')) return action;
      const { cmd, ...rest } = action;
      changed = true;
      return rest;
    });
    if (changed) compact = { ...compact, codexCommandActions: actions };
  }
  if (compact === value) return block;
  return block.type === 'tool_use' ? { ...block, input: compact } : compact;
}

export function toolPreviews(messages, editToolIds = new Set(), enabled = true, prepared = false) {
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'tool_use' && block.name === 'Edit') editToolIds.add(block.id);
    }
  }
  if (prepared) return messages;
  return messages.map((message) => toolPreview(message, editToolIds, enabled));
}

export function textPreview(text, limit = TOOL_PREVIEW_CHARACTERS) {
  let prefix = '';
  let count = 0;
  for (const character of text) {
    if (count === limit) return { text: prefix, truncated: true };
    prefix += character;
    count++;
  }
  return { text, truncated: false };
}

function previewValue(value) {
  if (typeof value === 'string') {
    const preview = textPreview(value);
    return { value: preview.text, truncated: preview.truncated };
  }
  if (!value || typeof value !== 'object') return { value, truncated: false };
  let truncated = false;
  const result = Array.isArray(value) ? [] : {};
  for (const [key, child] of Object.entries(value)) {
    const preview = IDENTITY_FIELDS.has(key)
      ? { value: child, truncated: false }
      : previewValue(child);
    Object.defineProperty(result, key, {
      value: preview.value, enumerable: true, configurable: true, writable: true,
    });
    truncated ||= preview.truncated;
  }
  return { value: truncated ? result : value, truncated };
}

export function toolPreview(message, editToolIds, enabled = true) {
  if (!message || typeof message !== 'object') return message;
  if (!enabled) {
    let changed = false;
    const content = Array.isArray(message.content) ? message.content.map(block => {
      if (!block || !Object.hasOwn(block, '_toolName')) return block;
      const { _toolName, ...rest } = block;
      changed = true;
      return rest;
    }) : message.content;
    return changed ? { ...message, content } : message;
  }
  let changed = false;
  const editMetadata = message.toolUseResult
    && (Object.hasOwn(message.toolUseResult, 'oldString') || Object.hasOwn(message.toolUseResult, 'newString'));
  const metadata = toolResultStats(message.toolUseResult);
  const metadataChanged = Object.hasOwn(message, 'toolUseResult') && metadata !== message.toolUseResult;
  const content = Array.isArray(message.content) ? message.content.map((original) => {
    if (!original || typeof original !== 'object') return original;
    let block = compactToolFields(original);
    if (block.type === 'thinking' && Object.hasOwn(block, 'signature')) {
      block = { ...block };
      delete block.signature;
    }
    if (block.type === 'tool_use' && block.name === 'Edit') {
      const input = Object.fromEntries(Object.entries(block.input || {})
        .filter(([key]) => ['file_path', 'path', 'move_path'].includes(key)));
      changed = true;
      return { ...block, input, truncated: true };
    }
    if (block.type === 'tool_result'
      && (original._toolName === 'Edit' || editMetadata || editToolIds instanceof Set && editToolIds.has(block.tool_use_id))) {
      changed = true;
      const content = block.is_error ? previewValue(block.content).value
        : typeof block.content === 'string' && /^Created\b/i.test(block.content.trim())
          ? 'Created successfully.' : 'Applied changes successfully.';
      return { ...block, content, truncated: true };
    }
    const field = block.type === 'tool_use' ? 'input'
      : block.type === 'tool_result' ? 'content' : null;
    if (field && Object.hasOwn(block, field)) {
      const preview = previewValue(block[field]);
      if (preview.truncated) {
        block = compactToolFields({ ...block, [field]: preview.value, truncated: true });
        if (block.type === 'tool_result' && !Number.isInteger(block.codexExitCode)
          && typeof original.content === 'string') {
          const exit = /Process exited with code\s+(-?\d+)/i.exec(original.content);
          if (exit) block.codexExitCode = Number(exit[1]);
        }
      }
    }
    changed ||= block !== original;
    return block;
  }) : message.content;
  if (!changed && !metadataChanged) return message;
  const { toolUseResult, ...rest } = message;
  return {
    ...rest,
    content,
    ...(metadata ? { toolUseResult: metadata } : {}),
  };
}
