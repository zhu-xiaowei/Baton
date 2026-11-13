// Hermes `messages` rows → Baton rows (a compaction carrier adds a "summary" row). Images stay
// `{type:'image', path}`; the history reader loads them.
const JSON_PREFIX = '\u0000json:';
const VISION_RE = /^\[The user sent an image~ Here's what I can see:\n([\s\S]*?)\]\n\[If you need a closer look, use vision_analyze with image_url: (.+?) ~\]\n*/;
const ATTACHED_RE = /\n\n\[Image attached at: ([^\]\n]+)\]/g;
const SKILL_RE = /^\[IMPORTANT: The user has invoked the "([^"]+)" skill[\s\S]*?(?:alongside the skill invocation: ([\s\S]*))?$/;
const STEER_RE = /^\[OUT-OF-BAND USER MESSAGE[^\]\n]*\]\n([\s\S]*?)\n\[\/OUT-OF-BAND USER MESSAGE\]$/;
const UNTRUSTED_RE = /^<untrusted_tool_result[^>]*>\n(?:The following content[^\n]*\n)?\n?([\s\S]*?)\n?<\/untrusted_tool_result>\s*$/;
const PRIOR_END = '[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]';

export function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function decodeContent(content) {
  if (typeof content === 'string' && content.startsWith(JSON_PREFIX)) return parseJson(content.slice(JSON_PREFIX.length), content);
  return content ?? '';
}

export function flatten(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n');
  return '';
}

const iso = (seconds) => (seconds ? new Date(Number(seconds) * 1000).toISOString() : '');

// An image is stored as a vision description plus Hermes' cached file.
function userBlocks(content) {
  const blocks = [];
  let text = flatten(decodeContent(content));
  const vision = VISION_RE.exec(text);
  if (vision) {
    text = text.slice(vision[0].length);
    blocks.push({ type: 'image', path: vision[2].trim(), alt: vision[1].trim() });
  }
  text = text.replace(ATTACHED_RE, (_, file) => { blocks.push({ type: 'image', path: file.trim() }); return ''; });
  const skill = SKILL_RE.exec(text);
  if (skill) text = `/${skill[1]} ${skill[2] || ''}`;
  text = (STEER_RE.exec(text)?.[1] ?? text).trim();
  return [...(text ? [{ type: 'text', text }] : []), ...blocks];
}

// { name, input } in Baton's tool vocabulary.
export function mapTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'terminal': return { name: 'Bash', input: { command: a.command || '' } };
    case 'execute_code': return { name: 'Bash', input: { command: a.code || '', description: 'execute_code (Python)' } };
    case 'read_file': return { name: 'Read', input: { file_path: a.path || '' } };
    case 'write_file': return { name: 'Write', input: { file_path: a.path || '', content: a.content || '' } };
    case 'patch': return { name: 'Edit', input: { file_path: a.path || '', old_string: a.old_string || '', new_string: a.new_string || '' } };
    case 'search_files': return a.target === 'files'
      ? { name: 'Glob', input: { pattern: a.pattern || '', ...(a.path ? { path: a.path } : {}) } }
      : { name: 'Grep', input: { pattern: a.pattern || '', ...(a.path ? { path: a.path } : {}) } };
    case 'todo_list': case 'todo':
      return { name: 'TodoWrite', input: { todos: (a.todos || []).map((t) => ({ content: t.content || '', status: t.status || 'pending', activeForm: t.content || '' })) } };
    case 'delegate_task': {
      const tasks = Array.isArray(a.tasks) ? a.tasks : a.goal ? [a] : [];
      return { name: 'Agent', input: { description: tasks.map((t) => t.goal).join('; ').slice(0, 200),
        prompt: tasks.map((t) => [t.goal, t.context].filter(Boolean).join('\n\n')).join('\n\n---\n\n'),
        subagent_type: tasks.length > 1 ? `hermes ×${tasks.length}` : 'hermes' } };
    }
    case 'web_search': return { name: 'WebSearch', input: { query: a.query || '' } };
    case 'web_extract': return { name: 'WebFetch', input: { url: (a.urls || [])[0] || a.url || '' } };
    case 'clarify': {
      const questions = Array.isArray(a.questions) ? a.questions : [{ question: a.question, choices: a.choices }];
      return { name: 'AskUserQuestion', input: { questions: questions.map((q) => ({ question: q.question || '', header: '',
        multiSelect: !!q.multi_select, options: (q.choices || []).map((c) => ({ label: String(c), description: '' })) })) } };
    }
    case 'vision_analyze': return { name: 'ViewImage', input: { path: a.image_url || '' } };
    case 'skill_view': return { name: 'Skill', input: { skill: a.name || '' } };
    default: return { name: `mcp__hermes__${name}`, input: a };
  }
}

// Calls inside the lazy-tool wrapper `tool_call {calls:[{name, arguments}]}` become their own cards.
function toolCalls(calls) {
  return (calls || []).flatMap((call) => {
    const args = parseJson(call.function?.arguments, {});
    if (call.function?.name !== 'tool_call' || !Array.isArray(args?.calls)) return [{ id: call.id || '', name: call.function?.name, args }];
    return args.calls.map((inner, i) => ({ id: i ? `${call.id}#${i}` : call.id, name: inner.name, args: inner.arguments || {} }));
  });
}

// A tool row's JSON text → tool_result fields.
export function toolResult(toolName, raw) {
  let text = flatten(decodeContent(raw));
  text = UNTRUSTED_RE.exec(text)?.[1] ?? text;
  const data = parseJson(text, null);
  if (!data || typeof data !== 'object') return { content: text, is_error: /^(Error|BLOCKED)/.test(text) };
  if (toolName === 'terminal' || toolName === 'execute_code') {
    const output = [data.output ?? '', data.error ? String(data.error) : ''].filter(Boolean).join('\n');
    // exit_code is the wrapper shell's; models often end a failing command with `; echo EXIT=$?`.
    const exit = Number(data.exit_code) || Number(/\bEXIT=(\d+)\s*$/.exec(data.output || '')?.[1]) || 0;
    return { content: output, is_error: exit !== 0 || !!data.error, codexExitCode: exit };
  }
  if (toolName === 'read_file') return { content: data.content ?? data.error ?? text, is_error: !!data.error };
  if (toolName === 'write_file') return { content: data.error ? String(data.error) : `Created ${data.bytes_written ?? ''} bytes`, is_error: !!data.error };
  if (toolName === 'patch') return { content: data.error ? String(data.error) : data.diff || 'Applied changes successfully.', is_error: data.success === false || !!data.error };
  if (toolName === 'clarify') {
    const answers = (data.responses || []).map((r) => `${r.question} → ${[].concat(r.user_response ?? r.status).join(', ')}`).join('\n');
    return { content: answers || text, is_error: !!data.outcome && data.outcome !== 'submitted' };
  }
  if (toolName === 'search_files') return { content: data.matches_text ?? data.output ?? text, is_error: !!data.error };
  return { content: JSON.stringify(data, null, 2), is_error: data.success === false || !!data.error };
}

// delegations: delegation id → delegate_task tool_call_id, for the background "completed" row.
export function convertRow(r, delegations = new Map()) {
  const timestamp = iso(r.timestamp);
  const uuid = r.message_uid || `hermes-${r.id}`;
  const meta = parseJson(r.display_metadata, {}) || {};
  if (r.role === 'session_meta' || meta.model_only || (r.display_kind === 'hidden' && !meta.interrupted)) return [];
  if (r.display_kind === 'hidden') return [{ uuid, type: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }], timestamp }];
  if (r.role === 'user') {
    const body = flatten(decodeContent(r.content));
    if (r.display_kind === 'async_delegation_complete') {
      const id = /DELEGATION BATCH COMPLETE — (deleg_[0-9a-f]+)/.exec(body)?.[1];
      const secs = /Total duration: ([\d.]+)s/.exec(body)?.[1];
      if (delegations.has(id)) {
        return [{ uuid, type: 'user', timestamp, content: [{ type: 'tool_result', tool_use_id: delegations.get(id), content: body, is_error: /✗|FAILED/.test(body.slice(0, 2000)) }],
          ...(secs ? { toolUseResult: { totalDurationMs: Math.round(Number(secs) * 1000) } } : {}) }];
      }
    }
    if (r.display_kind === 'process_complete') return [{ uuid, type: 'system_event', icon: 'clock', content: meta.display_text || 'Background process finished', timestamp }];
    const content = userBlocks(r.content);
    // A prompt Baton sent carries its turn id: the same identity as the live row.
    const turnId = meta.submission_id;
    return content.length ? [{ uuid: turnId || uuid, type: 'user', content, timestamp, ...(turnId ? { nativeId: `live:user:${turnId}` } : {}) }] : [];
  }
  if (r.role === 'assistant') {
    const out = [];
    let text = flatten(decodeContent(r.content));
    if (r._compressed_summary) {
      const at = text.indexOf(PRIOR_END);
      const summary = (at < 0 ? text : text.slice(at + PRIOR_END.length)).replace(/^\s*\[CONTEXT COMPACTION — REFERENCE ONLY\][\s\S]*?\n\n/, '').trim();
      out.push({ uuid: `${uuid}:compaction`, type: 'summary', content: summary || 'Context compacted', timestamp });
      text = '';
    }
    const blocks = [];
    const reasoning = r.reasoning || r.reasoning_content;
    if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning });
    const failed = r.display_kind === 'failed_turn';
    if (failed) text = [text, meta.error ? `(${meta.error})` : ''].filter(Boolean).join('\n\n');
    if (text.trim()) blocks.push({ type: 'text', text });
    for (const call of toolCalls(parseJson(r.tool_calls, []))) {
      const { name, input } = mapTool(call.name, call.args);
      blocks.push({ type: 'tool_use', id: call.id, name, input });
    }
    const stopReason = failed ? 'error' : { tool_calls: 'tool_use', stop: 'end_turn' }[r.finish_reason];
    if (blocks.length) out.push({ uuid, type: 'assistant', content: blocks, timestamp, ...(stopReason ? { stopReason } : {}) });
    return out;
  }
  if (r.role !== 'tool') return [];
  const result = toolResult(r.tool_name, r.content);
  return [{ uuid, type: 'user', timestamp, content: [{ type: 'tool_result', tool_use_id: r.tool_call_id || '', ...result,
    ...(r.tool_name === 'patch' && !result.is_error ? { _toolName: 'Edit' } : {}) }] }];
}
