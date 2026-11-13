// Pi sessions: catalog, history and row mapping. Workers load it too: no main-thread-only imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { previewText } from './session.mjs';
import { LineIndex } from './history-line-index.mjs';
import { readPage } from './history-page.mjs';
import { procStart } from './turn-process.mjs';
import { BRIDGE_HOME } from './config.mjs';

export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
export const PI_SESSIONS = path.join(PI_AGENT_DIR, 'sessions');
export const PI_STATUS_DIR = path.join(BRIDGE_HOME, 'pi-status');
const HEAD = /^\{"type":"([a-z_]+)"(?:,"id":"([^"]+)")?(?:,"parentId":(?:"([^"]+)"|null))?/;
const USER_HEAD = /"message":\{"role":"user"/;
const INTERRUPT = '[Request interrupted by user]';
// extract.mjs's nativeOrderKey (that module loads sharp).
const nativeOrderKey = (line, f = 0) => `O2#${String(line).padStart(12, '0')}#${String(f).padStart(4, '0')}`;
const STOP = { stop: 'end_turn', toolUse: 'tool_use', length: 'max_tokens' };
// Pi's session list shows control characters as spaces.
const piText = (value) => previewText(String(value || '').replace(/[\x00-\x1f\x7f]/g, ' '));
const text = (content) => (typeof content === 'string' ? content
  : (content || []).filter((b) => b?.type === 'text').map((b) => b.text).join(' '));

const opt = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== '' && v !== false));
// Pi tool → Baton tool; one edit call with several edits is several Edit uses (like Codex apply_patch).
function tools(name, a = {}) {
  a = a && typeof a === 'object' ? a : {};
  const one = (n, input) => [{ name: n, input }];
  switch (name) {
    case 'bash': case 'powershell': return one('Bash', { command: a.command ?? '', ...opt({ timeout: a.timeout, shell: name === 'powershell' && name }) });
    case 'read': return one('Read', { file_path: a.path ?? '', ...opt({ offset: a.offset, limit: a.limit }) });
    case 'write': return one('Write', { file_path: a.path ?? '', content: a.content ?? '' });
    case 'edit': return (Array.isArray(a.edits) ? a.edits : [a]).map((e) => ({ name: 'Edit',
      input: { file_path: a.path ?? '', old_string: e?.oldText ?? '', new_string: e?.newText ?? '' } }));
    case 'grep': return one('Grep', { pattern: a.pattern ?? '', ...opt({ path: a.path, glob: a.glob }) });
    case 'find': return one('Glob', { pattern: a.pattern ?? '', ...opt({ path: a.path }) });
    case 'ls': return one('Glob', { pattern: '*', path: a.path || '.' });
    case 'tool_search': return one('ToolSearch', a);
    case 'ask_user': case 'ask_text': return one('AskUserQuestion', { questions: [{ question: a.question ?? '',
      options: (a.options || []).map((label) => ({ label: String(label) })), ...opt({ multiSelect: !!a.multiple }) }] });
    default: return one(String(name || 'Tool'), a);
  }
}
export { tools as piTools };
const useIds = (id, n) => (n === 1 ? [id] : Array.from({ length: n }, (_, i) => `${id}#${i}`));
const image = (b) => ({ type: 'image', source: { type: 'base64', media_type: b.mimeType, data: b.data } });

// Rows for one entry; live and stored rows share uuid = nativeId; Baton's prompts carry batonTurnId.
// `edits`: toolCallId → Edit uses; `line`: history order (live: none).
export function piRows(entry, edits = new Map(), line = null) {
  const ts = entry.timestamp || '';
  const key = (f = 0) => (line === null ? undefined : nativeOrderKey(line, f));
  const plain = (type, content) => [{ uuid: entry.id, type, content, timestamp: ts, orderKey: key() }];
  if (entry.type === 'compaction') return plain('summary', entry.summary || '');
  if (entry.type === 'branch_summary') return plain('summary', `Branch summary\n\n${entry.summary || ''}`);
  if (entry.type === 'custom_message') return entry.display === false ? [] : plain('user', text(entry.content));
  const m = entry.type === 'message' && entry.message;
  if (!m) return [];
  const timestamp = ts || new Date(m.timestamp || 0).toISOString();
  const nativeId = m.role === 'toolResult' ? `pi:tool:${m.toolCallId}`
    : m.batonTurnId ? `live:user:${m.batonTurnId}` : `pi:${m.role}:${m.timestamp}`;
  const row = (type, content, f = 0, extra) => ({ uuid: f ? `${nativeId}:${f}` : nativeId, nativeId: f ? `${nativeId}:${f}` : nativeId,
    type, content, timestamp, orderKey: key(f), ...extra });
  if (m.role === 'user') {
    return [row('user', typeof m.content === 'string' ? [{ type: 'text', text: m.content }]
      : (m.content || []).map((b) => (b?.type === 'image' ? image(b) : { type: 'text', text: b?.text ?? '' })))];
  }
  if (m.role === 'assistant') {
    const content = [];
    for (const b of m.content || []) {
      if (b?.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
      else if (b?.type === 'thinking' && (b.thinking || b.redacted)) content.push({ type: 'thinking', thinking: b.redacted ? '[redacted thinking]' : b.thinking });
      else if (b?.type === 'toolCall') {
        const uses = tools(b.name, b.arguments);
        edits.set(b.id, uses.length);
        useIds(b.id, uses.length).forEach((id, i) => content.push({ type: 'tool_use', id, ...uses[i] }));
      }
    }
    const rows = content.length ? [row('assistant', content, 0, { stopReason: STOP[m.stopReason] || m.stopReason })] : [];
    if (m.stopReason === 'aborted') rows.push(row('user', [{ type: 'text', text: INTERRUPT }], 1));
    if (m.stopReason === 'error') rows.push(row('system_event', `Error: ${m.errorMessage || 'request failed'}`, 2));
    if (m.stopReason === 'length') rows.push(row('system_event', 'Response stopped at the output token limit', 2));
    return rows;
  }
  if (m.role === 'toolResult') {
    const out = (m.content || []).filter((b) => typeof b?.text === 'string').map((b) => b.text).join('\n');
    return [row('user', useIds(m.toolCallId, edits.get(m.toolCallId) || 1)
      .map((id) => ({ type: 'tool_result', tool_use_id: id, content: out, is_error: !!m.isError })))];
  }
  if (m.role === 'bashExecution') {
    const id = `pi_bash_${entry.id || m.timestamp}`;
    return [row('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command: m.command ?? '', userInitiated: true } }], 0, { stopReason: 'tool_use' }),
      row('user', [{ type: 'tool_result', tool_use_id: id, content: `${m.output ?? ''}${m.truncated ? '\n[output truncated]' : ''}`,
        is_error: !!m.cancelled || (m.exitCode != null && m.exitCode !== 0) }], 1)];
  }
  return [];
}

export async function withImages(row) {
  if (!Array.isArray(row.content) || !row.content.some((b) => b.type === 'image')) return row;
  const { extractForApp } = await import('./extract.mjs');
  return { ...row, content: (await extractForApp({ uuid: row.uuid, type: row.type, message: { content: row.content } })).content };
}

function scanLine(state, buf, s, e) {
  const head = buf.latin1Slice(s, Math.min(e, s + 256));
  const [, type, id] = HEAD.exec(head) || [];
  if (id) state.leaf = id; // the parent of an entry the Bridge appends
  const wanted = type === 'session' || type === 'session_info' || type === 'model_change'
    || (type === 'message' && !state.first && USER_HEAD.test(head));
  if (!wanted) return;
  let x;
  try { x = JSON.parse(buf.utf8Slice(s, e)); } catch { return; }
  if (type === 'session') state.cwd = String(x.cwd || '');
  else if (type === 'session_info') state.name = String(x.name || '').trim();
  else if (type === 'model_change') state.model = String(x.modelId || '');
  else state.first = piText(text(x.message?.content));
}

// Complete lines from state.offset, a MB at a time (a longer line grows the buffer).
function advance(file, id, state) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let buf = Buffer.allocUnsafe(1 << 20);
    while (state.offset < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - state.offset), state.offset);
      let s = 0;
      for (let e = buf.indexOf(10); e !== -1 && e < n; e = buf.indexOf(10, s)) { scanLine(state, buf, s, e); s = e + 1; }
      if (s) state.offset += s;
      else if (n < buf.length) break;
      else buf = Buffer.allocUnsafe(buf.length * 2);
    }
  } finally { fs.closeSync(fd); }
  return state;
}

const newState = () => ({ offset: 0, cwd: '', name: '', first: '', model: '', leaf: null });

// sessionId → status records of live pi processes (pi-status-ext).
function statusRecords() {
  const byId = new Map();
  let names = [];
  try { names = fs.readdirSync(PI_STATUS_DIR).filter((n) => n.endsWith('.json')); } catch {}
  for (const name of names) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(PI_STATUS_DIR, name), 'utf8')); } catch { continue; }
    const start = procStart(rec.pid);
    if (start === null || (rec.procStart != null && String(rec.procStart) !== String(start))) { // kill -9 left it
      try { fs.unlinkSync(path.join(PI_STATUS_DIR, name)); } catch {}
      continue;
    }
    byId.set(rec.sessionId, [...(byId.get(rec.sessionId) || []), rec]);
  }
  return byId;
}

export const piCatalog = {
  kind: 'file',
  files() {
    const out = [];
    const walk = (dir, depth) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
      for (const d of entries) {
        if (d.isFile() && d.name.endsWith('.jsonl')) out.push(path.join(dir, d.name));
        else if (d.isDirectory() && depth) walk(path.join(dir, d.name), depth - 1);
      }
    };
    walk(PI_SESSIONS, 1);
    return out;
  },
  match(file) {
    if (!file.startsWith(PI_SESSIONS + path.sep) || !file.endsWith('.jsonl')) return null;
    const name = path.basename(file, '.jsonl');
    return name.includes('_') ? { id: name.slice(name.indexOf('_') + 1) } : null;
  },
  newState,
  advance,
  summarize: (file, id) => advance(file, id, newState()),
  // Project from the header's cwd: Pi's folder names are not Claude's hashes.
  view(rec, index) {
    const st = rec.state;
    const preview = piText(st.name) || st.first || previewText(index.sentPrompts?.get(rec.id));
    return st.cwd && preview ? { project: index.cwdProject(st.cwd), preview, agentCount: 0 } : null;
  },
  running: statusRecords,
  status(rec, byId) {
    const states = (byId?.get(rec.id) || []).map((r) => r.state);
    return states.includes('waiting') ? 'needs_input' : states.includes('running') ? 'running' : 'completed';
  },
};

// History: the current branch.
class PiHistory {
  constructor(file) {
    this.edits = new Map();
    this.clear();
    this.index = new LineIndex(file, {
      onLine: (buf, s, e, line) => {
        const m = HEAD.exec(buf.latin1Slice(s, Math.min(e, s + 160)));
        this.ids[line] = m?.[2] || '';
        this.parents[line] = m?.[3] || '';
        if (m?.[1] === 'session_info') this.nameLine = line;
        // A page may hold the result of an edit call on a line it does not read.
        if (m?.[1] === 'message' && buf.subarray(s, e).includes('"name":"edit"')) {
          try { piRows(JSON.parse(buf.utf8Slice(s, e)), this.edits); } catch {}
        }
        this.dirty = true;
      },
      onReset: () => this.clear(),
      onDrop: (line) => { this.ids.length = this.parents.length = line; this.dirty = true; },
    });
  }

  clear() { this.ids = []; this.parents = []; this.nameLine = -1; this.dirty = true; }

  update() {
    const changed = this.index.update();
    if (this.dirty) this.branch();
    return changed;
  }

  // An entry not continuing the previous one moved the branch: new epoch.
  branch() {
    this.dirty = false;
    const lineOf = new Map();
    let leaf = '';
    this.forks = 0;
    this.ids.forEach((id, line) => {
      if (!id) return;
      if (this.parents[line] !== leaf && (leaf || this.parents[line])) this.forks++;
      leaf = id;
      lineOf.set(id, line);
    });
    this.on = new Set();
    for (let line = lineOf.get(leaf); line !== undefined && !this.on.has(line); line = lineOf.get(this.parents[line])) this.on.add(line);
  }

  get epoch() { return `${this.index.epoch}.${this.forks}`; }

  stableLine() { return Infinity; }

  async rows(lo, hi) {
    hi = Math.min(hi, this.index.count);
    if (hi <= lo) return [];
    const buf = this.index.read(lo, hi);
    const base = this.index.starts[lo];
    const out = [];
    for (let line = lo; line < hi; line++) {
      if (!this.on.has(line)) continue;
      let entry;
      try { entry = JSON.parse(buf.utf8Slice(this.index.starts[line] - base, this.index.ends[line] - base)); } catch { continue; }
      for (const row of piRows(entry, this.edits, line)) out.push(await withImages(row));
    }
    return out;
  }

  async titles() {
    if (this.nameLine < 0) return [];
    let name = '';
    try { name = String(JSON.parse(this.index.read(this.nameLine, this.nameLine + 1).toString('utf8')).name || '').trim(); } catch {}
    return name ? [{ uuid: `custom-title_${this.nameLine}`, type: 'custom-title', content: name,
      timestamp: '1970-01-01T00:00:00.000Z', orderKey: nativeOrderKey(this.nameLine) }] : [];
  }

  page(range) { return readPage(this, range, 64, 64); }
}

// Every entry, for tool_details (ids are unique across branches).
function messages(file) {
  const edits = new Map();
  return fs.readFileSync(file, 'utf8').split('\n').flatMap((line) => {
    try { return line ? piRows(JSON.parse(line), edits) : []; } catch { return []; }
  });
}

export default { runtime: 'pi', module: import.meta.url, catalog: piCatalog, history: (t) => new PiHistory(t.file), messages };
