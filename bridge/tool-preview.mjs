export const TOOL_PREVIEW_CHARACTERS = 500;
const prepared = new WeakSet();

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

// Tool-result images render through their S3 key; the inline base64 is unused.
export function stripToolResultBase64(block) {
  if (!Array.isArray(block.content)) return block;
  const content = block.content.map((c) =>
    c.type === 'image' && c.source?.data ? { ...c, source: { ...c.source, data: '' } } : c);
  return { ...block, content };
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

export function toolPreviews(messages) {
  return messages.map(toolPreview);
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

export function toolPreview(message) {
  if (!message || typeof message !== 'object') return message;
  if (prepared.has(message)) return message;
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
    if (block.type === 'tool_result' && !block.is_error
      && (original._toolName === 'Edit' || editMetadata)) {
      changed = true;
      const content = typeof block.content === 'string' && /^Created\b/i.test(block.content.trim())
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
  let result = message;
  if (changed || metadataChanged) {
    const { toolUseResult, ...rest } = message;
    result = { ...rest, content, ...(metadata ? { toolUseResult: metadata } : {}) };
  }
  prepared.add(result);
  return result;
}
