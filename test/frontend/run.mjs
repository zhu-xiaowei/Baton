// Stream-render regression suite. Replays WS event sequences through the REAL ws.js
// render code (jsdom harness) and asserts DOM order / attribution / no-duplicate /
// no-omission. Run: npm run test:frontend
//
// Each scenario gets a fresh harness (ws.js is a module singleton — one import per proc),
// so scenarios run as separate child processes via the dispatcher at the bottom.
import { makeHarness, resetSession } from './harness.mjs';
import { replay, assertTurns } from './replay.mjs';

// A full turn where headless splits thinking + text into SEPARATE authoritative rows
// (the shape that caused the duplicate bug). block 0 = thinking, block 1 = text.
// Optional sid: this turn's streamId; frames + authoritative rows all carry it (production
// binds a turn's stream + rows to one streamId). Pass to replay() via { sid } too.
const splitTurn = (a, sid) => [
  { start: true, block: 0, kind: 'thinking' },
  { stop: true, block: 0 },
  { authAsst: [{ type: 'thinking', thinking: '' }], streamId: sid },
  { start: true, block: 1, kind: 'text' },
  { delta: true, block: 1, text: a },
  { authAsst: a, streamId: sid },
  { stop: true, block: 1 },
  { end: true },
];
// A plain single-text-block turn.
const plainTurn = (a, sid) => [
  { start: true, block: 0, kind: 'text' },
  { delta: true, block: 0, text: a },
  { authAsst: a, streamId: sid },
  { stop: true, block: 0 },
  { end: true },
];

const SCENARIOS = {
  // New session, first reply, thinking+text split → the reported duplicate bug.
  'new-session-split': async (h) => {
    resetSession(h, { mode: 'new', firstText: 'good g' });
    // send_message_result already resolved the session in real flow; here the optimistic
    // bubble is present and the authoritative user row arrives via watcher.
    await replay(h, [{ authUser: 'good g' }, ...splitTurn('ANSWER-G')]);
    return assertTurns(h, [{ u: 'good g', a: 'ANSWER-G' }]);
  },
  // Existing session, thinking+text split (same bug shape, not new-session-specific).
  'existing-split': async (h) => {
    resetSession(h, { mode: 'existing' });
    await replay(h, [{ authUser: 'Q1' }, ...splitTurn('ANSWER-1')]);
    return assertTurns(h, [{ u: 'Q1', a: 'ANSWER-1' }]);
  },
  // Plain single-block turn (must not regress).
  'plain-turn': async (h) => {
    resetSession(h, { mode: 'existing' });
    await replay(h, [{ authUser: 'Q1' }, ...plainTurn('ANSWER-1')]);
    return assertTurns(h, [{ u: 'Q1', a: 'ANSWER-1' }]);
  },
  // Final persisted messages use a UUID Set, but streaming frames must remain immediate
  // and must never enter that index.
  'uuid-index-does-not-buffer-streaming': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    const frame = (action, extra) => h.hooks.handleWsMessage({
      action,
      sessionId: 'S',
      streamId: 'IDX',
      ...extra,
    });
    frame('stream_block_start', { seq: 0, blockId: 0, kind: 'text' });
    frame('stream_delta', { seq: 1, blockId: 0, chunk: 'A' });
    await h.tick(10);
    const first = h.document.getElementById('stream-turn-IDX');
    const fails = [];
    if (!first || first.textContent !== 'A') fails.push(`first stream frame was not rendered immediately: ${first?.textContent || 'missing'}`);
    if (h.state.wsMessageUuids.size !== 0) fails.push('stream frame entered the persisted UUID index');

    frame('stream_delta', { seq: 2, blockId: 0, chunk: 'B' });
    await h.tick(10);
    const second = h.document.getElementById('stream-turn-IDX');
    if (!second || second.textContent !== 'AB') fails.push(`second stream frame was buffered: ${second?.textContent || 'missing'}`);

    const final = {
      uuid: 'final-idx',
      type: 'assistant',
      content: [{ type: 'text', text: 'AB' }],
      timestamp: '2026-01-01T00:00:03.000Z',
    };
    frame('messages', { messages: [final, final] });
    frame('messages', { messages: [final] });
    if (h.state.wsAllMessages.length !== 1) fails.push(`final UUID dedup kept ${h.state.wsAllMessages.length} rows`);
    if (!h.state.wsMessageUuids.has(final.uuid)) fails.push('final UUID was not indexed');
    return fails;
  },
  // Burst: user sends several before replies arrive. All optimistic bubbles must stay
  // visible (not get wiped and reappear later). Replies stream back serially.
  'burst-bubbles-survive': async (h) => {
    resetSession(h, { mode: 'existing' });
    // 4 optimistic bubbles sent back-to-back (no replies yet).
    await replay(h, [{ u: 'say 1' }, { u: '2' }, { u: '3' }, { u: '4' }]);
    // At this point all 4 bubbles must be on screen.
    const afterBurst = h.dumpDom().filter(n => /msg-user/.test(n.cls)).map(n => n.text);
    // Each send is acked with its own streamId (binds streamAnchors), then that turn's
    // stream frames + authoritative rows all carry it → replies place by identity.
    await replay(h, [
      { ack: 'say 1', streamId: 's1' }, { authUser: 'say 1', streamId: 's1' }, ...plainTurn('R-say1', 's1'),
    ], { sid: 's1' });
    await replay(h, [{ ack: '2', streamId: 's2' }, { authUser: '2', streamId: 's2' }, ...plainTurn('R-2', 's2')], { sid: 's2' });
    await replay(h, [{ ack: '3', streamId: 's3' }, { authUser: '3', streamId: 's3' }, ...plainTurn('R-3', 's3')], { sid: 's3' });
    await replay(h, [{ ack: '4', streamId: 's4' }, { authUser: '4', streamId: 's4' }, ...plainTurn('R-4', 's4')], { sid: 's4' });
    const fails = assertTurns(h, [{ u: 'say 1', a: 'R-say1' }, { u: '2', a: 'R-2' }, { u: '3', a: 'R-3' }, { u: '4', a: 'R-4' }]);
    if (afterBurst.length !== 4) fails.push(`after burst only ${afterBurst.length}/4 bubbles visible: ${JSON.stringify(afterBurst)}`);
    return fails;
  },
  // New session + burst: send 'say 1' (creates session), then burst 2/3/4 before its
  // reply. The new-session .then rebuild fires mid-burst and must NOT wipe 2/3/4.
  'new-session-burst-wipe': async (h) => {
    resetSession(h, { mode: 'new', firstText: 'say 1' });
    // Burst the follow-ups (optimistic bubbles) BEFORE say-1's reply streams.
    await replay(h, [{ u: '2' }, { u: '3' }, { u: '4' }]);
    // say-1's authoritative user row lands (via watcher) → wsAllMessages now has it.
    // Then the new-session .then rebuild fires (REST returned; reply not streaming yet).
    await replay(h, [{ authUser: 'say 1' }, { newSessionThen: 's1' }]);
    const bubbles = h.dumpDom().filter(n => /msg-user/.test(n.cls)).map(n => n.text);
    const fails = [];
    for (const t of ['say 1', '2', '3', '4']) if (!bubbles.includes(t)) fails.push(`bubble "${t}" wiped (visible: ${JSON.stringify(bubbles)})`);
    return fails;
  },
  // Existing-session burst (from real log): send 2,3 → ack both → send 4 → reply-1's
  // assistant arrives. The acked-but-not-yet-echoed bubble "2" must NOT be wiped by the
  // seq-orphan sweep (it did: vanished then reappeared when its watcher user row landed).
  'existing-burst-orphan': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.wsRunning = false;
    await replay(h, [
      { u: '2' }, { u: '3' },
      { ack: '2' }, { ack: '3' },        // both acked; echoes (user rows) still pending
      { u: '4' },
      // reply to "1" arrives (its stream + authoritative assistant row).
      { start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: '1' }, { end: true },
      { inMsg: { uuid: 'a1', type: 'assistant', content: [{ type: 'text', text: '1' }], timestamp: '2026-07-30T02:25:35.614Z' } },
    ]);
    const bubbles = h.dumpDom().filter(n => /msg-user/.test(n.cls)).map(n => n.text);
    const fails = [];
    for (const t of ['2', '3', '4']) if (!bubbles.includes(t)) fails.push(`bubble "${t}" wiped mid-flight (visible: ${JSON.stringify(bubbles)})`);
    return fails;
  },
  // Original orphan case still covered: an UN-acked send swallowed by busy-CC (echo
  // never comes) must still be cleared when a later send is confirmed — else it sticks
  // forever. Bubble "A" never acked; "B" acked (bumps watermark) → "A" is a true orphan.
  'orphan-unacked-cleared': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.wsRunning = false;
    await replay(h, [
      { u: 'A' }, { u: 'B' },
      { ack: 'B' },                       // only B acked; A swallowed (no ack, no echo)
      { start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: 'rb' }, { end: true },
      { inMsg: { uuid: 'ab', type: 'assistant', content: [{ type: 'text', text: 'rb' }], timestamp: '2026-01-01T00:00:09.000Z' } },
    ]);
    const bubbles = h.dumpDom().filter(n => /msg-user/.test(n.cls)).map(n => n.text);
    // A (unacked, orphaned by B's confirmation) should be gone; B stays.
    const fails = [];
    if (bubbles.includes('A')) fails.push(`orphan "A" not cleared (visible: ${JSON.stringify(bubbles)})`);
    if (!bubbles.includes('B')) fails.push(`"B" wrongly cleared`);
    return fails;
  },
  // Historical-duplicate echo: a prior turn already has user "3" in wsAllMessages. Sending
  // a NEW "3" must not be false-matched as already-echoed and wiped (messageEchoed must
  // only scan rows after this send). Reproduces the "send 3 → bubble flashes & vanishes".
  'echo-historical-dup': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.window.state && (h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} });
    // Prior turn: user "3" already in history + rendered.
    await replay(h, [{ authUser: '3' }, { start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: 'r' }, { end: true }, { inMsg: { uuid: 'aold', type: 'assistant', content: [{ type: 'text', text: 'r' }], timestamp: '2026-01-01T00:00:02.000Z' } }]);
    // Now send a NEW "3"; a later turn frame triggers reconcile.
    await replay(h, [{ u: '3' }, { start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: 'x' }, { inMsg: { uuid: 'ax', type: 'assistant', content: [{ type: 'text', text: 'x' }], timestamp: '2026-01-01T00:00:09.000Z' } }]);
    const newBubbles = h.dumpDom().filter(n => /msg-user/.test(n.cls) && n.text.replace('sending...', '').trim() === '3');
    return newBubbles.length >= 2 ? [] : [`new "3" bubble wiped (only ${newBubbles.length} "3" bubbles, want 2: historical + new)`];
  },
  // Opened history session (rendered via renderMessages) + first new message. The reply
  // must land AFTER the new question bubble, not merge into the last HISTORY turn (that
  // pulled the reply up into history + left the question answer-less). Reply arrives while
  // the user bubble is still pending (headless doesn't push the user row; watcher lags).
  'history-then-new-message': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
    // Prior history rendered via the full-render path.
    h.state.wsAllMessages = [
      { uuid: 'h1', type: 'user', content: [{ type: 'text', text: 'old-q' }], timestamp: '2026-01-01T00:00:01.000Z' },
      { uuid: 'h2', type: 'assistant', content: [{ type: 'text', text: 'OLD-A' }], timestamp: '2026-01-01T00:00:02.000Z' },
    ];
    h.state.wsMessageUuids = new Set(h.state.wsAllMessages.map(m => m.uuid));
    const c = h.document.querySelector('.messages');
    c.innerHTML = h.window.renderMessages(h.state.wsAllMessages);
    h.state.wsRenderedCount = h.state.wsAllMessages.length;
    // New send: bubble pending, reply (thinking+text split) arrives before the user row.
    h.window.doSend('new-q', 'new-q', []);
    await h.tick(3);
    await replay(h, [
      { start: true, block: 0, kind: 'thinking' }, { stop: true, block: 0 }, { authAsst: [{ type: 'thinking', thinking: '' }] },
      { start: true, block: 1, kind: 'text' }, { delta: true, block: 1, text: 'NEW-A' }, { authAsst: 'NEW-A' },
      { stop: true, block: 1 }, { end: true },
    ]);
    const fails = [];
    const historyTurns = [...c.querySelectorAll('.assistant-turn')];
    if (historyTurns.some(t => t.textContent.includes('OLD-A') && t.textContent.includes('NEW-A'))) fails.push('NEW-A merged into the OLD-A history turn');
    // Order: OLD-A turn, then new-q bubble, then NEW-A turn.
    const order = [...c.children].map(e => (e.textContent || '').replace('sending...', '').trim().slice(0, 6));
    const iOld = order.findIndex(t => t.includes('OLD-A')), iQ = order.findIndex(t => t.includes('new-q')), iNew = order.findIndex(t => t.includes('NEW-A'));
    if (!(iOld < iQ && iQ < iNew)) fails.push(`wrong order: OLD-A@${iOld} new-q@${iQ} NEW-A@${iNew} (${JSON.stringify(order)})`);
    return fails;
  },
  // EXACT replay of the reported "1 2 3 4 5" burst (screenshot: every reply fell one question
  // down / to the bottom). Faithful to the wire log's ARRIVAL ORDER — the key being that
  // stream_end arrives just BEFORE its authoritative assistant row (end@…077 → asst@…078).
  // That ordering exposed the bug: handleStreamEnd used to delete streamAnchors[streamId], so
  // the row that arrived 1ms later found no anchor and fell to the timestamp fallback (bottom).
  // Each send acked with its own streamId; assistant rows carry it, user echoes do NOT.
  'burst-1-5-real-log': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
    h.state.wsRunning = false;
    await replay(h, [{ u: '1' }, { u: '2' }, { u: '3' }, { u: '4' }, { u: '5' }]);
    const S = ['sA', 'sB', 'sC', 'sD', 'sE'];
    await replay(h, [{ ack: '1', streamId: S[0] }, { ack: '2', streamId: S[1] }, { ack: '3', streamId: S[2] }, { ack: '4', streamId: S[3] }, { ack: '5', streamId: S[4] }]);
    const asstRow = (t) => ({ uuid: 'ar' + t, parentUuid: null, type: 'assistant', content: [{ type: 'text', text: t }], timestamp: '2026-07-31T08:57:3' + t + '.900Z' });
    const userEcho = (t) => ({ uuid: 'ue' + t, parentUuid: null, type: 'user', content: [{ type: 'text', text: t }], timestamp: '2026-07-31T08:57:3' + t + '.930Z' });
    for (let i = 0; i < 5; i++) {
      const t = String(i + 1);
      await replay(h, [
        { start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: t }, { stop: true, block: 0 },
        { end: true },                          // stream_end FIRST (per log) — must NOT drop the anchor
        { inMsg: asstRow(t), streamId: S[i] },  // authoritative row arrives 1ms later, needs the anchor
      ], { sid: S[i] });
      if (i < 4) await replay(h, [{ inMsg: userEcho(String(i + 2)) }]); // echo of NEXT question, no streamId
    }
    return assertTurns(h, [{ u: '1', a: '1' }, { u: '2', a: '2' }, { u: '3', a: '3' }, { u: '4', a: '4' }, { u: '5', a: '5' }]);
  },

  // Multiple sequential turns, mixed split/plain — order + no dup/omission.
  'multi-turn-mixed': async (h) => {
    resetSession(h, { mode: 'existing' });
    await replay(h, [
      { authUser: 'Q1' }, ...splitTurn('AONE'),
      { authUser: 'Q2' }, ...plainTurn('ATWO'),
      { authUser: 'Q3' }, ...splitTurn('ATHREE'),
    ]);
    return assertTurns(h, [{ u: 'Q1', a: 'AONE' }, { u: 'Q2', a: 'ATWO' }, { u: 'Q3', a: 'ATHREE' }]);
  },

  // ── Placement: the live PREVIEW turn must land under the question being answered, not
  // at the list bottom (the "先贴底再跳" bug). Assert the preview's position DURING stream.
  'preview-under-pending': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
    // History: one prior answered turn (its own streamId, already ended).
    await replay(h, [{ authUser: 'old-q' }, ...plainTurn('OLD-A')]);
    // New send stays pending (no echo yet); its reply starts streaming on a FRESH streamId
    // (production gives each turn a unique streamId — never reuses an ended one).
    h.window.doSend('new-q', 'new-q', []);
    await h.tick(3);
    await replay(h, [{ start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: 'NEW' }], { sid: 'S2' });
    const fails = [];
    const preview = h.document.getElementById('stream-turn-S2');
    if (!preview) { fails.push('no preview turn created'); return fails; }
    const prev = preview.previousElementSibling;
    if (!prev || !/\bmsg-user\b/.test(prev.className) || !prev.textContent.includes('new-q'))
      fails.push(`preview not directly under new-q (prev = ${prev ? JSON.stringify(prev.textContent.slice(0,10)) : 'null'})`);
    // And NOT at the container bottom past nothing — it should sit above no later sibling.
    if (preview.nextElementSibling) fails.push(`preview has an unexpected sibling after it: ${JSON.stringify(preview.nextElementSibling.textContent.slice(0,10))}`);
    return fails;
  },

  // Placement under BURST: two optimistic bubbles queued; reply to #1 streams while #2 is
  // still pending. Preview belongs BETWEEN #1 and #2 (under the one being answered), never
  // below #2 at the bottom.
  'preview-between-burst-bubbles': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.wsRunning = false;
    await replay(h, [{ u: 'first' }, { u: 'second' }]);
    // "first" is acked with streamId 'S' → its reply streams on 'S', anchored to "first"'s
    // bubble. "second" stays pending below. The reply must sit UNDER first, not at the bottom.
    await replay(h, [{ ack: 'first', streamId: 'S' }, { start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: 'R1' }]);
    const fails = [];
    const preview = h.document.getElementById('stream-turn-S');
    if (!preview) { fails.push('no preview turn'); return fails; }
    const order = [...h.document.querySelector('.messages').children].map(e => (e.id === 'stream-turn-S') ? '[preview]' : e.textContent.replace('sending...','').trim());
    // Expect: first, [preview], second  (preview after the first pending, before the second)
    const iFirst = order.indexOf('first'), iPrev = order.indexOf('[preview]'), iSecond = order.indexOf('second');
    if (!(iFirst >= 0 && iFirst < iPrev && iPrev < iSecond)) fails.push(`wrong order ${JSON.stringify(order)}`);
    return fails;
  },

  // No jump: the preview and the authoritative row occupy the SAME slot. Capture the
  // preview's index during stream, then after the authoritative row lands, the reply must
  // be at that same index (didn't teleport from bottom).
  'preview-authoritative-same-slot': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
    await replay(h, [{ authUser: 'old-q' }, ...plainTurn('OLD-A')]);
    h.window.doSend('new-q', 'new-q', []);
    await h.tick(3);
    // Stream preview (mid-turn snapshot) on a fresh streamId.
    await replay(h, [{ start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: 'NEW-A' }], { sid: 'S2' });
    const kids1 = [...h.document.querySelector('.messages').children];
    const previewIdx = kids1.findIndex(e => e.id === 'stream-turn-S2');
    // Authoritative row lands with a timestamp LATER than history (real time is monotonic;
    // via inMsg to bypass replay's per-call ts reset), then the turn ends.
    await replay(h, [
      { inMsg: { uuid: 'anew', type: 'assistant', content: [{ type: 'text', text: 'NEW-A' }], timestamp: '2026-01-01T00:00:09.000Z' } },
      { stop: true, block: 0 }, { end: true },
    ], { sid: 'S2' });
    const kids2 = [...h.document.querySelector('.messages').children];
    const answerIdx = kids2.findIndex(e => /assistant-turn/.test(e.className) && e.textContent.includes('NEW-A'));
    const fails = [];
    if (previewIdx !== answerIdx) fails.push(`slot moved: preview@${previewIdx} → answer@${answerIdx}`);
    // No duplicate NEW-A.
    const hits = kids2.filter(e => e.textContent.includes('NEW-A')).length;
    if (hits !== 1) fails.push(`NEW-A appears in ${hits} nodes (want 1)`);
    return fails;
  },

  // Tool preview clamps IN to the final card height (no no-clamp) → authoritative row landing
  // doesn't shrink the block → no page jump. Assert the preview's .tool-value carries `clamp`
  // and its .tool-body-content is NOT no-clamp.
  'tool-preview-clamped': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    await replay(h, [
      { start: true, block: 0, kind: 'tool_use' },
      { input: true, block: 0, input: '{"command":"echo hi"}' },
    ], { sid: 'S' });
    const fails = [];
    const preview = h.document.getElementById('stream-turn-S');
    if (!preview) { fails.push('no preview turn'); return fails; }
    const val = preview.querySelector('.tool-value');
    if (!val) fails.push('no .tool-value in preview');
    else if (!val.classList.contains('clamp')) fails.push('.tool-value missing clamp class');
    const body = preview.querySelector('.tool-body-content');
    if (body && body.classList.contains('no-clamp')) fails.push('.tool-body-content still no-clamp (would not clamp → jump)');
    return fails;
  },

  // Interrupt ordering: at interrupt, the user "[Request interrupted]" row (streamId) arrives
  // BEFORE the authoritative full-text row (same streamId). Both anchor to the same turn; the
  // Interrupted marker must sort AFTER the answer by data-ts, and must survive clearStreamPreviews.
  'interrupt-marker-last': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
    h.document.querySelector('.messages').innerHTML = '<div class="msg-user" id="q1" data-ts="2026-08-03T02:21:53.000Z" data-anchor="q1">给个总结</div>';
    h.state.pendingSentMessages = [{ id: 'q1', seq: 0, text: '给个总结', fullText: '给个总结', images: [], sentAt: Date.now() }];
    h.hooks.handleWsMessage({ action: 'send_message_result', sessionId: 'S', ok: true, clientId: 'q1', streamId: 'X1' });
    // thinking + text stream
    h.hooks.pushStreamFrame('X1', { t: 'start', seq: 0, blockId: 0, kind: 'thinking' });
    h.hooks.pushStreamFrame('X1', { t: 'stop', seq: 1, blockId: 0 });
    h.hooks.pushStreamFrame('X1', { t: 'start', seq: 2, blockId: 1, kind: 'text' });
    h.hooks.pushStreamFrame('X1', { t: 'delta', seq: 3, blockId: 1, chunk: '总结…' });
    await h.tick(40);
    // Interrupt: user "[Request interrupted]" row (ts .331) arrives BEFORE the full-text row (ts .329).
    h.hooks.handleWsMessage({ action: 'messages', sessionId: 'S', streamId: 'X1', messages: [{ uuid: 'int1', parentUuid: null, type: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }], timestamp: '2026-08-03T02:22:10.331Z' }] });
    h.hooks.handleWsMessage({ action: 'messages', sessionId: 'S', streamId: 'X1', messages: [{ uuid: 'a1', parentUuid: null, type: 'assistant', content: [{ type: 'text', text: '总结全文' }], timestamp: '2026-08-03T02:22:10.329Z' }] });
    h.hooks.handleStreamEnd('X1', 4, 'error_during_execution');
    await h.tick(60);
    var fails = [];
    var turn = h.document.querySelector('.assistant-turn');
    if (!turn) { fails.push('no assistant turn'); return fails; }
    var kids = [...turn.children];
    var iAns = kids.findIndex(function (e) { return e.textContent.includes('总结全文'); });
    var iInt = kids.findIndex(function (e) { return /msg-interrupt/.test(e.className); });
    if (iAns < 0) fails.push('answer text missing (clearStreamPreviews wiped it?)');
    if (iInt < 0) fails.push('Interrupted marker missing (clearStreamPreviews wiped it?)');
    if (iAns >= 0 && iInt >= 0 && !(iAns < iInt)) fails.push('Interrupted not after answer: ans@' + iAns + ' int@' + iInt);
    return fails;
  },

  // Interrupt during THINKING only (screenshot bug): incomplete extended-thinking is never
  // persisted to jsonl, so NO authoritative assistant row arrives → clearStreamPreviews never
  // fires → the thinking preview stays on screen. The "[Request interrupted]" row (streamId)
  // must land AFTER the still-present preview, not between the question bubble and the preview.
  'interrupt-thinking-only': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
    h.document.querySelector('.messages').innerHTML = '<div class="msg-user" id="q1" data-ts="2026-08-03T02:21:53.000Z" data-anchor="q1">给个总结</div>';
    h.state.pendingSentMessages = [{ id: 'q1', seq: 0, text: '给个总结', fullText: '给个总结', images: [], sentAt: Date.now() }];
    h.hooks.handleWsMessage({ action: 'send_message_result', sessionId: 'S', ok: true, clientId: 'q1', streamId: 'X1' });
    // Thinking-only stream (no text block starts before the interrupt).
    h.hooks.pushStreamFrame('X1', { t: 'start', seq: 0, blockId: 0, kind: 'thinking' });
    h.hooks.pushStreamFrame('X1', { t: 'delta', seq: 1, blockId: 0, chunk: '让我想想…' });
    await h.tick(40);
    // Interrupt: ONLY the "[Request interrupted]" user row arrives (no authoritative thinking row).
    h.hooks.handleWsMessage({ action: 'messages', sessionId: 'S', streamId: 'X1', messages: [{ uuid: 'int1', parentUuid: null, type: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }], timestamp: '2026-08-03T02:22:10.331Z' }] });
    h.hooks.handleStreamEnd('X1', 2, 'error_during_execution');
    await h.tick(60);
    var fails = [];
    var kids = [...h.document.querySelector('.messages').children];
    var iThink = kids.findIndex(function (e) { return /stream-turn-X1/.test(e.id) || e.textContent.indexOf('让我想想') !== -1; });
    var iInt = kids.findIndex(function (e) { return e.textContent.indexOf('Interrupted') !== -1; });
    if (iThink < 0) fails.push('thinking preview missing');
    if (iInt < 0) fails.push('Interrupted marker missing');
    if (iThink >= 0 && iInt >= 0 && !(iThink < iInt)) fails.push('Interrupted not after thinking: think@' + iThink + ' int@' + iInt);
    return fails;
  },

  // Reorder buffer: deltas + block frames delivered OUT of seq order (Lambda fan-out
  // reorders). Final rendered text must be correct and in order regardless of arrival.
  'out-of-order-delivery': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    // Manually assign seqs and deliver them scrambled. One text block, chunks "AB","CD","EF".
    await replay(h, [{ authUser: 'Q' }]);
    await replay(h, [
      { start: true, block: 0, kind: 'text', seq: 0 },
      { delta: true, block: 0, text: 'EF', seq: 3 },   // arrives first, but is last
      { delta: true, block: 0, text: 'AB', seq: 1 },
      { delta: true, block: 0, text: 'CD', seq: 2 },
      { stop: true, block: 0, seq: 4 },
      { authAsst: 'ABCDEF' },
      { end: true, finalSeq: 4 },
    ]);
    return assertTurns(h, [{ u: 'Q', a: 'ABCDEF' }]);
  },

  // Connector adjacency: two assistant-turns made adjacent (mid-turn authoritative flush
  // creates a turn, later content lands as a second turn right after it). markTurnAdjacency
  // must tag the first has-next-turn and the second follows-turn so the line connects.
  'connector-adjacent-turns': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
    // Two authoritative assistant rows with NO user row between them (headless split turn)
    // land as two adjacent .assistant-turn siblings after the question.
    await replay(h, [{ authUser: 'Q' }]);
    // First assistant row → its own turn. Second → replyPlacement reuses/creates adjacent.
    h.state.wsAllMessages.push({ uuid: 'x1', type: 'assistant', content: [{ type: 'text', text: 'PART1' }], timestamp: '2026-01-01T00:00:05.000Z' });
    h.state.wsMessageUuids.add('x1');
    h.hooks.updateLastTurn();
    // Force a separate adjacent turn by direct DOM (simulate a non-merged second turn) then re-mark.
    const c = h.document.querySelector('.messages');
    c.insertAdjacentHTML('beforeend', '<div class="assistant-turn"><div class="tl-item assistant-text" data-ts="2026-01-01T00:00:06.000Z">PART2</div></div>');
    h.window.markTurnAdjacency(c);
    const turns = [...c.querySelectorAll('.assistant-turn')];
    const fails = [];
    if (turns.length < 2) { fails.push(`expected >=2 adjacent turns, got ${turns.length}`); return fails; }
    const a = turns[turns.length - 2], b = turns[turns.length - 1];
    if (!a.classList.contains('has-next-turn')) fails.push('first adjacent turn missing has-next-turn');
    if (!b.classList.contains('follows-turn')) fails.push('second adjacent turn missing follows-turn');
    // A turn NOT followed by another turn must not keep has-next-turn.
    if (b.classList.contains('has-next-turn')) fails.push('last turn wrongly has has-next-turn');
    return fails;
  },

  // Explicit address: streamId→clientId binds the reply to its OWN question, even when it
  // arrives in an order the structural (FIFO/first-pending) guess would misplace. Two sends
  // queued; the reply for the SECOND streams while both are pending. It must land under the
  // second bubble (its anchor), NOT under the first (which first-pending would pick).
  'stream-anchor-explicit-address': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.wsRunning = false;
    await replay(h, [{ u: 'first' }, { u: 'second' }]);
    // Ack "second" with a streamId → binds streamAnchors[SS] = second's clientId.
    await replay(h, [{ ack: 'second', streamId: 'SS' }]);
    // The reply for "second" streams on SS while BOTH bubbles are still pending.
    await replay(h, [{ start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: 'R-second' }], { sid: 'SS' });
    const fails = [];
    const preview = h.document.getElementById('stream-turn-SS');
    if (!preview) { fails.push('no preview for SS'); return fails; }
    const prev = preview.previousElementSibling;
    if (!prev || !prev.textContent.includes('second')) fails.push(`preview not under "second" (prev=${prev ? JSON.stringify(prev.textContent.replace('sending...','').trim()) : 'null'})`);
    // Explicitly NOT under "first".
    const order = [...h.document.querySelector('.messages').children].map(e => e.id === 'stream-turn-SS' ? '[preview]' : e.textContent.replace('sending...','').trim());
    const iFirst = order.indexOf('first'), iSecond = order.indexOf('second'), iPrev = order.indexOf('[preview]');
    if (!(iFirst < iSecond && iSecond < iPrev)) fails.push(`wrong order ${JSON.stringify(order)}`);
    return fails;
  },

  // Connector cleanup: once the preview is cleared (turn ended), the prior turn must lose
  // has-next-turn (else a dangling connector line points at nothing).
  'connector-cleared-after-stream-end': async (h) => {
    resetSession(h, { mode: 'existing', sessionId: 'S' });
    h.state.ws = { readyState: h.window.WebSocket.OPEN, send() {}, close() {} };
    await replay(h, [{ authUser: 'old-q' }, ...plainTurn('OLD-A')]);
    h.window.doSend('new-q', 'new-q', []);
    await h.tick(3);
    // Stream a preview (creates stream-turn adjacent to something), then end + authoritative.
    await replay(h, [{ start: true, block: 0, kind: 'text' }, { delta: true, block: 0, text: 'NEW-A' }, { authAsst: 'NEW-A' }, { stop: true, block: 0 }, { end: true }], { sid: 'S2' });
    const c = h.document.querySelector('.messages');
    const fails = [];
    if (h.document.getElementById('stream-turn-S2')) fails.push('preview turn not removed after stream_end');
    // Every remaining turn's has-next-turn must be truthful (only if a turn actually follows).
    const kids = [...c.children];
    for (let i = 0; i < kids.length; i++) {
      if (!/assistant-turn/.test(kids[i].className)) continue;
      const next = kids[i + 1];
      const shouldHave = !!(next && /assistant-turn/.test(next.className));
      if (kids[i].classList.contains('has-next-turn') !== shouldHave)
        fails.push(`turn ${i} has-next-turn=${kids[i].classList.contains('has-next-turn')} but next-is-turn=${shouldHave}`);
    }
    return fails;
  },
};

const only = process.argv[2]; // scenario name → run just that one in THIS process

// ws.js is a module singleton (one import binds to one jsdom window), so each scenario
// must run in its own process. No arg → dispatcher: spawn one child per scenario.
if (!only) {
  const { spawnSync } = await import('child_process');
  const { fileURLToPath } = await import('url');
  const self = fileURLToPath(import.meta.url);
  let pass = 0, fail = 0;
  for (const name of Object.keys(SCENARIOS)) {
    const r = spawnSync(process.execPath, ['--no-warnings', self, name], { stdio: 'inherit' });
    if (r.status === 0) pass++; else fail++;
  }
  console.log(`\n=== ${pass} PASS, ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
}

const fn = SCENARIOS[only];
if (!fn) { console.error(`unknown scenario: ${only}`); process.exit(2); }
const h = await makeHarness();
let fails;
try { fails = await fn(h); } catch (e) { fails = ['threw: ' + e.message]; }
if (fails.length) {
  console.error(`FAIL ${only}`); fails.forEach(f => console.error('  - ' + f));
  h.dumpDom().forEach((n, i) => console.error(`    dom[${i}] ${n.cls}: ${JSON.stringify(n.text.slice(0, 40))}`));
  process.exit(1);
}
console.log(`PASS ${only}`);
process.exit(0);
