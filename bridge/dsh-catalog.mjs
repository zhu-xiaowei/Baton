// DeepSeek Harness catalog and history over <DSH_HOME>/sessions/<cwd>/<id>/session.v4.jsonl.zstd.
// Workers import this module (it is the descriptor's `module`), so it stays free of Bridge state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameIndex, frameEvents, newFrames } from './dsh-frames.mjs';
import { eventRows } from './dsh-extract.mjs';
import { readPage } from './history-page.mjs';
import { lockHolder, lockHolders } from './dsh-locks.mjs';

export const LOG = 'session.v4.jsonl.zstd';
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
export const SESSIONS = path.join(DSH_HOME, 'sessions');

// DSH's session-title fallback (packages/session/session-title normalize.ts): the first user prompt
// without control sequences, its first 5 words, cut to 40 UTF-8 bytes.
const CONTROL = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)|(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[@-_]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;
export function fallbackTitle(text) {
  let out = '';
  for (const ch of String(text).replace(CONTROL, '').replace(/\s+/gu, ' ').trim().split(' ').slice(0, 5).join(' ')) {
    if (Buffer.byteLength(out + ch) > 40) break;
    out += ch;
  }
  return out.trimEnd();
}

function apply(st, e) {
  const d = e.data || {};
  switch (e.type) {
    case 'session': Object.assign(st, { v: e.version, cwd: e.cwd || '', parent: e.origin === 'subagent' ? e.parentSession || '' : '' }); break;
    case 'session/title': st.title = d.title || ''; break;
    case 'model/selection': case 'request/context': st.model = d.model || st.model; break;
    case 'user/message':
      if (!st.first && d.source?.kind === 'user') st.first = fallbackTitle((d.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
      break;
    case 'turn/start': st.turns++; st.open = true; break;
    case 'turn/end': st.open = false; st.asks = []; break;
    case 'approval/asked': st.asks.push(d.id); break;
    case 'approval/decided': st.asks = st.asks.filter((id) => id !== d.id); break;
    case 'tool/call': if (d.name === 'ask_user_question' || d.name === 'exit_plan_mode') st.asks.push(d.callId); break;
    case 'tool/result': st.asks = st.asks.filter((id) => id !== d.message?.toolCallId); break;
    default: break;
  }
}

export const catalog = {
  kind: 'file',
  files() {
    const out = [];
    let projects = [];
    try { projects = fs.readdirSync(SESSIONS); } catch {}
    for (const p of projects) {
      try { for (const id of fs.readdirSync(path.join(SESSIONS, p))) out.push(path.join(SESSIONS, p, id, LOG)); } catch {}
    }
    return out;
  },
  match: (file) => (path.basename(file) === LOG && file.startsWith(SESSIONS + path.sep) ? { id: path.basename(path.dirname(file)) } : null),
  newState: () => ({ offset: 0, frames: 0, v: 0, cwd: '', parent: '', title: '', model: '', first: '', turns: 0, open: false, asks: [] }),
  // Frames cannot be found from the tail, and logs are small, so the warm-up is the full read.
  // Once the watcher runs, decoded events wait in `pending` for it, so it does not decode them again.
  advance(file, id, state) {
    const { frames, buf } = newFrames(file, state.offset);
    const events = frames.flatMap(([s, e], k) => frameEvents(buf.subarray(s - state.offset, e - state.offset)).map((event, i) => ({ frame: state.frames + k, i, event })));
    for (const { event } of events) apply(state, event);
    if (this.pending && events.length) this.pending.set(file, (this.pending.get(file) || []).concat(events));
    state.frames += frames.length;
    state.offset = frames.at(-1)?.[1] ?? state.offset;
    return state;
  },
  summarize(file, id) { return this.advance(file, id, this.newState()); },
  // Like DSH's list: the last title, else its fallback, else the folder name. Never prompted: not listed.
  view(rec, index) {
    const st = rec.state;
    const sent = index.sentPrompts?.get(rec.id);
    if (st.v !== 4 || !st.cwd || (!st.turns && !st.first && !st.title && !sent)) return null;
    return { project: index.cwdProject(st.cwd), preview: st.title || st.first || (sent && fallbackTitle(sent)) || path.basename(st.cwd),
      agentCount: 0, ...(st.parent ? { parent: st.parent, visible: true } : {}) };
  },
  running: () => ({ locks: lockHolders(SESSIONS) }),
  // Only a held lock means a live writer; a crash leaves an open turn behind.
  status(rec, running) {
    const st = rec.state;
    if (!st || !running?.locks.size || !lockHolder(path.join(path.dirname(rec.file), 'session.lock'), running.locks)) return 'completed';
    return st.asks.length ? 'needs_input' : st.open ? 'running' : 'completed';
  },
};

// Every row of the log (tool_details indexes them).
export function messages(file, sid) {
  const index = new FrameIndex(file);
  index.update();
  return rowsOf(index.events(0, index.count), sid, file);
}

const homeOf = (file) => path.resolve(path.dirname(file), '../../..');
const rowsOf = (events, sid, file) => events.flatMap(({ frame, i, event }) => eventRows(event, frame, i, { sid, home: homeOf(file) }));

export class DshHistoryReader extends FrameIndex {
  constructor(file, sid) {
    super(file);
    this.sid = sid;
  }

  get index() { return this; }

  // Rows from the open turn's turn/start on may still change.
  stableLine() {
    if (this.stable?.size === this.size) return this.stable.line;
    let line = Infinity;
    for (let f = this.count - 1; f >= 0; f--) {
      const last = this.events(f, f + 1).findLast(({ event }) => event.type === 'turn/start' || event.type === 'turn/end');
      if (last) { if (last.event.type === 'turn/start') line = f; break; }
    }
    this.stable = { size: this.size, line };
    return line;
  }

  rows(lo, hi) { return rowsOf(this.events(lo, hi), this.sid, this.file); }

  page(range) { return readPage(this, range, 32, 512); }
}

// Image blocks name the attachment file; on the main thread (storage access lives there) its bytes
// go to the transfer store under the block's key, once per Bridge run.
const uploaded = new Set();
export async function withImages(rows) {
  const images = rows.flatMap((row) => (Array.isArray(row.content) ? row.content : []).filter((b) => b.type === 'image' && b.path));
  const { transfer, reusable } = images.length ? await import('./transfer-store.mjs') : {};
  await Promise.all(images.map(async (b) => {
    try {
      if (!uploaded.has(b.key) && !reusable(await transfer.head(b.key))) await transfer.put(b.key, fs.readFileSync(b.path), { contentType: b.mediaType || 'image/png' });
      uploaded.add(b.key);
    } catch { b.placeholder = true; }
    delete b.path;
  }));
  return rows;
}

export default { runtime: 'dsh', catalog, messages, withImages, history: (target) => new DshHistoryReader(target.file, target.nativeSessionId) };
