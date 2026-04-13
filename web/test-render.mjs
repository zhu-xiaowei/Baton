#!/usr/bin/env node
/**
 * Test: verify WS real-time rendering matches the expected turn structure from jsonl.
 *
 * Input:  jsonl file path or sessionId
 * Output: expected vs actual turn-by-turn comparison
 *
 * Usage:
 *   node web/test-render.mjs <jsonl-path|sessionId>
 *   node web/test-render.mjs <path> --from "请回答A"
 *   node web/test-render.mjs <path> --optimistic "请回答A,请回答B"
 *   node web/test-render.mjs <path> --batch 2
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let source = null, optimisticTexts = [], batchSize = 1, fromText = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--optimistic') { optimisticTexts = args[++i].split(','); continue; }
  if (args[i] === '--batch') { batchSize = parseInt(args[++i], 10); continue; }
  if (args[i] === '--from') { fromText = args[++i]; continue; }
  source = args[i];
}
if (!source) { console.error('Usage: node web/test-render.mjs <jsonl|sessionId> [--from T] [--optimistic A,B] [--batch N]'); process.exit(1); }

// ── Load jsonl ──────────────────────────────────────────────────────────────

const VALID_TYPES = new Set(['user', 'assistant', 'summary', 'ai-title']);

function extract(obj) {
  const t = obj.type;
  if (!VALID_TYPES.has(t)) return null;
  if (obj.isMeta && t === 'user') return null;
  let content = obj.message?.content ?? '';
  if (Array.isArray(content)) {
    content = content.map(b => {
      if (b.type === 'text') return { type: 'text', text: b.text || '' };
      if (b.type === 'thinking') return { type: 'thinking', thinking: (b.thinking || '').slice(0, 80), duration_ms: b.duration_ms || 0 };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: {} };
      if (b.type === 'tool_result') return b;
      return b;
    });
  }
  return {
    uuid: obj.uuid || '', parentUuid: obj.parentUuid || '',
    type: t, content, timestamp: obj.timestamp || '',
    stopReason: obj.message?.stop_reason || '',
  };
}

let jsonlPath = source;
if (!fs.existsSync(source)) {
  const base = path.join(os.homedir(), '.claude', 'projects');
  for (const dir of fs.readdirSync(base)) {
    const p = path.join(base, dir, `${source}.jsonl`);
    if (fs.existsSync(p)) { jsonlPath = p; break; }
  }
}
let messages = fs.readFileSync(jsonlPath, 'utf-8').split('\n')
  .filter(l => l.trim()).map(l => { try { return extract(JSON.parse(l)); } catch { return null; } }).filter(Boolean);
console.log(`Loaded ${messages.length} messages from ${path.basename(jsonlPath)}`);
if (fromText) {
  const idx = messages.findIndex(m => getText(m).includes(fromText));
  if (idx >= 0) { messages = messages.slice(idx); console.log(`  --from "${fromText}": ${messages.length} remaining`); }
}
console.log();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getText(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  return '';
}

function getBlockTypes(m) {
  if (!Array.isArray(m.content)) return getText(m) ? ['text'] : [];
  return m.content.map(b => b.type).filter(t => t !== 'tool_result');
}

function isToolResultOnly(m) {
  if (m.type !== 'user' || !Array.isArray(m.content)) return false;
  return m.content.length > 0 && m.content.every(b => b.type === 'tool_result');
}

function isInterruptMsg(m) {
  if (m.type !== 'user' || !Array.isArray(m.content)) return false;
  if (m.content.length !== 1 || m.content[0].type !== 'text') return false;
  return ['', 'no', 'stop', "don't do that"].includes((m.content[0].text || '').toLowerCase().trim());
}

// ── Build expected turns from jsonl ─────────────────────────────────────────
// A "turn" = one user message + all assistant messages until the next visible user message

function buildExpectedTurns(msgs) {
  const turns = [];
  let currentUser = null;
  let currentAssistantBlocks = [];

  function flush() {
    if (currentUser || currentAssistantBlocks.length) {
      turns.push({
        user: currentUser,
        assistantBlocks: currentAssistantBlocks,
      });
      currentUser = null;
      currentAssistantBlocks = [];
    }
  }

  for (const m of msgs) {
    if (isToolResultOnly(m)) continue; // skipped in rendering
    if (m.type === 'ai-title') continue;

    if (m.type === 'user' && !isInterruptMsg(m)) {
      flush();
      currentUser = { uuid: m.uuid, text: getText(m).trim().slice(0, 50) };
    } else if (m.type === 'assistant') {
      const blocks = getBlockTypes(m);
      currentAssistantBlocks.push(...blocks);
    }
  }
  flush();
  return turns;
}

// ── Minimal DOM ─────────────────────────────────────────────────────────────

class Node {
  constructor(type, attrs = {}) {
    this.type = type; this.attrs = { ...attrs }; this.children = []; this.text = ''; this._parent = null;
  }
  get dataset() { const s = this; return new Proxy({}, { get(_, k) { return s.attrs[`data-${k}`]; }, set(_, k, v) { s.attrs[`data-${k}`] = v; return true; } }); }
  get classList() { const s = this; return { contains(c) { return s.type === c; } }; }
  get nextElementSibling() { if (!this._parent) return null; const i = this._parent.children.indexOf(this); return i < this._parent.children.length - 1 ? this._parent.children[i + 1] : null; }
  get previousElementSibling() { if (!this._parent) return null; const i = this._parent.children.indexOf(this); return i > 0 ? this._parent.children[i - 1] : null; }
}

class Container {
  constructor() { this.children = []; }
  get lastElementChild() { return this.children.at(-1) || null; }
  querySelector(sel) {
    const m = sel.match(/^\[data-uuid="(.+)"\]$/);
    if (m) return this._find(n => n.attrs['data-uuid'] === m[1]);
    if (sel === '.assistant-turn:last-child') { const l = this.lastElementChild; return l?.type === 'assistant-turn' ? l : null; }
    if (sel.startsWith('[id=')) { const id = sel.match(/"(.+)"/)?.[1]; return this._find(n => n.attrs.id === id); }
    return null;
  }
  _find(pred) { for (const c of this.children) { if (pred(c)) return c; for (const cc of c.children) if (pred(cc)) return cc; } return null; }
  append(n) { n._parent = this; this.children.push(n); }
  insertAt(n, i) { n._parent = this; this.children.splice(i, 0, n); }
  insertAfter(ref, n) { this.insertAt(n, this.children.indexOf(ref) + 1); }
  insertBefore(ref, n) { this.insertAt(n, this.children.indexOf(ref)); }
}

// ── Viewer state + core logic (matches ws.js) ───────────────────────────────

const wsAllMessages = [];
let wsRenderedCount = 0;
const pendingSent = [];
const dom = new Container();

function findInsertBefore(ts) {
  for (let i = dom.children.length - 1; i >= 0; i--) {
    const nts = dom.children[i].attrs['data-ts'];
    if (nts && nts > ts) return dom.children[i];
    else if (nts && nts <= ts) break;
  }
  return null;
}

function tryDedup(msg) {
  const text = getText(msg).trim();
  for (let i = 0; i < pendingSent.length; i++) {
    if (pendingSent[i].text === text) {
      const node = dom._find(n => n.attrs.id === pendingSent[i].id);
      if (node) { if (msg.timestamp) node.attrs['data-ts'] = msg.timestamp; if (msg.uuid) node.attrs['data-uuid'] = msg.uuid; }
      pendingSent.splice(i, 1);
      return true;
    }
  }
  return false;
}

function optimisticSend(text) {
  const id = 'sent-' + Date.now() + '-' + (Math.random() * 1e6 | 0);
  pendingSent.push({ id, text });
  const n = new Node('msg-user', { class: 'msg-user', id });
  n.text = text;
  dom.append(n);
}

function processNewMessages() {
  const batch = wsAllMessages.slice(wsRenderedCount);
  wsRenderedCount = wsAllMessages.length;
  if (batch.length > 1) batch.sort((a, b) => (a.timestamp || '') < (b.timestamp || '') ? -1 : 1);

  for (const msg of batch) {
    if (isToolResultOnly(msg)) continue;

    if (msg.type === 'user' && !isInterruptMsg(msg)) {
      if (tryDedup(msg)) continue;
      const n = new Node('msg-user', { ...(msg.uuid ? { 'data-uuid': msg.uuid } : {}), ...(msg.timestamp ? { 'data-ts': msg.timestamp } : {}) });
      n.text = getText(msg).trim().slice(0, 50);
      const before = findInsertBefore(msg.timestamp);
      if (before) dom.insertBefore(before, n); else dom.append(n);
      continue;
    }

    if (msg.type === 'ai-title') continue;
    if (msg.type !== 'assistant' && !isInterruptMsg(msg)) continue;

    // Collect block types for this assistant message
    const blockTypes = getBlockTypes(msg);
    if (!blockTypes.length) continue;

    const blockLabel = blockTypes.join('+');

    // ── Insert logic (parentUuid → fallback timestamp) ──
    const parentEl = msg.parentUuid ? dom.querySelector(`[data-uuid="${msg.parentUuid}"]`) : null;

    if (parentEl) {
      const nextSib = parentEl.nextElementSibling;
      if (nextSib?.type === 'assistant-turn' && nextSib.attrs['data-parent'] === msg.parentUuid) {
        const item = new Node('tl-item'); item.text = blockLabel; item._parent = nextSib; nextSib.children.push(item);
      } else {
        const turn = new Node('assistant-turn', { 'data-parent': msg.parentUuid });
        const item = new Node('tl-item'); item.text = blockLabel; item._parent = turn; turn.children.push(item);
        dom.insertAfter(parentEl, turn);
      }
    } else {
      // Fallback: timestamp
      const before = findInsertBefore(msg.timestamp);
      let lastTurn = null;
      if (before) {
        const prev = before.previousElementSibling;
        lastTurn = prev?.type === 'assistant-turn' ? prev : null;
      } else {
        const last = dom.lastElementChild;
        lastTurn = last?.type === 'assistant-turn' ? last : null;
      }
      if (lastTurn) {
        const item = new Node('tl-item'); item.text = blockLabel; item._parent = lastTurn; lastTurn.children.push(item);
      } else {
        const turn = new Node('assistant-turn');
        const item = new Node('tl-item'); item.text = blockLabel; item._parent = turn; turn.children.push(item);
        if (before) dom.insertBefore(before, turn); else dom.append(turn);
      }
    }
  }
}

// ── Build actual turns from DOM ─────────────────────────────────────────────

function buildActualTurns() {
  const turns = [];
  let lastUser = null;
  let lastAssistantBlocks = [];

  function flush() {
    if (lastUser || lastAssistantBlocks.length) {
      turns.push({ user: lastUser, assistantBlocks: lastAssistantBlocks });
      lastUser = null; lastAssistantBlocks = [];
    }
  }

  for (const node of dom.children) {
    if (node.type === 'msg-user') {
      flush();
      lastUser = { uuid: node.attrs['data-uuid'] || node.attrs.id || '', text: node.text };
    } else if (node.type === 'assistant-turn') {
      for (const item of node.children) {
        lastAssistantBlocks.push(...item.text.split('+'));
      }
    }
  }
  flush();
  return turns;
}

// ── Run ─────────────────────────────────────────────────────────────────────

if (optimisticTexts.length) {
  console.log(`Optimistic sends: [${optimisticTexts.join(', ')}]\n`);
  for (const t of optimisticTexts) optimisticSend(t);
}

for (let i = 0; i < messages.length; i += batchSize) {
  for (const m of messages.slice(i, i + batchSize)) wsAllMessages.push(m);
  processNewMessages();
}

// ── Compare turns ───────────────────────────────────────────────────────────

const expected = buildExpectedTurns(messages);
const actual = buildActualTurns();
const maxLen = Math.max(expected.length, actual.length);
let errors = 0;

for (let i = 0; i < maxLen; i++) {
  const e = expected[i];
  const a = actual[i];
  const turnIssues = [];

  const eUser = e?.user?.text?.slice(0, 40) || '';
  const aUser = a?.user?.text?.slice(0, 40) || '';
  const eBlocks = e?.assistantBlocks || [];
  const aBlocks = a?.assistantBlocks || [];

  if (!e && a) { turnIssues.push('extra turn in DOM'); }
  else if (e && !a) { turnIssues.push('missing turn in DOM'); }
  else {
    if (e.user?.text !== a.user?.text) turnIssues.push(`user text mismatch`);
  }

  // Compare blocks in order
  const blockMax = Math.max(eBlocks.length, aBlocks.length);
  const blockIssues = [];
  for (let j = 0; j < blockMax; j++) {
    if (j >= eBlocks.length) blockIssues.push({ idx: j, issue: `extra: ${aBlocks[j]}` });
    else if (j >= aBlocks.length) blockIssues.push({ idx: j, issue: `missing: ${eBlocks[j]}` });
    else if (eBlocks[j] !== aBlocks[j]) blockIssues.push({ idx: j, issue: `${eBlocks[j]} → ${aBlocks[j]}` });
  }

  const hasIssues = turnIssues.length > 0 || blockIssues.length > 0;
  if (hasIssues) errors++;
  const icon = hasIssues ? '❌' : '✅';

  // Print turn header
  console.log(`${icon} Turn ${i + 1}: 👤 ${eUser || '(none)'}`);

  if (turnIssues.length) {
    for (const issue of turnIssues) console.log(`     ⚠  ${issue}`);
  }

  // Print blocks
  if (eBlocks.length || aBlocks.length) {
    for (let j = 0; j < blockMax; j++) {
      const eb = eBlocks[j] || '';
      const ab = aBlocks[j] || '';
      const bi = blockIssues.find(b => b.idx === j);
      if (bi) {
        console.log(`     ${String(j + 1).padStart(3)}. 🤖 expected: ${eb.padEnd(12)} actual: ${ab.padEnd(12)} ← ${bi.issue}`);
      } else {
        console.log(`     ${String(j + 1).padStart(3)}. 🤖 ${ab}`);
      }
    }
  }
}

console.log();
console.log(`Turns: ${expected.length} expected, ${actual.length} actual`);
console.log(`Messages: ${wsAllMessages.length} stored | DOM: ${dom.children.length} nodes | Pending: ${pendingSent.length}`);
console.log();
if (errors === 0) console.log('✅ All turns match!');
else console.log(`❌ ${errors} turn(s) with issues`);
