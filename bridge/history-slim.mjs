// What a history page carries: the fields the App reads from /messages, cut to what a collapsed view
// shows. Truncated tool bodies and thinking text come from tool_details on expand; results shorter
// than the preview stay, because the tool header's state (error, exit code, cancel) reads them.
import { toolPreview } from './tool-preview.mjs';

const FIELDS = ['uuid', 'type', 'content', 'timestamp', 'nativeId', 'orderKey', 'stopReason', 'toolUseResult', 'icon', 'noAlert'];
const UNREAD_INPUTS = ['workdir', 'yield_time_ms', 'max_output_tokens', 'tty'];

function slimBlock(block) {
  if (block?.type === 'tool_result') {
    const { codexCommandSource, ...rest } = block;
    if (!rest.truncated) return rest;
    const { content, ...header } = rest;
    return header;
  }
  if (block?.type === 'thinking' && block.thinking) return { type: 'thinking', truncated: true };
  if (block?.type === 'tool_use' && block.input && UNREAD_INPUTS.some((key) => key in block.input)) {
    const input = { ...block.input };
    for (const key of UNREAD_INPUTS) delete input[key];
    return { ...block, input };
  }
  return block;
}

export function slimRow(message) {
  const prepared = toolPreview(message);
  const row = {};
  for (const key of FIELDS) {
    const value = prepared[key];
    if (value !== undefined && value !== '' && value !== null) row[key] = value;
  }
  if (Array.isArray(row.content)) row.content = row.content.map(slimBlock);
  return row;
}
