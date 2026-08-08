import crypto from 'crypto';
import fs from 'fs';

const TOOL_NAMES = new Map([
  ['exec_command', 'Bash'],
  ['update_plan', 'TodoWrite'],
  ['write_stdin', 'WriteStdin'],
  ['view_image', 'ViewImage'],
]);

function stableId(sessionId, line, kind, value) {
  const digest = crypto.createHash('sha1')
    .update(`${sessionId}|${line}|${kind}|${JSON.stringify(value)}`)
    .digest('hex');
  return `codex_${String(line).padStart(10, '0')}_${digest.slice(0, 16)}`;
}

function safeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function outputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (typeof item?.text === 'string') return item.text;
      return JSON.stringify(item);
    }).join('\n');
  }
  if (value == null) return '';
  return JSON.stringify(value, null, 2);
}

function assistantText(payload) {
  if (!Array.isArray(payload?.content)) return '';
  return payload.content
    .filter((block) => block?.type === 'output_text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function mapToolInput(name, raw) {
  const input = safeJson(raw, typeof raw === 'string' ? { input: raw } : {});
  if (name === 'exec_command') {
    return {
      ...input,
      command: input.command || input.cmd || '',
    };
  }
  if (name === 'update_plan') {
    return {
      todos: Array.isArray(input.plan)
        ? input.plan.map((item) => ({ content: item.step || item.content || '', status: item.status || 'pending' }))
        : [],
      ...(input.explanation ? { explanation: input.explanation } : {}),
    };
  }
  return input;
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

export function parseApplyPatchInput(raw) {
  const lines = String(raw || '').split('\n');
  const changes = [];
  let current = null;
  for (const line of lines) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current = { kind: header[1].toLowerCase(), file_path: header[2], body: [] };
      changes.push(current);
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && current) {
      current.move_path = move[1];
      continue;
    }
    if (current && line !== '*** End Patch') current.body.push(line);
  }
  return changes.map((change) => {
    const body = change.body.join('\n');
    if (change.kind === 'add') {
      return {
        file_path: change.move_path || change.file_path,
        old_string: '',
        new_string: change.body.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n'),
      };
    }
    if (change.kind === 'delete') {
      return { file_path: change.file_path, old_string: body, new_string: '' };
    }
    return {
      file_path: change.move_path || change.file_path,
      ...diffSides(body),
    };
  });
}

function pairId(sessionId, callId, occurrence, suffix = '') {
  const digest = crypto.createHash('sha1')
    .update(`${sessionId}|${callId}|${occurrence}|${suffix}`)
    .digest('hex')
    .slice(0, 20);
  return `codex_tool_${digest}`;
}

function timestampFor(entry) {
  return entry?.timestamp || '1970-01-01T00:00:00.000Z';
}

function patchResult(payload) {
  const details = [payload.stdout, payload.stderr].filter(Boolean).join('\n');
  return details || (payload.success === false ? 'Patch failed' : 'Applied patch successfully');
}

function systemEvent(sessionId, line, content, payload, timestamp) {
  return {
    uuid: stableId(sessionId, line, 'system_event', payload),
    type: 'system_event',
    content,
    timestamp,
  };
}

function customOutputsSupersededByPatch(lines) {
  const pendingPatchEnds = new Map();
  const skipped = new Set();
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].includes('patch_apply_end')
      && !lines[index].includes('custom_tool_call_output')) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { continue; }
    const payload = entry.payload || {};
    const callId = String(payload.call_id || '');
    if (!callId) continue;
    if (entry.type === 'event_msg' && payload.type === 'patch_apply_end') {
      pendingPatchEnds.set(callId, (pendingPatchEnds.get(callId) || 0) + 1);
    } else if (entry.type === 'response_item' && payload.type === 'custom_tool_call_output') {
      const count = pendingPatchEnds.get(callId) || 0;
      if (count > 0) {
        skipped.add(index);
        if (count === 1) pendingPatchEnds.delete(callId);
        else pendingPatchEnds.set(callId, count - 1);
      }
    }
  }
  return skipped;
}

export function extractCodexMessages(filePath, sessionId, options = {}) {
  if (!fs.existsSync(filePath)) return { messages: [], nextLine: options.startLine || 0 };
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const startLine = Math.min(options.startLine || 0, lines.length);
  const skippedCustomOutputs = customOutputsSupersededByPatch(lines);
  const messages = [];
  const callCounts = new Map();
  const pending = new Map();
  let nextLine = 0;
  let reviewPrompt = '';
  let reviewPromptSeen = false;

  const enqueue = (callId, value) => {
    const queue = pending.get(callId) || [];
    queue.push(value);
    pending.set(callId, queue);
  };
  const dequeue = (callId) => {
    const queue = pending.get(callId) || [];
    const value = queue.shift();
    if (queue.length) pending.set(callId, queue);
    else pending.delete(callId);
    return value;
  };
  const peek = (callId) => (pending.get(callId) || [])[0];

  for (let line = 0; line < lines.length; line++) {
    if (!lines[line].trim()) {
      nextLine = line + 1;
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(lines[line]);
      nextLine = line + 1;
    } catch {
      if (line === lines.length - 1) {
        nextLine = line;
        break;
      }
      nextLine = line + 1;
      continue;
    }
    const payload = entry.payload || {};
    const timestamp = timestampFor(entry);
    const shouldEmit = line >= startLine;

    if (entry.type === 'event_msg' && payload.type === 'entered_review_mode') {
      reviewPrompt = String(payload.user_facing_hint || payload.target?.instructions || '');
      reviewPromptSeen = false;
      if (shouldEmit) {
        messages.push(systemEvent(sessionId, line, 'Review started', payload, timestamp));
      }
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'exited_review_mode') {
      reviewPrompt = '';
      reviewPromptSeen = false;
      if (shouldEmit) {
        messages.push(systemEvent(sessionId, line, 'Review completed', payload, timestamp));
      }
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      const text = String(payload.message || '');
      const isReviewPrompt = !!reviewPrompt && text === reviewPrompt;
      const duplicateReviewPrompt = isReviewPrompt && reviewPromptSeen;
      if (isReviewPrompt) reviewPromptSeen = true;
      if (shouldEmit && text.trim() && !duplicateReviewPrompt) {
        messages.push({
          uuid: stableId(sessionId, line, 'user', payload.message),
          type: 'user',
          content: text,
          timestamp,
        });
      }
      continue;
    }

    if (entry.type === 'response_item' && payload.type === 'message') {
      if (payload.role !== 'assistant') continue;
      const text = assistantText(payload);
      if (shouldEmit && text.trim()) {
        messages.push({
          uuid: stableId(sessionId, line, 'assistant', payload),
          type: 'assistant',
          content: [{ type: 'text', text }],
          timestamp,
          stopReason: 'end_turn',
        });
      }
      continue;
    }

    const isToolCall = entry.type === 'response_item'
      && ['function_call', 'custom_tool_call', 'tool_search_call'].includes(payload.type);
    if (isToolCall) {
      const callId = String(payload.call_id || payload.id || `line-${line}`);
      const occurrence = (callCounts.get(callId) || 0) + 1;
      callCounts.set(callId, occurrence);
      let uses;
      if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch') {
        const patchInputs = parseApplyPatchInput(payload.input);
        uses = (patchInputs.length ? patchInputs : [{ patch: String(payload.input || '') }])
          .map((input, index) => ({
            type: 'tool_use',
            id: pairId(sessionId, callId, occurrence, String(index)),
            name: 'Edit',
            input,
          }));
      } else {
        uses = [{
          type: 'tool_use',
          id: pairId(sessionId, callId, occurrence),
          name: payload.type === 'tool_search_call'
            ? 'ToolSearch'
            : TOOL_NAMES.get(payload.name) || payload.name || 'Tool',
          input: payload.type === 'tool_search_call'
            ? (payload.arguments || { execution: payload.execution || '' })
            : mapToolInput(payload.name, payload.arguments),
        }];
      }
      enqueue(callId, { callId, occurrence, uses, name: payload.name || payload.type });
      if (shouldEmit) {
        messages.push({
          uuid: stableId(sessionId, line, 'tool_call', payload),
          type: 'assistant',
          content: uses,
          timestamp,
          stopReason: 'tool_use',
        });
      }
      continue;
    }

    const isToolOutput = entry.type === 'response_item'
      && ['function_call_output', 'custom_tool_call_output', 'tool_search_output'].includes(payload.type);
    if (isToolOutput) {
      if (payload.type === 'custom_tool_call_output' && skippedCustomOutputs.has(line)) {
        const pair = peek(String(payload.call_id || ''));
        if (pair) pair.fallbackOutput = { line, payload, timestamp };
        continue;
      }
      const pair = dequeue(String(payload.call_id || ''));
      if (!pair || !shouldEmit) continue;
      const content = pair.name === 'view_image'
        ? ''
        : payload.type === 'tool_search_output'
        ? outputText({ status: payload.status, execution: payload.execution, tools: payload.tools })
        : outputText(payload.output);
      messages.push({
        uuid: stableId(sessionId, line, 'tool_output', payload),
        type: 'user',
        content: pair.uses.map((use) => ({
          type: 'tool_result',
          tool_use_id: use.id,
          content,
          is_error: payload.status === 'failed',
        })),
        timestamp,
      });
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'patch_apply_end') {
      const pair = dequeue(String(payload.call_id || ''));
      if (!pair || !shouldEmit) continue;
      const identity = pair.fallbackOutput || { line, payload, timestamp };
      messages.push({
        uuid: stableId(sessionId, identity.line, 'tool_output', identity.payload),
        type: 'user',
        content: pair.uses.map((use) => ({
          type: 'tool_result',
          tool_use_id: use.id,
          content: patchResult(payload),
          is_error: payload.success === false,
        })),
        timestamp: identity.timestamp,
      });
      continue;
    }

    if (entry.type === 'compacted') {
      const summary = String(payload.message || '');
      if (shouldEmit && summary.trim()) {
        messages.push({
          uuid: stableId(sessionId, line, 'summary', payload),
          type: 'summary',
          content: summary,
          timestamp,
        });
      }
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'thread_rolled_back' && shouldEmit) {
      const turns = Math.max(1, Number(payload.num_turns) || 1);
      const content = `Conversation rolled back by ${turns} ${turns === 1 ? 'turn' : 'turns'}`;
      messages.push(systemEvent(sessionId, line, content, payload, timestamp));
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'turn_aborted' && shouldEmit) {
      messages.push({
        uuid: stableId(sessionId, line, 'interrupt', payload),
        type: 'user',
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
        timestamp,
      });
    }
  }

  return { messages, nextLine };
}

export async function syncCodexMessages(filePath, nativeSessionId, storageSessionId, options) {
  const watermarks = options.watermarks;
  const startLine = options.startLine ?? watermarks.get(storageSessionId) ?? 0;
  const extracted = extractCodexMessages(filePath, nativeSessionId, { startLine });
  if (extracted.messages.length > 0) {
    await options.uploader(storageSessionId, extracted.messages, {
      runtime: 'codex',
      nativeSessionId,
    });
  }
  // Commit only after upload so deterministic rows can be retried.
  watermarks.set(storageSessionId, extracted.nextLine);
  return extracted;
}
