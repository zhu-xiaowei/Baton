// Kiro CLI 3.x (v3 engine): sessions/<hash16>/<id>/{session.json, messages.jsonl, sub-executions/<sub>.jsonl}
// (v2-engine sessions/cli is not read). Catalog, history and tool details; this module is also
// what the index, history and tool-details workers load, so it stays free of sharp and ws.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LineIndex } from './history-line-index.mjs';
import { readPage } from './history-page.mjs';
import { previewText } from './session.mjs';
import { procStart } from './turn-process.mjs';

export const HOME = process.env.KIRO_HOME || path.join(os.homedir(), '.kiro');
export const ROOT = path.join(HOME, 'sessions');
export const LEASES = path.join(HOME, 'session-leases');
export const CLIENT = 'baton-bridge';
const DASHBOARD = path.join(ROOT, 'dashboard-meta.json');
const CHUNK = 1 << 20;
const PREFIX = 4096;
const HEAD = /^\{"id":"(?:[^"\\]|\\.)*","timestamp":"[^"]*","payload":\{"type":"(\w+)"/;
const NOTED = new Set(['sub_agent_start', 'turn_start', 'session_metadata']);
const UNSHOWN = new Set(['session_start', 'agent_note', 'usage_summary', 'session_event', 'pending_interaction', 'interaction_resolved']);
// Title rules of the kiro-cli 3.2 /sessions dashboard (tui.js).
const PLACEHOLDERS = new Set(['', 'New Session', '(no title)']);
const SUBAGENT_TITLE = /^(?:subagent(?:\.\s| task\.\s+(?=[^.]{0,80}\bcompact[,\s]+condensed style\b))|you are (?:(?:a|an)\s+)?(?:[\w-]+\s+){0,4}subagent\b|you are a (?:session naming agent|fresh-eyes|memory consolidation)\b)/i;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const ls = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

export function parse(file) {
  if (!file.startsWith(ROOT + path.sep) || !file.endsWith('.jsonl')) return null;
  const p = file.slice(ROOT.length + 1).split(path.sep);
  if (p.length === 3 && p[2] === 'messages.jsonl') return { id: p[1] };
  if (p.length === 4 && p[2] === 'sub-executions') return { id: p[3].slice(0, -6), parent: p[1] };
  return null;
}

function files() {
  const out = [];
  for (const hash of ls(ROOT)) {
    if (!/^[0-9a-f]{16}$/.test(hash)) continue;
    for (const id of ls(path.join(ROOT, hash))) {
      const dir = path.join(ROOT, hash, id);
      out.push(path.join(dir, 'messages.jsonl'));
      for (const sub of ls(path.join(dir, 'sub-executions'))) if (sub.endsWith('.jsonl')) out.push(path.join(dir, 'sub-executions', sub));
    }
  }
  return out;
}

export const sessionFile = (id) => ls(ROOT).map((hash) => path.join(ROOT, hash, id, 'messages.jsonl')).find((file) => fs.existsSync(file)) || null;

// JSON string value of `key` in a line prefix that may be cut mid-value.
function stringField(text, key) {
  const at = text.indexOf(`"${key}":"`);
  if (at === -1) return '';
  const s = text.slice(at + key.length + 4);
  const raw = /^((?:[^"\\]|\\.)*)"/.exec(s)?.[1] ?? s.replace(/\\u?[0-9a-fA-F]{0,3}$|\\$/, '');
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

// First non-empty line outside ``` fences, at most 150 graphemes.
function promptHead(text) {
  let fence = false;
  let line = '';
  for (const raw of String(text || '').split('\n')) {
    const t = raw.trim();
    if (t.startsWith('```')) fence = !fence;
    else if (!fence && t) { line = t; break; }
  }
  return Array.from(graphemes.segment(line), (g) => g.segment).slice(0, 150).join('');
}

// Kiro titles are one line of at most 80 characters; anything else gets the usual preview cut.
const titleText = (value, text = String(value ?? '').trim()) => (/[\r\n]/.test(text) || text.length > 200 ? previewText(text) : text);

const canonicalId = (id) => /^(?:sess_)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(id)?.[1]?.toLowerCase() ?? id;

// Dashboard renames (the first entry per session wins), re-read when the file changes.
let dashboard = { key: null, names: new Map() };
function renamed(id) {
  try {
    const st = fs.statSync(DASHBOARD);
    const key = `${st.mtimeMs}:${st.size}`;
    if (dashboard.key !== key) {
      const titled = Object.entries(JSON.parse(fs.readFileSync(DASHBOARD, 'utf8')) || {}).filter(([, e]) => typeof e?.title === 'string' && e.title.trim());
      dashboard = { key, names: new Map(titled.reverse().map(([sid, e]) => [canonicalId(sid), e.title])) };
    }
  } catch {} // missing or mid-write: the last good copy stays
  return dashboard.names.get(canonicalId(id));
}

// Complete lines from `from`, each as its first PREFIX bytes; returns the offset after the last one.
function scan(file, from, onLine) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  let head = Buffer.alloc(0);
  let start = from;
  try {
    for (let pos = from, n; (n = fs.readSync(fd, buf, 0, CHUNK, pos)) > 0; pos += n) {
      const view = buf.subarray(0, n);
      let s = 0;
      for (let nl = view.indexOf(10); nl !== -1; nl = view.indexOf(10, s)) {
        onLine(Buffer.concat([head, view.subarray(s, Math.min(nl, s + PREFIX - head.length))]).toString('utf8'));
        head = Buffer.alloc(0);
        s = nl + 1;
        start = pos + s;
      }
      if (head.length < PREFIX) head = Buffer.concat([head, view.subarray(s, s + PREFIX - head.length)]);
    }
    return start;
  } finally {
    fs.closeSync(fd);
  }
}

const newState = () => ({ offset: 0, lines: 0, users: 0, first: '', title: '', cwd: '', model: '', open: false,
  pending: 0, question: '', metaMs: 0, parentId: '', reason: '' });

function readMeta(file, where, state) {
  const metaFile = path.join(path.dirname(file), 'session.json');
  let m;
  try {
    const st = fs.statSync(metaFile);
    if (st.mtimeMs === state.metaMs) return;
    m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    state.metaMs = st.mtimeMs;
  } catch { return; } // mid-rename: the next change reads it
    Object.assign(state, { cwd: m.workspacePaths?.[0] || m.rootPaths?.[0] || '', title: titleText(m.title), model: m.modelId || '',
      parentId: m.parentSessionId || m._meta?.kiro?.serverSession?.ownerSessionId || '', reason: typeof m.createdReason === 'string' ? m.createdReason : '' });
}

// Whole lines only; session.json is re-read whenever its mtime changed (it is rewritten at each turn end).
function advance(file, id, state) {
  const where = parse(file);
  if (!where.parent) readMeta(file, where, state);
  state.offset = scan(file, state.offset, (text) => {
    state.lines++;
    const type = HEAD.exec(text)?.[1];
    if (type === 'user') {
      state.users++;
      state.first ||= promptHead(stringField(text, 'content'));
    } else if (type === 'turn_start' || type === 'turn_end') Object.assign(state, { open: type === 'turn_start', pending: 0 });
    else if (type === 'pending_interaction') {
      state.pending++;
      state.question = previewText(stringField(text, 'question'));
    } else if (type === 'interaction_resolved') state.pending = Math.max(0, state.pending - 1);
  });
  return state;
}

function isSubagent(st) {
  if (st.reason === 'tangent' || (st.reason === 'human' && st.parentId)) return false;
  return !!st.parentId || st.reason === 'subagent' || st.reason === 'rewind' || ((!st.reason || st.reason === 'human') && SUBAGENT_TITLE.test(st.title));
}

function view(rec, index) {
  const st = rec.state;
  const where = parse(rec.file);
  if (where.parent) return { project: '', preview: 'Sub-agent', parent: where.parent, visible: true };
  // The dashboard hides prompt-less sessions and subagent sessions without a parent.
  if (!st.users || (isSubagent(st) && !st.parentId) || !st.cwd) return null;
  const name = renamed(rec.id);
  return { project: index.cwdProject(st.cwd), preview: name ? titleText(name) : PLACEHOLDERS.has(st.title) ? st.first || '(no title)' : st.title,
    agentCount: 0 };
}

let bootMs;
// Process start in ms since the epoch, null when the process is gone (Windows: only liveness).
function startedMs(pid) {
  const start = procStart(pid);
  if (process.platform === 'darwin') return start && Date.parse(start);
  if (process.platform === 'linux') {
    bootMs ??= Number(/btime (\d+)/.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]) * 1000;
    return start && bootMs + Number(start) * 10;
  }
  try { process.kill(pid, 0); return 0; } catch { return null; }
}

// A lease is held while its pid runs; a pid reused since started after the lease was taken.
export function readLease(file) {
  try {
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'));
    const started = startedMs(lease.pid);
    lease.live = started != null && !(started > Date.parse(lease.acquiredAt) + 1000) && (!lease.hostId || lease.hostId === os.hostname());
    return lease;
  } catch { return null; }
}

const leases = () => new Map(ls(LEASES).filter((name) => name.endsWith('.lease')).map((name) => [name.slice(0, -6), readLease(path.join(LEASES, name))]));

// A dead holder never answers, so what it left open is completed. Sub-agents run inside the parent's turn.
function status(rec, held, now) {
  const where = parse(rec.file);
  if (!rec.state || !held?.get(where.parent || rec.id)?.live) return 'completed';
  if (where.parent) return now - rec.ms < 15_000 ? 'running' : 'completed';
  return rec.state.pending ? 'needs_input' : rec.state.open ? 'running' : 'completed';
}

// ---------- history: one line → at most one row, ordered by line (timestamps are not monotonic) ----------
export function mapTool(name, a = {}) {
  switch (name) {
    case 'execute_bash': case 'execute_pwsh':
      return ['Bash', { command: a.command || '', description: a.description || '', run_in_background: a.run_in_background || undefined }];
    case 'read_file': case 'read_files': return ['Read', { file_path: a.path || a.paths?.[0] || '', offset: a.offset, limit: a.limit }];
    case 'fs_write': return ['Write', { file_path: a.path || '', content: a.text ?? '' }];
    case 'str_replace': return ['Edit', { file_path: a.path || '', old_string: a.oldStr ?? '', new_string: a.newStr ?? '', replace_all: a.replace_all || undefined }];
    case 'grep_search': return ['Grep', { pattern: a.query || a.pattern || '', path: a.path }];
    case 'file_search': case 'glob': case 'list_directory': return ['Glob', { pattern: a.query || a.pattern || '*', path: a.path }];
    case 'invoke_sub_agent': return ['Agent', { description: a.explanation || a.agentName || '', subagent_type: a.agentName || '', prompt: a.prompt || '' }];
    case 'web_search': return ['WebSearch', { query: a.query || '' }];
    case 'web_fetch': return ['WebFetch', { url: a.url || '', prompt: a.prompt || '' }];
  }
  const mcp = /^@?([^/]+)\/(.+)$/.exec(name || '');
  return [mcp ? `mcp__${mcp[1]}__${mcp[2]}` : name, a];
}

const newContext = () => ({ subStarts: new Map(), tags: new Map(), errors: new Set() });

function note({ timestamp, payload: p }, ctx) {
  if (p.type === 'sub_agent_start') ctx.subStarts.set(p.subSessionId, timestamp);
  else if (p.type === 'turn_start' && p.userMessageTag) ctx.tags.set(p.executionId, p.userMessageTag);
  else if (p.type === 'session_metadata' && p.key === 'displayError') ctx.errors.add(p.executionId);
}

const text = (t) => [{ type: 'text', text: t }];
const toolUse = (id, [name, input]) => [{ type: 'tool_use', id, name, input }];

// Baton row of one v3 entry. The turn id Baton sent (userMessageTag, steer-<id>) becomes the nativeId.
function kiroRow({ id, timestamp, payload: p }, ctx) {
  const base = { uuid: id, timestamp };
  const say = (content, extra) => ({ ...base, type: 'assistant', content, ...extra });
  const event = (content) => ({ ...base, type: 'system_event', content });
  switch (p.type) {
    case 'user': {
      // Steering injections and boundary markers are Kiro's own; the steer row itself shows.
      if (p._meta?.kiro?.syntheticUserMessageReason || (!p.content && !p.images?.length)) return null;
      const tag = p._meta?.kiro?.userMessageTag || (id.startsWith('steer-') ? id.slice(6) : '');
      return { ...base, type: 'user', ...(tag ? { nativeId: `live:user:${tag}` } : {}), content: [
        ...(p.content ? text(String(p.content)) : []),
        ...(p.images || []).map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mimeType, data: i.data } })),
      ] };
    }
    case 'assistant':
      if (p.operationType === 'Reasoning') return p.content && p.content.trim() !== '...' ? say([{ type: 'thinking', thinking: p.content }]) : null;
      if (p.operationType === 'Summary') return { ...base, type: 'summary', content: text(String(p.content ?? '')) };
      // The model acknowledges a steer as [STEERING steer-<id>: …]; the TUI strips it too.
      return p.content ? say(text(String(p.content).replace(/\[STEERING (?:steer|notify)-[^\s:\]]+: [^\]]*\]\s*/g, ''))) : null;
    case 'tool_call': return say(toolUse(p.toolCallId, mapTool(p.toolName, p.args)));
    case 'tool_result':
      return { ...base, type: 'user', content: [{ type: 'tool_result', tool_use_id: p.toolCallId,
        content: typeof p.content === 'string' ? p.content : JSON.stringify(p.content ?? ''), is_error: p.success === false }] };
    case 'sub_agent_start':
      return say(toolUse(p.subSessionId, ['Agent', { description: p.explanation || p.subAgentName || '', subagent_type: p.subAgentName || '', prompt: p.prompt || '' }]));
    case 'sub_agent_complete': {
      const started = Date.parse(ctx.subStarts.get(p.subSessionId));
      return { ...base, type: 'user', content: [{ type: 'tool_result', tool_use_id: p.subSessionId, content: String(p.response ?? p.errorMessage ?? ''),
        is_error: !!p.status && !['success', 'completed'].includes(p.status) }], ...(started ? { toolUseResult: { totalDurationMs: Math.max(0, Date.parse(timestamp) - started) } } : {}) };
    }
    case 'session_metadata':
      return p.key === 'displayError' ? say(text(`Error: ${p.value?.message || 'the turn failed'}${p.value?.errorType ? ` (${p.value.errorType})` : ''}`), { stopReason: 'error' }) : null;
    case 'turn_end': {
      const tag = ctx.tags.get(p.executionId);
      if (p.stopReason === 'cancelled') return { ...base, type: 'user', ...(tag ? { nativeId: `live:interrupt:${tag}` } : {}), content: text('[Request interrupted by user]') };
      if (p.stopReason === 'error') return ctx.errors.has(p.executionId) ? null : say(text('The turn ended with an error.'), { stopReason: 'error' });
      return p.stopReason && p.stopReason !== 'end_turn' ? event(`Turn ended: ${p.stopReason}`) : null;
    }
    default: return null;
  }
}

export class KiroReader {
  constructor(file) {
    this.ctx = newContext();
    this.index = new LineIndex(file, {
      onLine: (buf, s, e) => {
        if (!NOTED.has(HEAD.exec(buf.latin1Slice(s, Math.min(e, s + 200)))?.[1])) return;
        try { note(JSON.parse(buf.utf8Slice(s, e)), this.ctx); } catch {}
      },
      onReset: () => { this.ctx = newContext(); },
    });
  }

  update() { return this.index.update(); }
  get epoch() { return this.index.epoch; }
  stableLine() { return Infinity; }
  page(range) { return readPage(this, range, 64, 64); }

  // extract.mjs (sharp, transfers) loads on the first page only, never in the index worker.
  async rows(lo, hi) {
    const { extractForApp, nativeOrderKey } = await import('./extract.mjs');
    if (hi <= lo) return [];
    const { starts, ends } = this.index;
    const buf = this.index.read(lo, hi);
    const out = [];
    for (let line = lo; line < hi; line++) {
      const s = starts[line] - starts[lo];
      const e = ends[line] - starts[lo];
      if (UNSHOWN.has(HEAD.exec(buf.latin1Slice(s, Math.min(e, s + 200)))?.[1])) continue;
      let row;
      try { row = JSON.parse(buf.utf8Slice(s, e)); } catch { continue; }
      row = kiroRow(row, this.ctx);
      if (!row) continue;
      const msg = await extractForApp({ ...row, message: { content: row.content, stop_reason: row.stopReason } });
      out.push({ ...msg, orderKey: nativeOrderKey(line), ...(row.nativeId ? { nativeId: row.nativeId } : {}) });
    }
    return out;
  }
}

// Tool-details index input: every row of the file, images left as they are.
function messages(file) {
  const ctx = newContext();
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    let entry;
    try { entry = JSON.parse(line); } catch { return []; }
    note(entry, ctx);
    return kiroRow(entry, ctx) || [];
  });
}

export default {
  runtime: 'kiro',
  module: import.meta.url,
  catalog: { kind: 'file', files, match: parse, newState, advance, summarize: (file, id) => advance(file, id, newState()), view, status, running: leases },
  history: (target) => new KiroReader(target.file),
  messages,
};
