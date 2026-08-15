import crypto from 'crypto';
import fs from 'fs';
import {
  codexItemNativeId,
  codexItemLiveKey,
  codexTurnErrorLiveMessage,
  codexTurnUserLiveKey,
  codexTurnUserNativeId,
  codexUserLiveKey,
  codexUserNativeId,
  tagCodexLiveSource,
} from './codex-live.mjs';
import { codexResponseUserText } from './codex-session.mjs';

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

function commandExecutionResult(item) {
  return String(item.aggregated_output
    || item.formatted_output
    || [item.stdout, item.stderr].filter(Boolean).join('\n')
    || item.status
    || '').replace(/^(?:\r?\n)+/, '').trimEnd();
}

function commandExecutionMeta(item) {
  const actions = Array.isArray(item?.parsed_cmd) ? item.parsed_cmd : [];
  const source = String(item?.source || '');
  const exploring = source !== 'user_shell'
    && actions.length > 0
    && actions.every((action) => ['read', 'list_files', 'search'].includes(action?.type));
  return {
    codexCommandKind: exploring ? 'explore' : 'ran',
    codexCommandActions: actions,
    codexCommandSource: source,
  };
}

function mcpToolMeta(item) {
  return {
    codexMcpServer: String(item?.server || ''),
    codexMcpTool: String(item?.tool || ''),
  };
}

function mcpToolResult(item) {
  const result = item?.result;
  if (!result) return String(item?.status || '');
  return outputText(result.content ?? result);
}

function runningProcessId(content) {
  return /Process running with session ID\s+(\d+)/i.exec(String(content || ''))?.[1] || '';
}

function systemEvent(sessionId, line, content, payload, timestamp) {
  return {
    uuid: stableId(sessionId, line, 'system_event', payload),
    type: 'system_event',
    content,
    timestamp,
  };
}

function webSearchMessages(sessionId, line, payload, timestamp) {
  const action = payload.action || {};
  const query = String(payload.query || action.query || action.url || '');
  const searchId = String(payload.id || `line-${line}`);
  const toolUseId = pairId(sessionId, searchId, 1);
  const input = {
    action: action.type || 'search',
    query,
    ...(Array.isArray(action.queries) ? { queries: action.queries } : {}),
    ...(action.url ? { url: action.url } : {}),
  };
  const result = action.type === 'open_page'
    ? `Opened ${action.url || query}`
    : `Searched the web for ${query}`;
  const liveKey = codexItemLiveKey(searchId);
  return [
    tagCodexLiveSource({
      uuid: stableId(sessionId, line, 'web_search_call', payload),
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'WebSearch',
        input,
      }],
      timestamp,
      stopReason: 'tool_use',
    }, liveKey),
    tagCodexLiveSource({
      uuid: stableId(sessionId, line, 'web_search_result', payload),
      type: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: result,
        is_error: false,
      }],
      timestamp,
    }, liveKey),
  ];
}

function hiddenPatchAttemptLines(patchCalls, patchFailures, patchLifecycles) {
  const hidden = new Set();
  for (const [callId, calls] of patchCalls) {
    const sortedCalls = [...calls].sort((a, b) => a - b);
    const failures = [...(patchFailures.get(callId) || [])].sort((a, b) => a - b);
    const lifecycles = [...(patchLifecycles.get(callId) || [])].sort((a, b) => a - b);
    for (let index = 0; index < sortedCalls.length; index++) {
      const callLine = sortedCalls[index];
      const nextCall = sortedCalls[index + 1] ?? Infinity;
      const failedLines = failures.filter((line) => line > callLine && line < nextCall);
      if (!failedLines.length) continue;
      const started = lifecycles.some((line) => line > callLine && line < nextCall);
      if (started) continue;
      hidden.add(callLine);
      for (const line of failedLines) hidden.add(line);
    }
  }
  return hidden;
}

function analyzeLines(lines) {
  const pendingPatchEnds = new Map();
  const skipped = new Set();
  const eventUserCounts = new Map();
  const userClientIdsByTurn = new Map();
  const completedWebSearchIds = new Set();
  const commandExecutions = new Map();
  const mcpToolCalls = new Map();
  const patchCalls = new Map();
  const patchFailures = new Map();
  const patchLifecycles = new Map();
  const rememberPatchLine = (map, callId, line) => {
    const entries = map.get(callId) || [];
    entries.push(line);
    map.set(callId, entries);
  };
  for (let index = lines.length - 1; index >= 0; index--) {
    const hasUser = lines[index].includes('"user_message"')
      || lines[index].includes('"UserMessage"');
    const hasPatch = lines[index].includes('patch_apply_end')
      || lines[index].includes('patch_apply_begin')
      || lines[index].includes('"FileChange"')
      || lines[index].includes('"apply_patch"')
      || lines[index].includes('custom_tool_call_output');
    const hasWebSearch = lines[index].includes('"WebSearch"');
    const hasCommandExecution = lines[index].includes('"CommandExecution"');
    const hasMcpToolCall = lines[index].includes('"McpToolCall"');
    if (!hasUser && !hasPatch && !hasWebSearch && !hasCommandExecution && !hasMcpToolCall) {
      continue;
    }
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { continue; }
    const payload = entry.payload || {};
    const callId = String(payload.call_id || payload.item?.id || '');
    if (entry.type === 'response_item'
      && payload.type === 'custom_tool_call'
      && payload.name === 'apply_patch'
      && callId) {
      rememberPatchLine(patchCalls, callId, index);
    }
    if (entry.type === 'response_item'
      && payload.type === 'custom_tool_call_output'
      && callId
      && /^apply_patch verification failed:/i.test(outputText(payload.output).trim())) {
      rememberPatchLine(patchFailures, callId, index);
    }
    if (callId && (
      (entry.type === 'event_msg'
        && ['patch_apply_begin', 'patch_apply_end'].includes(payload.type))
      || (entry.type === 'event_msg'
        && ['item_started', 'item_completed'].includes(payload.type)
        && payload.item?.type === 'FileChange')
    )) {
      rememberPatchLine(patchLifecycles, callId, index);
    }
    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      const text = String(payload.message || '').trim();
      if (text) eventUserCounts.set(text, (eventUserCounts.get(text) || 0) + 1);
    }
    if (entry.type === 'event_msg'
      && payload.type === 'item_completed'
      && payload.item?.type === 'UserMessage'
      && payload.turn_id
      && payload.item.client_id) {
      userClientIdsByTurn.set(String(payload.turn_id), String(payload.item.client_id));
    }
    if (entry.type === 'event_msg'
      && payload.type === 'item_completed'
      && payload.item?.type === 'WebSearch'
      && payload.item.id) {
      completedWebSearchIds.add(String(payload.item.id));
    }
    if (entry.type === 'event_msg'
      && payload.type === 'item_completed'
      && payload.item?.type === 'CommandExecution'
      && payload.item.id) {
      const callId = String(payload.item.id);
      const executions = commandExecutions.get(callId) || [];
      executions.push({ line: index, item: payload.item, timestamp: timestampFor(entry) });
      commandExecutions.set(callId, executions);
    }
    if (entry.type === 'event_msg'
      && payload.type === 'item_completed'
      && payload.item?.type === 'McpToolCall'
      && payload.item.id) {
      const callId = String(payload.item.id);
      const calls = mcpToolCalls.get(callId) || [];
      calls.push({ line: index, item: payload.item, timestamp: timestampFor(entry) });
      mcpToolCalls.set(callId, calls);
    }
    if (!hasPatch) continue;
    const legacyCallId = String(payload.call_id || '');
    if (!legacyCallId) continue;
    if (entry.type === 'event_msg' && payload.type === 'patch_apply_end') {
      pendingPatchEnds.set(legacyCallId, (pendingPatchEnds.get(legacyCallId) || 0) + 1);
    } else if (entry.type === 'response_item' && payload.type === 'custom_tool_call_output') {
      const count = pendingPatchEnds.get(legacyCallId) || 0;
      if (count > 0) {
        skipped.add(index);
        if (count === 1) pendingPatchEnds.delete(legacyCallId);
        else pendingPatchEnds.set(legacyCallId, count - 1);
      }
    }
  }
  for (const executions of commandExecutions.values()) executions.reverse();
  for (const calls of mcpToolCalls.values()) calls.reverse();
  return {
    commandExecutions,
    completedWebSearchIds,
    eventUserCounts,
    hiddenPatchLines: hiddenPatchAttemptLines(patchCalls, patchFailures, patchLifecycles),
    mcpToolCalls,
    skippedCustomOutputs: skipped,
    userClientIdsByTurn,
  };
}

export function extractCodexMessages(filePath, sessionId, options = {}) {
  if (!fs.existsSync(filePath)) return { messages: [], nextLine: options.startLine || 0 };
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const startLine = Math.min(options.startLine || 0, lines.length);
  const {
    commandExecutions,
    completedWebSearchIds,
    eventUserCounts,
    hiddenPatchLines,
    mcpToolCalls,
    skippedCustomOutputs,
    userClientIdsByTurn,
  } = analyzeLines(lines);
  const messages = [];
  const callCounts = new Map();
  const pending = new Map();
  const execPairs = new Map();
  const executionCounts = new Map();
  const mcpPairs = new Map();
  const mcpCompletionCounts = new Map();
  const backgroundByProcessId = new Map();
  let nextLine = 0;
  let needsSessionScan = startLine === 0;
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
    if (hiddenPatchLines.has(line)) {
      if (payload.type === 'custom_tool_call' && payload.name === 'apply_patch') {
        const callId = String(payload.call_id || payload.id || `line-${line}`);
        callCounts.set(callId, (callCounts.get(callId) || 0) + 1);
      }
      continue;
    }
    if (shouldEmit && (
      entry.type === 'session_meta'
      || (entry.type === 'turn_context' && payload.model)
      || (entry.type === 'response_item' && payload.type === 'message' && payload.role === 'user')
      || (entry.type === 'event_msg' && [
        'task_started',
        'task_complete',
        'turn_aborted',
        'user_message',
      ].includes(payload.type))
    )) {
      needsSessionScan = true;
    }

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

    const contextCompacted = entry.type === 'event_msg' && (
      payload.type === 'context_compacted'
      || (payload.type === 'item_completed' && payload.item?.type === 'ContextCompaction')
    );
    if (contextCompacted) {
      if (shouldEmit) {
        messages.push(systemEvent(sessionId, line, 'Context compacted', payload, timestamp));
      }
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'user_message') {
      const text = String(payload.message || '');
      const isReviewPrompt = !!reviewPrompt && text === reviewPrompt;
      const duplicateReviewPrompt = isReviewPrompt && reviewPromptSeen;
      if (isReviewPrompt) reviewPromptSeen = true;
      if (shouldEmit && text.trim() && !duplicateReviewPrompt) {
        messages.push(tagCodexLiveSource({
          uuid: stableId(sessionId, line, 'user', payload.message),
          nativeId: payload.client_id ? `codex:user:${payload.client_id}` : '',
          type: 'user',
          content: text,
          timestamp,
        }, codexUserLiveKey(payload.client_id)));
      }
      continue;
    }

    if (entry.type === 'response_item' && payload.type === 'message') {
      if (payload.role === 'user') {
        const text = codexResponseUserText(payload);
        const duplicateCount = eventUserCounts.get(text) || 0;
        if (duplicateCount > 0) {
          if (duplicateCount === 1) eventUserCounts.delete(text);
          else eventUserCounts.set(text, duplicateCount - 1);
          continue;
        }
        // Current Codex writes the response_item first, then the canonical
        // event_msg:user_message (with client_id) a few milliseconds later.
        // Do not advance the incremental watermark past a trailing response
        // item, otherwise two watcher scans persist both representations.
        if (shouldEmit && text && line === lines.length - 1) {
          nextLine = line;
          break;
        }
        const isReviewPrompt = !!reviewPrompt && text === reviewPrompt;
        const duplicateReviewPrompt = isReviewPrompt && reviewPromptSeen;
        if (isReviewPrompt) reviewPromptSeen = true;
        if (shouldEmit && text && !duplicateReviewPrompt) {
          const turnId = payload.internal_chat_message_metadata_passthrough?.turn_id;
          const clientId = userClientIdsByTurn.get(String(turnId || ''));
          messages.push(tagCodexLiveSource({
            uuid: stableId(sessionId, line, 'user', payload),
            nativeId: codexUserNativeId(clientId)
              || codexTurnUserNativeId(turnId)
              || codexItemNativeId(payload.id),
            type: 'user',
            content: text,
            timestamp,
          }, codexUserLiveKey(clientId)
            || codexTurnUserLiveKey(turnId)
            || codexItemLiveKey(payload.id)));
        }
        continue;
      }
      if (payload.role !== 'assistant') continue;
      const text = assistantText(payload);
      if (shouldEmit && text.trim()) {
        messages.push(tagCodexLiveSource({
          uuid: stableId(sessionId, line, 'assistant', payload),
          nativeId: codexItemNativeId(payload.id),
          type: 'assistant',
          content: [{ type: 'text', text }],
          timestamp,
        }, codexItemLiveKey(payload.id)));
      }
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'task_complete') {
      if (shouldEmit) {
        const uuid = stableId(sessionId, line, 'task_complete', {
          turn_id: payload.turn_id,
          completed_at: payload.completed_at,
        });
        const errorMessage = codexTurnErrorLiveMessage(
          payload.turn_id,
          payload.error,
          timestamp,
          uuid,
        );
        if (errorMessage) {
          messages.push(tagCodexLiveSource(
            errorMessage.message,
            errorMessage.liveKey,
          ));
        } else {
          messages.push({
            uuid,
            type: 'assistant',
            content: [],
            timestamp,
            stopReason: 'end_turn',
          });
        }
      }
      continue;
    }

    if (entry.type === 'event_msg'
      && payload.type === 'item_completed'
      && payload.item?.type === 'WebSearch') {
      if (shouldEmit) {
        messages.push(...webSearchMessages(sessionId, line, payload.item, timestamp));
      }
      continue;
    }

    if (entry.type === 'event_msg'
      && payload.type === 'item_completed'
      && payload.item?.type === 'CommandExecution') {
      const item = payload.item;
      const callId = String(item.id || '');
      const occurrence = (executionCounts.get(callId) || 0) + 1;
      executionCounts.set(callId, occurrence);
      const pair = (execPairs.get(callId) || [])[occurrence - 1];
      if (pair) pair.executionCompleted = true;
      if (shouldEmit && pair) {
        messages.push(tagCodexLiveSource({
          uuid: stableId(sessionId, line, 'command_execution', {
            id: callId,
            status: item.status,
            exitCode: item.exit_code,
          }),
          type: 'user',
          content: pair.uses.map((use) => ({
            type: 'tool_result',
            tool_use_id: use.id,
            content: commandExecutionResult(item),
            is_error: item.status === 'failed'
              || (Number.isInteger(item.exit_code) && item.exit_code !== 0),
            ...(Number.isInteger(item.exit_code) ? { codexExitCode: item.exit_code } : {}),
            ...commandExecutionMeta(item),
            ...(pair.background ? {
              codexBackground: 'complete',
              codexProcessId: String(item.process_id || pair.processId || ''),
            } : {}),
          })),
          timestamp,
        }, codexItemLiveKey(callId)));
      }
      continue;
    }

    if (entry.type === 'event_msg'
      && payload.type === 'item_completed'
      && payload.item?.type === 'McpToolCall') {
      const item = payload.item;
      const callId = String(item.id || '');
      const occurrence = (mcpCompletionCounts.get(callId) || 0) + 1;
      mcpCompletionCounts.set(callId, occurrence);
      const pair = (mcpPairs.get(callId) || [])[occurrence - 1];
      if (pair) pair.mcpCompleted = true;
      if (shouldEmit && pair) {
        messages.push(tagCodexLiveSource({
          uuid: stableId(sessionId, line, 'mcp_tool_call', {
            id: callId,
            server: item.server,
            tool: item.tool,
            status: item.status,
          }),
          type: 'user',
          content: pair.uses.map((use) => ({
            type: 'tool_result',
            tool_use_id: use.id,
            content: mcpToolResult(item),
            is_error: item.status === 'failed' || item.result?.isError === true,
            ...mcpToolMeta(item),
          })),
          timestamp,
        }, codexItemLiveKey(callId)));
      }
      continue;
    }

    if (entry.type === 'response_item' && payload.type === 'web_search_call') {
      if (shouldEmit && !completedWebSearchIds.has(String(payload.id || ''))) {
        messages.push(...webSearchMessages(sessionId, line, payload, timestamp));
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
        const executionInfo = payload.name === 'exec_command'
          ? commandExecutions.get(callId)?.[occurrence - 1]
          : null;
        const execution = executionInfo?.item;
        const mcpInfo = mcpToolCalls.get(callId)?.[occurrence - 1];
        const input = payload.type === 'tool_search_call'
          ? (payload.arguments || { execution: payload.execution || '' })
          : mapToolInput(payload.name, payload.arguments);
        if (execution && payload.name === 'exec_command') {
          Object.assign(input, commandExecutionMeta(execution));
        }
        if (mcpInfo) Object.assign(input, mcpToolMeta(mcpInfo.item));
        uses = [{
          type: 'tool_use',
          id: pairId(sessionId, callId, occurrence),
          name: payload.type === 'tool_search_call'
            ? 'ToolSearch'
            : TOOL_NAMES.get(payload.name) || payload.name || 'Tool',
          input,
        }];
      }
      const pair = {
        callId,
        occurrence,
        uses,
        name: payload.name || payload.type,
        executionInfo: payload.name === 'exec_command'
          ? commandExecutions.get(callId)?.[occurrence - 1]
          : null,
        mcpInfo: mcpToolCalls.get(callId)?.[occurrence - 1],
      };
      enqueue(callId, pair);
      if (payload.name === 'exec_command') {
        const executions = execPairs.get(callId) || [];
        executions.push(pair);
        execPairs.set(callId, executions);
      }
      if (pair.mcpInfo) {
        const calls = mcpPairs.get(callId) || [];
        calls.push(pair);
        mcpPairs.set(callId, calls);
      }
      if (shouldEmit) {
        messages.push(tagCodexLiveSource({
          uuid: stableId(sessionId, line, 'tool_call', payload),
          type: 'assistant',
          content: uses,
          timestamp,
          stopReason: 'tool_use',
        }, codexItemLiveKey(callId)));
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
      if (!pair) continue;
      const content = pair.name === 'view_image'
        ? ''
        : payload.type === 'tool_search_output'
        ? outputText({ status: payload.status, execution: payload.execution, tools: payload.tools })
        : outputText(payload.output);
      let resultMeta = {};
      if (pair.name === 'exec_command') {
        const processId = runningProcessId(content);
        if (processId && (!pair.executionInfo || pair.executionInfo.line > line)) {
          pair.background = true;
          pair.processId = processId;
          backgroundByProcessId.set(processId, pair);
          resultMeta = {
            codexBackground: 'running',
            codexProcessId: processId,
          };
        } else if (pair.executionInfo || pair.executionCompleted) {
          resultMeta = { codexSuperseded: true };
        } else {
          resultMeta = { codexProvisional: true };
        }
      } else if (pair.name === 'write_stdin') {
        const input = pair.uses[0]?.input || {};
        const processId = String(input.session_id || '');
        if (!String(input.chars || '').length) {
          const background = backgroundByProcessId.get(processId);
          resultMeta = {
            codexWait: runningProcessId(content) ? 'waiting' : 'completed',
            codexProcessId: processId,
            ...(background?.uses?.[0]?.input?.command
              ? { codexCommand: background.uses[0].input.command }
              : {}),
          };
        }
      } else if (pair.mcpInfo || pair.mcpCompleted) {
        resultMeta = { codexSuperseded: true };
      }
      if (!shouldEmit) continue;
      messages.push(tagCodexLiveSource({
        uuid: stableId(sessionId, line, 'tool_output', payload),
        type: 'user',
        content: pair.uses.map((use) => ({
          type: 'tool_result',
          tool_use_id: use.id,
          content: resultMeta.codexSuperseded ? '' : content,
          is_error: payload.status === 'failed',
          ...resultMeta,
        })),
        timestamp,
      }, codexItemLiveKey(pair.callId)));
      continue;
    }

    if (entry.type === 'event_msg' && payload.type === 'patch_apply_end') {
      const pair = dequeue(String(payload.call_id || ''));
      if (!pair || !shouldEmit) continue;
      const identity = pair.fallbackOutput || { line, payload, timestamp };
      messages.push(tagCodexLiveSource({
        uuid: stableId(sessionId, identity.line, 'tool_output', identity.payload),
        type: 'user',
        content: pair.uses.map((use) => ({
          type: 'tool_result',
          tool_use_id: use.id,
          content: patchResult(payload),
          is_error: payload.success === false,
        })),
        timestamp: identity.timestamp,
      }, codexItemLiveKey(pair.callId)));
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

  return { messages, nextLine, needsSessionScan };
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
