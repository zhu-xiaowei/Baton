// DSH v4 session events → Baton rows. A tool call, its result and the assistant message are separate
// events with their own ids, so every row comes from exactly one event.
import path from 'node:path';

// bridge/extract.mjs's nativeOrderKey; that module loads sharp, which the catalog workers must not.
export const nativeOrderKey = (line, fragment = 0) => `O2#${String(line).padStart(12, '0')}#${String(fragment).padStart(4, '0')}`;

// Messages from other agents or triggers are a one-line notice; other non-user inputs are model context.
const NOTICE = new Set(['agent-message', 'subagent-settled', 'subagent-report', 'team-message', 'webhook', 'schedule']);
const INTERRUPT = [{ type: 'text', text: '[Request interrupted by user]' }];
const END_NOTICE = { blocked: 'Turn blocked by a hook or guard', 'max-tokens': 'Turn stopped: output token limit reached', forked: 'Session forked here' };

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// DSH tool → the Baton tool the App renders, with Claude's field names.
export function mapTool(name, args) {
  let a = args;
  if (typeof a !== 'object' || !a) try { a = JSON.parse(String(a || '{}')); } catch { a = { raw: String(a) }; }
  const elevated = a.sandbox_permissions && a.sandbox_permissions !== 'use_default'
    ? { sandbox_permissions: 'require_escalated', justification: a.justification || '' } : {};
  switch (name) {
    case 'bash': case 'pwsh': return { name: 'Bash', input: { ...pick(a, ['command', 'description']), ...elevated } };
    case 'cua_run_code': return { name: 'Bash', input: { command: a.code || '', description: a.description || '' } };
    case 'read': return { name: 'Read', input: pick(a, ['file_path', 'offset', 'limit']) };
    case 'read_image': return { name: 'ViewImage', input: { path: a.file_path } };
    case 'office_render': return { name: 'ViewImage', input: { path: a.input || '' } };
    case 'edit': return { name: 'Edit', input: { ...pick(a, ['file_path', 'old_string', 'new_string', 'replace_all']), ...elevated } };
    case 'write': return { name: 'Write', input: { ...pick(a, ['file_path', 'content']), ...elevated } };
    case 'apply_patch': return { name: 'Edit', input: { patch: a.patch || a.input || a.raw || '' } };
    case 'grep': return { name: 'Grep', input: { ...pick(a, ['pattern', 'path']), ...(a.include ? { glob: a.include } : {}) } };
    case 'session_search': return { name: 'Grep', input: { pattern: a.query || '' } };
    case 'glob': return { name: 'Glob', input: pick(a, ['pattern', 'path']) };
    case 'todo_write': return { name: 'TodoWrite', input: { todos: (a.todos || []).map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm || t.content })) } };
    case 'subagent': return { name: 'Agent', input: { description: a.description || a.name || '', prompt: a.prompt || '', subagent_type: a.name || 'subagent' } };
    case 'ask_user_question': return { name: 'AskUserQuestion', input: { questions: (a.questions || []).map((q) => ({ ...q, multiSelect: !!(q.multi_select ?? q.multiSelect) })) } };
    case 'exit_plan_mode': return { name: 'ExitPlanMode', input: { plan: a.plan || '' } };
    case 'job_output': return { name: 'WriteStdin', input: { session_id: a.job_id || '' } };
    case 'terminal_read': case 'user_terminal_read': return { name: 'WriteStdin', input: { session_id: a.sessionId || a.id || '' } };
    case 'terminal_send': return { name: 'WriteStdin', input: { session_id: a.sessionId || '', chars: a.text || '' } };
    case 'web_search': return { name: 'WebSearch', input: pick(a, ['query']) };
    case 'web_fetch': return { name: 'WebFetch', input: pick(a, ['url', 'prompt']) };
    default: return { name: /^[\w-]+__[\w-]+$/.test(name) && !name.startsWith('mcp__') ? `mcp__${name}` : name || 'Tool', input: a };
  }
}

// Attachments are content-addressed (sha256); the key matches the App's upload key for the same bytes.
function imageBlock(c, home) {
  const att = c.attachment || {};
  const sha = String(att.attachmentId || '').replace(/^sha256:/, '');
  if (!sha) return { type: 'image', placeholder: true };
  const ext = (att.mediaType || 'image/png').split('/')[1].replace('jpeg', 'jpg');
  return { type: 'image', key: `${sha.slice(0, 32)}.${ext}`, mediaType: att.mediaType || '',
    path: path.join(home, 'attachments', 'v1', 'objects', sha.slice(0, 2), sha) };
}

const textOf = (content) => (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// "<path>…</path>\n<type>…</type>\n<content>…</content>" from dsh file tools; numbered lines
// ("12: text") become Claude's "    12→text", so the Read card shows line numbers.
export function unwrapFileResult(text) {
  const m = /^<path>[^<]*<\/path>\n<type>\w+<\/type>\n<content>\n?([\s\S]*?)\n?<\/content>\s*$/.exec(text);
  if (!m) return text;
  const lines = m[1].replace(/\n*\(End of file[^)]*\)\s*$/, '').split('\n');
  if (!lines.every((l) => /^\d+:( |$)/.test(l))) return lines.join('\n');
  return lines.map((l) => { const i = l.indexOf(':'); return `${l.slice(0, i).padStart(6)}→${l.slice(i + 2)}`; }).join('\n');
}

// Rows of one event; `home` is the DSH_HOME (attachments), `sid` the native session id.
export function eventRows(event, frame, i, { sid, home }) {
  const d = event.data || {};
  const base = { timestamp: event.time ? new Date(event.time).toISOString() : '', orderKey: nativeOrderKey(frame, i * 100) };
  const notice = (key, content, extra) => [{ uuid: `dsh-${key}-${sid}-${event.seq ?? d.turn}`, type: 'system_event', content, ...base, ...extra }];
  switch (event.type) {
    case 'user/message': {
      const kind = d.source?.kind;
      if (NOTICE.has(kind)) return [{ uuid: d.id, type: 'system_event', content: d.source?.summary || textOf(d.content).slice(0, 300), ...base }];
      if (kind === 'skill-invocation') return [{ uuid: d.id, type: 'system_event', content: `Skill: ${d.source?.name || ''}`, ...base }];
      if (kind !== 'user' && kind !== 'user-question-reply') return [];
      const content = (d.content || []).map((c) => (c.type === 'image' ? imageBlock(c, home)
        : c.type === 'file' ? { type: 'document', title: c.attachment?.name || c.name || 'file' }
          : c.type === 'text' ? { type: 'text', text: c.text } : null)).filter(Boolean);
      return content.length ? [{ uuid: d.id, type: 'user', content, ...base }] : [];
    }
    case 'assistant/message': {
      const m = d.message || {};
      const content = [];
      for (const b of m.content || []) {
        if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
        else if (b.type === 'reasoning' && b.text) content.push({ type: 'thinking', thinking: b.text });
        else if (b.type === 'tool-call') content.push({ type: 'tool_use', id: b.id, ...mapTool(b.name, b.arguments) });
        else if (b.type === 'image') content.push(imageBlock(b, home));
      }
      // One row per block, like Claude's transcript, so each live block meets its own row.
      return content.map((block, k) => ({ uuid: k ? `${m.id}:${k}` : m.id, type: 'assistant', content: [block], ...base,
        orderKey: nativeOrderKey(frame, i * 100 + k),
        ...(k === content.length - 1 ? { stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn' } : {}) }));
    }
    case 'tool/result': {
      const m = d.message || {};
      let text = unwrapFileResult(textOf(m.content));
      // Some aborted tools are logged as "Error: [object Object]"; data.error has the cause.
      if (d.error && (!text || text.includes('[object Object]'))) text = `Error: ${d.error.code || d.error.name}`;
      // A shell exiting non-zero is not isError in dsh; its output ends with the exit code.
      const exit = /\[exit code: (-?\d+)\]/.exec(text.split('\n').slice(-8).join('\n'));
      return [{ uuid: m.id, type: 'user', ...base, content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: text,
        is_error: !!m.isError || (!!exit && exit[1] !== '0') }, ...(m.content || []).filter((c) => c.type === 'image').map((c) => imageBlock(c, home))] }];
    }
    case 'turn/end': {
      const r = d.reason || {};
      const why = r.reason?.kind;
      if ((r.kind === 'aborted' && why === 'user') || r.kind === 'interrupted') return [{ uuid: `dsh-interrupt-${sid}-${d.turn}`, type: 'user', content: INTERRUPT, ...base }];
      // Disposed (takeover, process exit), parent or hook: not a turn the user should be told is done.
      if (r.kind === 'aborted') return notice('aborted', `Turn stopped (${why || 'aborted'})`, { noAlert: true });
      if (END_NOTICE[r.kind]) return notice('end', END_NOTICE[r.kind]);
      if (r.kind === 'error') return [{ uuid: `dsh-error-${sid}-${d.turn}`, type: 'assistant', content: [{ type: 'text', text: `Error: ${r.error?.message || r.error?.code || 'turn failed'}` }], ...base, stopReason: 'end_turn' }];
      return [];
    }
    case 'plan/mode': return notice('plan', d.active === false || d.mode === 'off' ? 'Plan mode off' : 'Plan mode on');
    case 'compaction/summary': return [{ uuid: `dsh-compact-${sid}-${event.seq}`, type: 'summary', content: Array.isArray(d.summary) ? textOf(d.summary) : String(d.summary || ''), ...base }];
    case 'command/run': return notice('cmd', `/${d.name}${d.args ? ` ${d.args}` : ''}`);
    case 'command/done': return d.kind === 'error' || d.text ? notice('cmddone', `${d.kind === 'error' ? 'Command failed' : 'Command'}: ${String(d.text || '').slice(0, 300)}`) : [];
    case 'deliverables/presented': return notice('present', `Presented: ${(d.files || []).map((f) => f.path || f.name || '').join(', ')}`);
    case 'goal/change': return notice('goal', `Goal ${d.operation || d.kind || 'changed'}${d.goal?.objective || d.objective ? `: ${d.goal?.objective || d.objective}` : ''}`);
    case 'working-directory/change': return notice('cwd', `Working directory: ${d.cwd}`);
    default: return []; // header, end-seed, approvals (shown by the tool result), bookkeeping
  }
}
