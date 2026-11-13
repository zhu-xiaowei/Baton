// Hermes (≥ 0.23) Sessions and history, read-only from the default profile's state.db; workers load it too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, RowIndex } from './sqlite-ro.mjs';
import { readPage } from './history-page.mjs';
import { convertRow, decodeContent, flatten } from './hermes-convert.mjs';

export const HERMES_HOME = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes');
export const STATE_DB = path.join(HERMES_HOME, 'state.db');
export const ASSISTANT_PROJECT = 'hermes:assistant';
const HOME = path.resolve(os.homedir());
export const db = await open(STATE_DB);

// Hermes' own pickers hide these; subagents fold under their parent.
const UNLISTED = new Set(['oneshot', 'tool', 'batch', 'kanban', 'a2a', 'curator', 'bot_room']);
const LOCAL = new Set(['local', 'cli', 'tui', 'gui', 'acp', 'desktop']);
const SESSION_COLUMNS = ['id', 'source', 'created_source', 'parent_session_id', 'model', 'started_at', 'ended_at', 'message_count',
  'cwd', 'git_repo_root', 'title', 'last_activity_at', 'hidden', 'archived', 'transcript_revision', 'rewind_count'];

// Columns are read by name; ones this Hermes version lacks are left out.
const columns = new Map();
export function select(table, wanted) {
  if (!columns.has(table)) columns.set(table, new Set(db.all(`SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name)));
  return wanted.filter((c) => columns.get(table).has(c)).join(', ');
}
const marks = (list) => list.map(() => '?').join(',');
const previewOf = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);

// Like Hermes' preview: the first user row that is not hidden.
function firstPrompt(id) {
  for (const { content } of db.all(`SELECT content FROM messages WHERE session_id = ? AND role = 'user' AND content IS NOT NULL
    AND coalesce(display_kind, '') <> 'hidden' ORDER BY timestamp, id LIMIT 5`, [id])) {
    if (previewOf(flatten(decodeContent(content)))) return previewOf(flatten(decodeContent(content)));
  }
  return '';
}

export const catalog = {
  kind: 'rows',
  virtualProjects: { [ASSISTANT_PROJECT]: 'Hermes 助理' },
  onRows: null, // (rows, newMessageIds: Map<sessionId, ids>) — the watcher, on the main thread
  watchPaths: () => [STATE_DB, `${STATE_DB}-wal`],

  // Sessions whose row or messages changed since `cursor`; a full signature pass also finds deletions.
  refresh(cursor) {
    if (!fs.existsSync(STATE_DB)) return { cursor };
    const version = db.dataVersion();
    if (cursor?.version === version) return { cursor };
    // Startup asks twice from no cursor (sync, then the index): one read serves both.
    if (!cursor && this.first?.cursor.version === version) return this.first;
    let maxId = cursor?.maxId ?? 0;
    const added = new Map();
    for (const { session_id: id, id: rowId } of db.all('SELECT session_id, id FROM messages WHERE id > ?', [maxId])) {
      if (!added.has(id)) added.set(id, []);
      added.get(id).push(rowId);
      if (rowId > maxId) maxId = rowId;
    }
    const sigs = new Map();
    const changed = [];
    for (const s of db.all(`SELECT ${select('sessions', SESSION_COLUMNS)} FROM sessions`)) {
      const sig = Object.values(s).join('|');
      sigs.set(s.id, sig);
      if (cursor?.sigs.get(s.id) !== sig || added.has(s.id)) changed.push(s);
    }
    // Newest message and stored bytes per Session: one grouped scan at start, then only the changed Sessions.
    // Like a transcript file's size: text, tool calls and reasoning once (the columns this version has).
    const cols = select('messages', ['content', 'tool_calls', 'reasoning_details', 'reasoning_content', 'reasoning']).split(', ').filter(Boolean);
    const bytes = cols.filter((c) => c !== 'reasoning' || !cols.includes('reasoning_content')).map((c) => `coalesce(length(CAST(${c === 'reasoning_content' && cols.includes('reasoning') ? 'coalesce(reasoning_content, reasoning)' : c} AS BLOB)), 0)`).join(' + ') || '0';
    const lastQuery = `SELECT session_id, max(timestamp) AS ts, sum(${bytes}) AS bytes FROM messages`;
    const last = new Map((cursor ? changed.flatMap((s) => db.all(`${lastQuery} WHERE session_id = ?`, [s.id]))
      : db.all(`${lastQuery} GROUP BY session_id`)).map((r) => [r.session_id, r]));
    const upserts = changed.map((s) => ({
      id: s.id, size: last.get(s.id)?.bytes || 0, model: s.model || '', title: s.title || '', firstPrompt: s.title ? '' : firstPrompt(s.id),
      ms: Math.round(Math.max(Number(last.get(s.id)?.ts) || 0, Number(s.last_activity_at) || 0, Number(s.started_at) || 0) * 1000),
      source: s.source || '', createdSource: s.created_source || '', cwd: s.git_repo_root || s.cwd || '',
      parent: s.parent_session_id || null, hidden: !!s.hidden, archived: !!s.archived, ended: s.ended_at != null,
    }));
    const deletes = cursor ? [...cursor.sigs.keys()].filter((id) => !sigs.has(id)) : [];
    if (cursor) this.onRows?.(upserts, added);
    const result = { upserts, deletes, cursor: { version, maxId, sigs } };
    if (!cursor) this.first = result;
    return result;
  },

  view(rec, index) {
    const s = rec.state;
    if (s.hidden || s.archived || UNLISTED.has(s.source) || UNLISTED.has(s.createdSource)) return null;
    const title = previewOf(s.title || s.firstPrompt || index.sentPrompts.get(rec.id));
    if (!title && !s.size) return null; // a TUI start leaves an empty Session behind
    const local = LOCAL.has(s.source) && s.cwd && path.resolve(s.cwd) !== HOME && fs.existsSync(s.cwd);
    const project = local ? index.cwdProject(s.cwd) : ASSISTANT_PROJECT;
    if (s.source === 'subagent') return { project, preview: title, parent: s.parent, visible: true, agentCount: 0 };
    if (local) return { project, preview: title || 'New session', agentCount: 0 };
    // Messaging and automation Sessions have no workspace: one virtual project, labelled by source.
    const label = { cron: '定时任务', api_server: 'API' }[s.source] || (LOCAL.has(s.source) ? '本机' : s.source[0].toUpperCase() + s.source.slice(1));
    return { project, preview: `${label} · ${title}`, readOnly: !LOCAL.has(s.source), agentCount: 0 };
  },

  // Turns the gateway is running, from its own lease and admission tables (5 s TTL in SessionIndex).
  running() {
    const active = new Set();
    try {
      for (const r of db.all('SELECT conversation_id AS id FROM session_turn_leases WHERE expires_at > ?', [Date.now() / 1000])) active.add(r.id);
      for (const r of db.all("SELECT target_session_id AS id FROM session_admissions WHERE status IN ('queued', 'started')")) active.add(r.id);
    } catch {}
    return active;
  },

  // A background subagent runs until Hermes records its end; the parent's Done waits for it.
  status: (rec, running) => (running?.has(rec.id) || (rec.state.source === 'subagent' && !rec.state.ended) ? 'running' : 'completed'),
};

// Hermes' display projection: active or compaction-archived rows, one per display_order (active copy
// first, compaction-copied tool results dropped). A rewind/compaction/revision rebuilds the index.
export class HermesHistoryReader {
  constructor(sessionId) {
    this.id = sessionId;
    this.index = new RowIndex(`hermes:${sessionId}`, (mark) => this.slots(mark), () => this.total());
  }

  update() { return this.index.update(); }
  get epoch() { return this.index.epoch; }
  stableLine() { return Infinity; } // Hermes writes a turn's rows when it ends

  shape() {
    const m = db.all('SELECT count(*) AS n, sum(active = 0) AS inactive FROM messages WHERE session_id = ?', [this.id])[0];
    const s = db.all(`SELECT ${select('sessions', ['transcript_revision', 'rewind_count']) || 'id'} FROM sessions WHERE id = ?`, [this.id])[0] || {};
    return { n: m.n, key: `${m.inactive}|${s.transcript_revision}|${s.rewind_count}` };
  }

  total() {
    const shape = this.shape();
    const same = shape.key === this.shapeKey && shape.n >= this.shapeCount;
    Object.assign(this, { shapeKey: shape.key, shapeCount: shape.n });
    return same ? this.index.count : -1;
  }

  slots(mark) {
    const after = Number.isFinite(mark) ? mark : 0;
    if (!after) Object.assign(this, { shapeKey: this.shape().key, shapeCount: 0 });
    const rows = db.all(`SELECT id, display_order AS slot, role, active, message_uid AS uid, timestamp FROM messages
      WHERE session_id = ? AND (active = 1 OR compacted = 1) AND id >= ? ORDER BY coalesce(display_order, id), active DESC, id DESC`, [this.id, after]);
    const archived = new Map(rows.filter((r) => r.role === 'tool' && !r.active && r.uid).map((r) => [`${r.uid}|${r.timestamp}`, r.slot]));
    const out = [];
    let last = null;
    for (const r of rows) {
      const slot = r.slot ?? r.id;
      if (slot === last) continue;
      last = slot;
      const original = r.role === 'tool' && r.active ? archived.get(`${r.uid}|${r.timestamp}`) : undefined;
      if (original === undefined || original >= slot) out.push({ id: r.id, mark: r.id });
    }
    return out;
  }

  // Baton rows of index positions [lo, hi) (images still as paths).
  convert(lo, hi) {
    const ids = this.index.read(lo, hi);
    if (!ids.length) return [];
    const byId = new Map(db.all(`SELECT * FROM messages WHERE id IN (${marks(ids)})`, ids).map((r) => [r.id, r]));
    const delegations = new Map();
    if ([...byId.values()].some((r) => r.display_kind === 'async_delegation_complete')) {
      for (const r of db.all("SELECT tool_call_id, content FROM messages WHERE session_id = ? AND tool_name = 'delegate_task'", [this.id])) {
        const id = /"delegation_id":\s*"(deleg_[0-9a-f]+)"/.exec(r.content || '')?.[1];
        if (id) delegations.set(id, r.tool_call_id);
      }
    }
    return ids.flatMap((id, i) => (byId.has(id) ? convertRow(byId.get(id), delegations).map((row, fragment) => ({ row, n: lo + i, fragment })) : []));
  }

  async rows(lo, hi) {
    const { nativeOrderKey } = await import('./extract.mjs');
    return this.convert(lo, hi).map(({ row, n, fragment }) => ({ ...row, orderKey: nativeOrderKey(n, fragment) }));
  }

  page(range) { return readPage(this, range, 64, 256); }
}

// A cached image Hermes kept on disk; once it is gone only the description remains.
function loadImage(block) {
  if (!block.path) return block;
  if (/^https?:/.test(block.path)) return { type: 'text', text: block.path };
  try {
    if (fs.statSync(block.path).size <= 20 << 20) return { type: 'image', source: { type: 'base64', data: fs.readFileSync(block.path).toString('base64') } };
  } catch {}
  return { type: 'text', text: `[Image unavailable] ${block.alt || path.basename(block.path)}` };
}

// On the main thread, which can reach the transfer store: image paths become uploaded keys
// (extractForApp remembers each upload for a day; storage keeps them 7).
export async function withImages(rows) {
  const { extractForApp } = await import('./extract.mjs');
  for (const row of rows) {
    if (Array.isArray(row.content) && row.content.some((b) => b.path)) row.content = (await extractForApp({ message: { content: row.content.map(loadImage) } })).content;
  }
  return rows;
}

export function readSessionMessages(sessionId) {
  const reader = new HermesHistoryReader(sessionId);
  reader.update();
  return reader.convert(0, reader.index.count).map(({ row }) => row);
}

// What the workers load: catalog, history pages and tool details.
export default {
  runtime: 'hermes',
  module: import.meta.url,
  catalog,
  withImages,
  history: ({ nativeSessionId }) => new HermesHistoryReader(nativeSessionId),
  messages: (_file, nativeSessionId) => readSessionMessages(nativeSessionId),
};
