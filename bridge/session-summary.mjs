// List summaries of Claude and Codex JSONL files without parsing every line.
// Each line is classified from its first bytes; only lines that can change the result are
// parsed, and a line whose class is uncertain is parsed in full. The result equals
// getSessionMetadata / scanCodexRollout field for field (the middle of a file is skipped, see
// summarize). States are plain objects that resume from a byte offset, so appends cost only the
// new bytes.
import fs from 'fs';
import { extractFirstPromptFromMsg, previewText } from './session.mjs';
import { codexResponseUserText, previewText as codexPreviewText } from './codex-session.mjs';
import { runtimeDescriptor } from './session-identity.mjs';

const CHUNK = 1 << 20;
const HEAD_CHUNK = 1 << 16;
const BLOCK = 1 << 16;
const CLAUDE_TAIL = 1 << 20;
const CLAUDE_PREFIX = 1024;
const CODEX_PREFIX = 256;
// A value that was set but previews to nothing still wins over later fallbacks, as in v1.
const BLANK = '\u0000';
const STOP = Symbol('stop');
const buf = Buffer.allocUnsafe(CHUNK);

function readRange(fd, offset, length) {
  const b = Buffer.allocUnsafe(length);
  fs.readSync(fd, b, 0, length, offset);
  return b;
}

// Calls onLine for every complete line from `from`; returns the offset after the last line read.
// Lines longer than a chunk are never accumulated: only their prefix is kept and text() re-reads them.
function eachLine(file, from, onLine, prefixBytes, chunk) {
  const fd = fs.openSync(file, 'r');
  const line = {
    prefix: '', offset: 0, length: 0, start: -1,
    bytes() { return this.start >= 0 ? buf.subarray(this.start, this.start + this.length) : readRange(fd, this.offset, this.length); },
    text() { return this.bytes().toString('utf8'); },
  };
  let position = from;
  let lineStart = from;
  let carry = null;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunk, position);
      if (n <= 0) return lineStart;
      const base = position;
      position += n;
      const view = buf.subarray(0, n);
      let start = 0;
      let nl;
      while (start < n && (nl = view.indexOf(10, start)) !== -1) {
        const length = base + nl - lineStart;
        if (length > 0) {
          const inView = lineStart >= base;
          line.offset = lineStart;
          line.length = length;
          line.start = inView ? lineStart - base : -1;
          line.prefix = inView
            ? view.latin1Slice(line.start, Math.min(nl, line.start + prefixBytes))
            : Buffer.concat([carry, view.subarray(0, Math.max(0, Math.min(nl, prefixBytes - carry.length)))]).latin1Slice();
          if (onLine(line) === STOP) return base + nl + 1;
        }
        carry = null;
        start = nl + 1;
        lineStart = base + start;
      }
      if (start < n) {
        const piece = view.subarray(start, Math.min(n, start + prefixBytes));
        if (!carry) carry = Buffer.from(piece);
        else if (carry.length < prefixBytes) carry = Buffer.concat([carry, view.subarray(0, prefixBytes - carry.length)]);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function parse(line) {
  try { return JSON.parse(line.text()); } catch { return null; }
}

// ---------- Claude: the fold of getSessionMetadata ----------
const CLAUDE_TYPE = /^\{"type":"([a-z-]+)"/;
const CLAUDE_FOLDED = new Set(['custom-title', 'ai-title', 'summary', 'last-prompt', 'user', 'assistant']);

function claudeState() {
  return { offset: 0, ct: '', at: '', su: '', lp: '', first: '', model: '' };
}

const stored = (value) => previewText(value) || BLANK;

function advanceClaude(file, state, head) {
  const known = () => state.first || state.ct || state.at || state.su || state.lp;
  if (head && known()) return state;
  const apply = (msg) => {
    if (!msg) return;
    if (msg.type === 'custom-title' && msg.customTitle) state.ct = stored(msg.customTitle);
    if (msg.type === 'ai-title' && msg.aiTitle) state.at = stored(msg.aiTitle);
    if (msg.type === 'summary' && msg.summary) state.su = stored(msg.summary);
    if (msg.type === 'last-prompt' && msg.lastPrompt) state.lp = stored(msg.lastPrompt);
    if (!state.first) state.first = extractFirstPromptFromMsg(msg) || '';
    if (msg.type === 'assistant' && msg.message?.model) state.model = msg.message.model;
  };
  let stopped = false;
  state.offset = eachLine(file, state.offset, (line) => {
    const prefix = line.prefix;
    const type = CLAUDE_TYPE.exec(prefix)?.[1];
    if (type) {
      // A leading type outside these never reaches the fold.
      if (CLAUDE_FOLDED.has(type)) apply(parse(line));
    } else {
      const at = prefix.indexOf('"message":{');
      const inner = at === -1 ? '' : prefix.slice(at + 11);
      if (state.first && inner.startsWith('"model":"')) {
        // An assistant message: with the first prompt known, only its model can matter.
        const model = /^"model":"([^"\\]*)"/.exec(inner)?.[1];
        if (model === undefined || model !== state.model) apply(parse(line));
      } else if (!(state.first && inner.startsWith('"role":"user"'))) {
        apply(parse(line));
      }
    }
    if (head && known()) { stopped = true; return STOP; }
  }, CLAUDE_PREFIX, head ? HEAD_CHUNK : CHUNK);
  state.partial = stopped;
  return state;
}

export function claudePreview(state, historyPrompt) {
  const pick = (value) => (value === BLANK ? '' : value);
  if (state.ct) return pick(state.ct);
  if (state.at) return pick(state.at);
  if (state.su) return pick(state.su);
  const indexed = previewText(historyPrompt);
  if (indexed) return previewText(indexed);
  if (state.first) return previewText(state.first);
  return pick(state.lp);
}

// ---------- Codex: the fold of scanCodexRollout ----------
const CODEX_LINE = /^\{"timestamp":"[^"]*",(?:"ordinal":\d+,)?"type":"([a-z_]+)","payload":\{(?:"type":"([A-Za-z_]+)"(?:,"role":"([a-z]+)")?)?/;

function codexState() {
  return { offset: 0, metaCount: 0, meta: null, matching: null, active: '', reviewExit: '', events: [], responses: [], model: '' };
}

function slimMeta(payload) {
  const parent = String(payload.parent_thread_id || payload.forked_from_id || '');
  const structured = payload.source && typeof payload.source === 'object' ? payload.source.subagent : undefined;
  const spawn = structured?.thread_spawn || {};
  return {
    cwd: payload.cwd ? String(payload.cwd) : '',
    repositoryUrl: payload.git?.repository_url || '',
    parent,
    visible: !!parent && (structured === undefined || !!structured?.thread_spawn),
    agentPath: String(payload.agent_path || spawn.agent_path || ''),
  };
}

function advanceCodex(file, state, nativeSessionId, mode) {
  const head = mode === 'head';
  const tail = mode === 'tail';
  // The first prompt, as an event or a response item, is the title; once known nothing later
  // replaces it (a later turn's event must not become the first one after a skipped middle).
  const collecting = () => !tail && !state.events.length && !state.responses.length;
  const apply = (entry) => {
    if (!entry) return;
    const payload = entry.payload || {};
    if (entry.type === 'session_meta') {
      state.metaCount++;
      state.meta = slimMeta(payload);
      if (String(payload.id || payload.session_id || '') === nativeSessionId) state.matching = state.meta;
    }
    // A root shows the first prompt; a child thread only needs to have one.
    if (entry.type === 'response_item' && collecting()) {
      const text = codexPreviewText(codexResponseUserText(payload));
      if (text && !state.responses.includes(text)) state.responses.push(text);
    }
    if (entry.type !== 'event_msg') return;
    if (payload.type === 'user_message' && collecting()) {
      const text = codexPreviewText(payload.message);
      if (text && !state.events.includes(text)) state.events.push(text);
    }
    if (payload.type === 'task_started' && payload.turn_id) {
      state.active = payload.turn_id;
      state.reviewExit = '';
    }
    if (payload.type === 'item_completed' && payload.item?.type === 'ExitedReviewMode') state.reviewExit = payload.turn_id || '';
    if ((payload.type === 'task_complete' || payload.type === 'turn_aborted')
      && (payload.turn_id === state.active
        || (payload.type === 'task_complete' && state.reviewExit && payload.turn_id === state.reviewExit))) {
      state.active = '';
    }
  };
  const contexts = [];
  let stopped = false;
  state.offset = eachLine(file, state.offset, (line) => {
    const m = CODEX_LINE.exec(line.prefix);
    if (!m) apply(parse(line));
    else {
      const [, type, ptype, role] = m;
      if (type === 'session_meta') apply(parse(line));
      else if (type === 'turn_context') contexts.push(line.offset, line.length); // only the last with a model counts
      else if (type === 'response_item') {
        // Only a user message can change the result.
        if (collecting() && (!ptype || (ptype === 'message' && (!role || role === 'user')))) apply(parse(line));
      } else if (type === 'event_msg') {
        if (!ptype || ptype === 'task_started' || ptype === 'task_complete' || ptype === 'turn_aborted') apply(parse(line));
        else if (ptype === 'user_message') { if (collecting()) apply(parse(line)); }
        else if (ptype === 'item_completed') { if (line.bytes().indexOf('ExitedReviewMode') !== -1) apply(parse(line)); }
      }
    }
    if (head && state.matching && !collecting()) { stopped = true; return STOP; }
  }, CODEX_PREFIX, head ? HEAD_CHUNK : CHUNK);
  if (contexts.length) {
    const fd = fs.openSync(file, 'r');
    try {
      for (let i = contexts.length - 2; i >= 0; i -= 2) {
        let entry = null;
        try { entry = JSON.parse(readRange(fd, contexts[i], contexts[i + 1]).toString('utf8')); } catch {}
        if (entry?.payload?.model) { state.model = String(entry.payload.model); break; }
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  state.partial = stopped;
  return state;
}

export function codexView(state, threadName) {
  const meta = state.matching || (state.metaCount === 1 ? state.meta : null);
  if (!meta?.cwd) return null;
  // scanCodexRollout's prompts[0]; child threads are only counted, so any prompt makes them valid.
  const prompt = state.events[0] || state.responses[0] || '';
  const name = codexPreviewText(threadName);
  const pathTitle = codexPreviewText(meta.agentPath.split('/').filter(Boolean).pop()?.replace(/[_-]+/g, ' ') || '');
  const preview = name || (meta.visible ? (prompt || pathTitle) : prompt);
  return preview ? { cwd: meta.cwd, repositoryUrl: meta.repositoryUrl, parent: meta.parent, visible: meta.visible, preview } : null;
}

// ---------- tails ----------
// The turn state starts at the last task_started; the model is the last turn_context that has one.
const TAIL_TYPES = [
  ['"type":"task_started"', 'event_msg', 'task_started', null],
  ['"type":"turn_context"', 'turn_context', '', (entry) => !!entry?.payload?.model],
];

function lineStartBefore(fd, at, floor, block) {
  while (at > floor) {
    const start = Math.max(floor, at - BLOCK);
    const n = fs.readSync(fd, block, 0, at - start, start);
    const i = block.subarray(0, n).lastIndexOf(10);
    if (i !== -1) return start + i + 1;
    at = start;
  }
  return floor;
}

function readLine(fd, start, size, block) {
  const parts = [];
  for (let at = start; at < size;) {
    const n = fs.readSync(fd, block, 0, Math.min(BLOCK, size - at), at);
    const i = block.subarray(0, n).indexOf(10);
    parts.push(Buffer.from(block.subarray(0, i === -1 ? n : i)));
    if (i !== -1) break;
    at += n;
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { return null; }
}

// Start of the last top-level line of the given type at or after floor, or -1.
function lastLine(fd, size, floor, [token, type, ptype, check], block, probe) {
  let end = size;
  while (end > floor) {
    const start = Math.max(floor, end - BLOCK);
    const n = fs.readSync(fd, block, 0, Math.min(size, end + token.length) - start, start);
    const view = block.subarray(0, n);
    for (let i = view.lastIndexOf(token); i !== -1; i = i > 0 ? view.lastIndexOf(token, i - 1) : -1) {
      if (start + i >= end) continue;
      const lineStart = lineStartBefore(fd, start + i, floor, probe);
      const m = CODEX_LINE.exec(readRange(fd, lineStart, Math.min(CODEX_PREFIX, size - lineStart)).latin1Slice());
      if (!m || m[1] !== type || (ptype && m[2] !== ptype)) continue;
      if (!check || check(readLine(fd, lineStart, size, probe))) return lineStart;
    }
    end = start;
  }
  return -1;
}

function tailStart(file, runtime, size, floor) {
  if (size <= floor) return floor;
  const fd = fs.openSync(file, 'r');
  const block = Buffer.allocUnsafe(BLOCK + 64);
  const probe = Buffer.allocUnsafe(BLOCK);
  try {
    if (runtime === 'claude') return size - floor <= CLAUDE_TAIL ? floor : lineStartBefore(fd, size - CLAUDE_TAIL, floor, probe);
    const starts = TAIL_TYPES.map((spec) => lastLine(fd, size, floor, spec, block, probe));
    return starts.includes(-1) ? floor : Math.min(...starts);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- entry points ----------
// A registered runtime's file catalog summarizes its own files.
const fileSource = (runtime) => runtimeDescriptor(runtime)?.catalog;

export function newState(runtime) {
  if (fileSource(runtime)) return fileSource(runtime).newState();
  return runtime === 'claude' ? claudeState() : codexState();
}

// mode: 'full' reads to the end; 'head' stops once the leading fields are known.
export function advance(file, runtime, id, state, mode = 'full') {
  if (fileSource(runtime)) return fileSource(runtime).advance(file, id, state, mode);
  return runtime === 'claude' ? advanceClaude(file, state, mode === 'head') : advanceCodex(file, state, id, mode);
}

// The leading fields plus the tail: Codex from its last task_started / turn_context, which decide
// the model and turn state; Claude's last 1 MB, where CC re-stamps session titles.
export function summarize(file, runtime, id) {
  if (fileSource(runtime)) return fileSource(runtime).summarize(file, id);
  const state = advance(file, runtime, id, newState(runtime), 'head');
  if (!state.partial) return state;
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  const from = tailStart(file, runtime, size, state.offset);
  const skipped = from > state.offset;
  const floor = state.offset;
  state.offset = from;
  if (!skipped || runtime !== 'claude') return advance(file, runtime, id, state, skipped ? 'tail' : 'full');
  // A running Claude session may hold a newer title than the head's in the skipped range: keep
  // which titles the tail did not set, so titlesBefore can fill them from the middle.
  const head = { ct: state.ct, at: state.at, su: state.su };
  Object.assign(state, { ct: '', at: '', su: '' });
  advance(file, runtime, id, state, 'tail');
  const open = Object.keys(head).filter((key) => !state[key]);
  for (const key of open) state[key] = head[key];
  state.skipped = [floor, from, open];
  return state;
}

// Reads the skipped range backwards, one block per call, filling the titles the tail did not
// have (later lines win, so the first one met is the latest). Returns false when done.
export function titlesBefore(file, state) {
  const [floor, end, open = []] = state.skipped || [];
  if (!(end > floor) || !open.includes('ct')) { delete state.skipped; return false; }
  const fd = fs.openSync(file, 'r');
  try {
    let start = Math.max(floor, end - CHUNK);
    let block = readRange(fd, start, end - start);
    if (start > floor) {
      // The last byte ends the line before `end`; without another newline that line is longer
      // than a block, so it is no title: continue before it.
      const nl = block.subarray(0, block.length - 1).indexOf(10);
      if (nl === -1) {
        state.skipped = [floor, lineStartBefore(fd, end - 1, floor, Buffer.allocUnsafe(BLOCK)), open];
        return state.skipped[1] > floor;
      }
      block = block.subarray(nl + 1);
      start += nl + 1;
    }
    for (let stop = block.length; stop > 0;) {
      const nl = block.lastIndexOf(10, stop - 1);
      const from = nl + 1;
      const type = CLAUDE_TYPE.exec(block.latin1Slice(from, Math.min(stop, from + 40)))?.[1];
      if (type === 'custom-title' || type === 'ai-title' || type === 'summary') {
        let msg = null;
        try { msg = JSON.parse(block.toString('utf8', from, stop)); } catch {}
        const [key, value] = { 'custom-title': ['ct', msg?.customTitle], 'ai-title': ['at', msg?.aiTitle], summary: ['su', msg?.summary] }[type];
        if (value && open.includes(key)) { state[key] = stored(value); open.splice(open.indexOf(key), 1); }
      }
      stop = Math.max(0, nl);
    }
    state.skipped = [floor, start, open];
    return start > floor && open.includes('ct');
  } finally {
    fs.closeSync(fd);
  }
}
