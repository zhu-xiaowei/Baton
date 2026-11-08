import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getSessionMetadata } from '../../bridge/session.mjs';
import { scanCodexRollout } from '../../bridge/codex-session.mjs';
import { advance, claudePreview, codexView, newState, summarize, titlesBefore } from '../../bridge/session-summary.mjs';

const ID = '00000000-0000-4000-8000-000000000001';
const PARENT = '00000000-0000-4000-8000-000000000009';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const write = (file, rows, eol = '\n') => fs.writeFileSync(file, rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(eol) + eol);

const claudeMessage = (type, content, extra = {}) => ({ parentUuid: null, isSidechain: false, cwd: '/repo', sessionId: ID,
  type, message: type === 'assistant' ? { model: extra.model || 'm1', role: 'assistant', content } : { role: 'user', content }, ...extra });

function claudeRows() {
  const long = 'x'.repeat(1_500_000);
  return [
    { type: 'mode', mode: 'normal', sessionId: ID },
    claudeMessage('user', [{ type: 'text', text: '<command-name>/review</command-name><command-args>pr 1</command-args>' }]),
    claudeMessage('assistant', [{ type: 'text', text: long }], { model: 'model-a' }),
    { type: 'last-prompt', lastPrompt: 'a later prompt '.repeat(40), sessionId: ID },
    claudeMessage('user', 'second prompt'),
    { type: 'ai-title', aiTitle: 'AI   title', sessionId: ID },
    claudeMessage('assistant', 'ok', { model: 'model-b' }),
    '{"type":"summary","summary":"broken',
    claudeMessage('assistant', 'ok', { model: 'model-b' }),
  ];
}

const claudeSummary = (file) => {
  const state = advance(file, 'claude', ID, newState('claude'));
  return { preview: claudePreview(state, ''), model: state.model };
};
const claudeReference = (file) => {
  const meta = getSessionMetadata(file, { firstPrompt: '' });
  return { preview: meta.preview, model: meta.model };
};

test('Claude summary equals getSessionMetadata, including long lines, CRLF and malformed lines', (t) => {
  const dir = tmp(t);
  for (const [name, eol] of [['lf.jsonl', '\n'], ['crlf.jsonl', '\r\n']]) {
    const file = path.join(dir, name);
    write(file, claudeRows(), eol);
    assert.deepEqual(claudeSummary(file), claudeReference(file));
    assert.equal(claudeSummary(file).preview, 'AI title');
    assert.equal(claudeSummary(file).model, 'model-b');
  }
  const titled = path.join(dir, 'titled.jsonl');
  write(titled, [...claudeRows(), { type: 'custom-title', customTitle: '   ', sessionId: ID }]);
  assert.deepEqual(claudeSummary(titled), claudeReference(titled), 'a blank custom title still wins, as in v1');
  const first = path.join(dir, 'first.jsonl');
  write(first, [claudeMessage('user', 'only a prompt'), { type: 'last-prompt', lastPrompt: 'later', sessionId: ID }]);
  assert.deepEqual(claudeSummary(first), claudeReference(first));
  const state = advance(first, 'claude', ID, newState('claude'));
  assert.equal(claudePreview(state, 'from history'), getSessionMetadata(first, { firstPrompt: 'from history' }).preview);
});

const codexLine = (n, type, payload) => ({ timestamp: `2026-11-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, ordinal: n, type, payload });

function codexRows({ legacyEvents = false, fork = false, openTurn = false } = {}) {
  let n = 0;
  const rows = [];
  if (fork) rows.push(codexLine(n++, 'session_meta', { session_id: PARENT, id: ID, cwd: '/repo/fork', forked_from_id: PARENT, source: 'cli' }));
  rows.push(codexLine(n++, 'session_meta', { session_id: PARENT, id: fork ? PARENT : ID, cwd: '/repo', source: 'cli', base_instructions: { text: 'b'.repeat(30_000) } }));
  rows.push(codexLine(n++, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] }));
  rows.push(codexLine(n++, 'turn_context', { turn_id: 't1', cwd: '/repo', model: 'gpt-a' }));
  rows.push(codexLine(n++, 'event_msg', { type: 'task_started', turn_id: 't1' }));
  rows.push(codexLine(n++, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first   question' }] }));
  // Older Codex mirrored each prompt as an event right after the response item.
  if (legacyEvents) rows.push(codexLine(n++, 'event_msg', { type: 'user_message', message: 'first question' }));
  rows.push(codexLine(n++, 'response_item', { type: 'function_call_output', call_id: 'c', output: 'o'.repeat(2_000_000) }));
  rows.push(codexLine(n++, 'event_msg', { type: 'item_completed', turn_id: 't1', item: { type: 'AgentMessage', text: 'z'.repeat(5000) } }));
  rows.push(codexLine(n++, 'event_msg', { type: 'task_complete', turn_id: 't1' }));
  rows.push(codexLine(n++, 'turn_context', { turn_id: 't2', cwd: '/repo', model: 'gpt-b' }));
  rows.push(codexLine(n++, 'event_msg', { type: 'task_started', turn_id: 't2' }));
  rows.push(codexLine(n++, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second question' }] }));
  rows.push(codexLine(n++, 'event_msg', { type: 'item_completed', turn_id: 't2', item: { type: 'ExitedReviewMode' } }));
  rows.push(codexLine(n++, 'turn_context', { turn_id: 't2', cwd: '/repo' }));
  if (!openTurn) rows.push(codexLine(n++, 'event_msg', { type: 'task_complete', turn_id: 't2' }));
  return rows;
}

function codexSummary(file) {
  const state = advance(file, 'codex', ID, newState('codex'));
  const view = codexView(state, '');
  return { valid: !!view, cwd: view?.cwd, preview: view?.preview, model: state.model, running: !!state.active };
}
function codexReference(file) {
  const session = scanCodexRollout(file, { nativeSessionId: ID, runtimeOwned: true }).session;
  return { valid: !!session, cwd: session?.cwd, preview: session?.preview, model: session?.model, running: session?.status === 'running' };
}

test('Codex summary equals scanCodexRollout for current, legacy, forked and open-turn rollouts', (t) => {
  const dir = tmp(t);
  for (const options of [{}, { legacyEvents: true }, { fork: true }, { openTurn: true }]) {
    const file = path.join(dir, `rollout-${ID}.jsonl`);
    write(file, codexRows(options));
    const mine = codexSummary(file);
    const reference = codexReference(file);
    // A fork is a child thread: lists only count it, so its own preview is not kept.
    if (options.fork) { delete mine.preview; delete reference.preview; }
    assert.deepEqual(mine, reference, JSON.stringify(options));
  }
  const file = path.join(dir, `rollout-${ID}.jsonl`);
  write(file, codexRows({ openTurn: true }));
  assert.deepEqual(codexSummary(file), { valid: true, cwd: '/repo', preview: 'first question', model: 'gpt-b', running: true },
    'the last turn_context without a model keeps the previous model');
});

test('head + tail: Codex equals a full read, Claude finds a re-stamped title, appends continue', (t) => {
  const dir = tmp(t);
  const codexFile = path.join(dir, `rollout-${ID}.jsonl`);
  write(codexFile, codexRows({ legacyEvents: true, openTurn: true }));
  const codexFull = advance(codexFile, 'codex', ID, newState('codex'));
  const codexTail = summarize(codexFile, 'codex', ID);
  assert.ok(codexTail.offset === codexFull.offset);
  assert.deepEqual([codexView(codexTail, ''), codexTail.model, codexTail.active], [codexView(codexFull, ''), codexFull.model, codexFull.active]);
  // A later turn's prompt event never replaces the first prompt.
  fs.appendFileSync(codexFile, [codexLine(90, 'event_msg', { type: 'task_started', turn_id: 't3' }),
    codexLine(91, 'event_msg', { type: 'user_message', message: 'later prompt' })].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(codexView(advance(codexFile, 'codex', ID, codexTail), '').preview, 'first question');

  // A title only in the middle is outside the tail until CC re-stamps it.
  const pad = (model) => claudeMessage('assistant', 'p'.repeat(700_000), { model });
  const claudeFile = path.join(dir, 'c.jsonl');
  const rows = [claudeMessage('user', 'first'), pad('m1'), { type: 'custom-title', customTitle: 'Renamed', sessionId: ID }, pad('m2'), pad('m3'), pad('m4')];
  write(claudeFile, rows);
  const running = summarize(claudeFile, 'claude', ID);
  assert.equal(claudePreview(running, ''), 'first');
  while (titlesBefore(claudeFile, running));
  assert.equal(claudePreview(running, ''), 'Renamed', 'a running session reads back to its latest title');
  const full = advance(claudeFile, 'claude', ID, newState('claude'));
  assert.deepEqual([claudePreview(full, ''), full.model], ['Renamed', 'm4']);
  write(claudeFile, [...rows, { type: 'custom-title', customTitle: 'Renamed', sessionId: ID }]);
  const restamped = summarize(claudeFile, 'claude', ID);
  assert.deepEqual([claudePreview(restamped, ''), restamped.model], ['Renamed', 'm4']);

  // Appending the second half later, with a partial last line in between.
  for (const [runtime, file] of [['claude', claudeFile], ['codex', codexFile]]) {
    const whole = advance(file, runtime, ID, newState(runtime));
    const text = fs.readFileSync(file, 'utf8');
    const cut = text.indexOf('\n', Math.floor(text.length / 2)) + 1;
    fs.writeFileSync(file, text.slice(0, cut + 10));
    const state = advance(file, runtime, ID, newState(runtime));
    fs.writeFileSync(file, text);
    assert.deepEqual({ ...advance(file, runtime, ID, state), partial: undefined }, { ...whole, partial: undefined }, `${runtime} append`);
  }
});
