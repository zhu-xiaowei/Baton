// OpenCode 2.x rows → Baton rows: one row per block of a step plus one per tool result
// (`<msgId>#b:<toolId|t0|r0>`, `<msgId>#r:<toolId>`), the same live and in history.
import os from 'node:os';
import path from 'node:path';
import { nativeOrderKey } from './extract.mjs';
import { markEditResult } from './tool-preview.mjs';
import { parseApplyPatchInput } from './codex-extract.mjs';

const xdg = (name, fallback) => path.join(process.env[name] || path.join(os.homedir(), fallback), 'opencode');
export const DB_FILE = path.join(xdg('XDG_DATA_HOME', '.local/share'), 'opencode.db');
export const SERVICE_FILE = path.join(xdg('XDG_STATE_HOME', '.local/state'), 'service.json');

// OpenCode's web-app label: no title, or the old "New session - <ISO>" fallback, reads as the kind.
export function displayLabel(title, parent) {
  const fallback = /^(New session|Child session) - \d{4}-\d\d-\d\dT[\d:.]+Z$/.exec(title || '')?.[1];
  return title && !fallback ? title : fallback || (parent ? 'Child session' : 'New session');
}

// 2.x names, plus the 1.x ones kept in migrated history (bash / task).
export const TOOL_NAMES = {
  shell: 'Bash', bash: 'Bash', read: 'Read', edit: 'Edit', patch: 'Edit', write: 'Write', grep: 'Grep',
  glob: 'Glob', todowrite: 'TodoWrite', subagent: 'Agent', task: 'Agent', question: 'AskUserQuestion',
  skill: 'Skill', webfetch: 'WebFetch', websearch: 'WebSearch',
};
export const toolName = (name) => TOOL_NAMES[name] || String(name || 'tool');

function toolInput(name, input = {}) {
  const file = input.path ?? input.filePath ?? '';
  switch (TOOL_NAMES[name]) {
    case 'Bash': return { command: input.command || '', ...(input.description ? { description: input.description } : {}) };
    case 'Read': return { file_path: file, offset: input.offset, limit: input.limit };
    case 'Edit': {
      if (name !== 'patch') return { file_path: file, old_string: input.oldString ?? '', new_string: input.newString ?? '', replace_all: !!input.replaceAll };
      // Codex's apply_patch envelope: the first file is the card, the others are listed.
      const changes = parseApplyPatchInput(input.patchText || '');
      return { file_path: '', old_string: '', new_string: '', ...changes[0], ...(changes.length > 1 ? { files: changes.map((c) => c.file_path) } : {}) };
    }
    case 'Write': return { file_path: file, content: input.content ?? '' };
    case 'Grep': case 'Glob': return { pattern: input.pattern || '', path: input.path, glob: input.include };
    case 'TodoWrite': return { todos: Array.isArray(input.todos) ? input.todos : [] };
    case 'Agent': return { description: input.description || '', prompt: input.prompt || '', subagent_type: input.agent || input.subagent_type || '' };
    case 'AskUserQuestion': return { questions: (input.questions || []).map((q) => ({ question: q.question || '', header: q.header || '',
      options: q.options || [], multiSelect: !!q.multiple })) };
    default: return input;
  }
}

const contentText = (content) => (Array.isArray(content)
  ? content.map((c) => (c?.type === 'text' ? c.text : c?.uri ? `[${c.mime || 'file'}] ${c.uri}` : '')).filter(Boolean).join('\n')
  : typeof content === 'string' ? content : '');

function toolResult(tool) {
  const state = tool.state || {};
  const name = toolName(tool.name);
  if (state.status === 'completed') {
    const exit = state.metadata?.exit;
    return markEditResult({ type: 'tool_result', tool_use_id: tool.id, content: contentText(state.content) || state.metadata?.output || '',
      is_error: Number.isInteger(exit) && exit !== 0, ...(Number.isInteger(exit) ? { exitCode: exit } : {}) }, name);
  }
  if (state.status !== 'error') return null;
  const error = state.error || {};
  const text = error.type === 'permission.rejected' ? `Permission rejected: ${error.message || ''}`
    : error.type === 'aborted' ? `[Interrupted] ${error.message || ''}` : error.message || 'Tool failed';
  const partial = contentText(state.content);
  return markEditResult({ type: 'tool_result', tool_use_id: tool.id, content: partial ? `${partial}\n${text}` : text, is_error: true }, name);
}

// Files a Baton prompt attached are already shown through the text's own references.
function userContent(data) {
  const blocks = data.text ? [{ type: 'text', text: data.text }] : [];
  for (const file of data.files || []) {
    const uri = String(file.source?.uri || file.uri || '');
    if (/[\\/]\.baton-bridge[\\/]/.test(decodeURIComponent(uri))) continue;
    const data64 = file.data || (/^data:/.test(file.uri) ? file.uri.split(',')[1] : '');
    if (String(file.mime).startsWith('image/') && data64) blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mime, data: data64 } });
    else blocks.push({ type: 'text', text: `[attachment] ${file.name || uri || file.mime}` });
  }
  return blocks;
}

const STOP = { stop: 'end_turn', 'tool-calls': 'tool_use', length: 'max_tokens' };
const iso = (ms) => new Date(Number.isFinite(ms) ? ms : 0).toISOString();

// History rows are ordered by `line`.
export function messageRows(row, line) {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  const base = { uuid: row.id, nativeId: row.id, timestamp: iso(data.time?.created ?? row.time_created) };
  const key = (f) => (line == null ? {} : { orderKey: nativeOrderKey(line, f) });
  const one = (type, content, extra) => [{ ...base, type, content, ...key(0), ...extra }];
  const results = (list) => list.map((r, i) => ({ ...base, uuid: `${row.id}#r:${r.tool_use_id}`, nativeId: `${row.id}#r:${r.tool_use_id}`,
    type: 'user', content: [r], ...key(i + 1) }));
  switch (row.type) {
    case 'user': {
      const turnId = data.metadata?.baton?.turnId;
      return one('user', userContent(data), turnId ? { nativeId: `live:user:${turnId}` } : {});
    }
    case 'assistant': { // one row per block, like Claude's JSONL: `<msgId>#b:<toolId|t0|r0>`, results `<msgId>#r:<toolId>`
      const out = [];
      const count = { text: 0, reasoning: 0 };
      const add = (uuid, type, block) => out.push({ ...base, uuid, nativeId: uuid, type, content: [block], ...key(out.length) });
      for (const part of data.content || []) {
        const id = `${row.id}#b:${part.type === 'tool' ? part.id : `${part.type[0]}${count[part.type]++}`}`;
        if (part.type === 'text' && part.text) add(id, 'assistant', { type: 'text', text: part.text });
        else if (part.type === 'reasoning' && part.text) add(id, 'assistant', { type: 'thinking', thinking: part.text });
        else if (part.type === 'tool') {
          add(id, 'assistant', { type: 'tool_use', id: part.id, name: toolName(part.name), input: toolInput(part.name, part.state?.input) });
          const result = toolResult(part);
          if (result) add(`${row.id}#r:${part.id}`, 'user', result);
        }
      }
      // A failed step without content is reported by the turn's idle {outcome:failed} row.
      const last = out.findLast((r) => r.type === 'assistant');
      if (last && STOP[data.finish]) last.stopReason = STOP[data.finish];
      return out;
    }
    case 'idle':
      if (data.outcome === 'interrupted') return one('user', [{ type: 'text', text: '[Request interrupted by user]' }]);
      return one('assistant', data.outcome === 'failed' ? [{ type: 'text', text: `Error: ${data.error?.message || 'turn failed'}` }] : [],
        { stopReason: 'end_turn' });
    case 'shell': { // a user `!cmd`
      const id = data.shellID || row.id;
      const failed = ['killed', 'timeout'].includes(data.status);
      const output = (typeof data.output === 'string' ? data.output : data.output?.output || '') + (failed ? `\n[${data.status}]` : '');
      return [...one('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command: data.command || '' } }]),
        ...(data.status === 'running' ? [] : results([{ type: 'tool_result', tool_use_id: id, content: output,
          is_error: failed || (Number.isInteger(data.exit) && data.exit !== 0) }]))];
    }
    case 'compaction':
      if (data.status === 'failed') return one('system_event', `Compaction failed: ${data.error?.message || ''}`);
      return data.status === 'completed' && data.summary ? one('summary', data.summary) : [];
    case 'skill': return one('system_event', `Loaded skill: ${data.name || data.skill || ''}`);
    case 'synthetic': case 'system': return one('system_event', data.description || data.text || '');
    default: return []; // agent-switched / model-switched / location-switched
  }
}
