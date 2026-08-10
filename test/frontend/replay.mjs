// Replay a WS event sequence through the real ws.js render code (via the harness),
// then assert the rendered DOM. Events use a compact shorthand:
//
//   { u: 'text' }                          → optimistic user bubble (self-send)
//   { authUser: 'text' }                   → authoritative user row (watcher/jsonl)
//   { authAsst: 'text' | [blocks] }        → authoritative assistant row
//   { start, block, kind }                 → stream_block_start
//   { delta, block, text }                 → stream_delta (chunk)
//   { input, block, input:'json' }          → stream_tool_input (tool_use partial JSON)
//   { stop, block }                        → stream_block_stop
//   { end }                                → stream_end
//
// `block`/`seq` default sensibly; pass `sid` to target a specific stream (default 'S').

let _seq = 0;

export async function replay(h, events, { sid = 'S' } = {}) {
  const { state, hooks } = h;
  _seq = 0;
  const pushMsg = (m) => {
    if (state._wsBuffer !== null) { state._wsBuffer.push(m); return; }
    if (m.uuid && state.wsMessageUuids.has(m.uuid)) return;
    state.wsAllMessages.push(m);
    if (m.uuid) state.wsMessageUuids.add(m.uuid);
    state.wsMessageCount = (state.wsMessageCount || 0) + 1;
    if (m.timestamp) state.wsLastTimestamp = m.timestamp;
    hooks.updateLastTurn();
  };
  let uid = 0, ts = 0;
  const nextTs = () => '2026-01-01T00:00:' + String(++ts).padStart(2, '0') + '.000Z';

  for (const ev of events) {
    const s = ev.sid || sid;
    if ('u' in ev) {
      // optimistic bubble (extra self-send). Unique id — must not collide with the
      // resetSession first-send bubble (sent-1) or getElementById returns the wrong one.
      const d = h.document; const c = d.querySelector('.messages');
      const id = 'bub-' + (++uid);
      // Mirror doSend's pending shape: monotonic seq + sentAt (reconcileEchoedPending
      // uses both; a missing sentAt makes idleStale fire and falsely wipe the bubble).
      state.pendingSentMessages.push({ id, seq: state.pendingSentMessages.length, text: ev.u, fullText: ev.u, images: [], sentAt: Date.now(), echoScanFrom: state.wsAllMessages.length });
      c.insertAdjacentHTML('beforeend', '<div class="msg-user" id="' + id + '" data-pending="1" data-anchor="' + id + '">' + ev.u + '</div>');
    } else if ('authUser' in ev) {
      const row = { uuid: 'u' + (++uid), type: 'user', content: [{ type: 'text', text: ev.authUser }], timestamp: nextTs() };
      // ev.streamId → route through real dispatch so _streamId attaches (mirrors the bridge).
      if (ev.streamId) hooks.handleWsMessage({ action: 'messages', sessionId: state.wsSessionId, streamId: ev.streamId, messages: [row] });
      else pushMsg(row);
    } else if ('authAsst' in ev) {
      const content = Array.isArray(ev.authAsst) ? ev.authAsst
        : [{ type: 'text', text: ev.authAsst }];
      const row = { uuid: 'a' + (++uid), type: 'assistant', content, timestamp: nextTs() };
      if (ev.streamId) hooks.handleWsMessage({ action: 'messages', sessionId: state.wsSessionId, streamId: ev.streamId, messages: [row] });
      else pushMsg(row);
    } else if ('start' in ev) {
      hooks.pushStreamFrame(s, { t: 'start', seq: ev.seq != null ? ev.seq : _seq++, blockId: ev.block || 0, kind: ev.kind || 'text' });
    } else if ('input' in ev) {
      hooks.pushStreamFrame(s, { t: 'input', seq: ev.seq != null ? ev.seq : _seq++, blockId: ev.block || 0, chunk: ev.input });
    } else if ('delta' in ev) {
      hooks.pushStreamFrame(s, { t: 'delta', seq: ev.seq != null ? ev.seq : _seq++, blockId: ev.block || 0, chunk: ev.text || ev.delta });
    } else if ('stop' in ev) {
      hooks.pushStreamFrame(s, { t: 'stop', seq: ev.seq != null ? ev.seq : _seq++, blockId: ev.block || 0 });
    } else if ('end' in ev) {
      hooks.handleStreamEnd(s, ev.finalSeq != null ? ev.finalSeq : _seq);
      _seq = 0;
    } else if ('ack' in ev) {
      // send_message_result for the bubble whose text === ev.ack — through REAL dispatch.
      // Optional ev.streamId binds this send's clientId to a stream (mirrors the bridge).
      const p = state.pendingSentMessages.find(x => x.text === ev.ack);
      hooks.handleWsMessage({ action: 'send_message_result', sessionId: state.wsSessionId, ok: true, clientId: p ? p.id : 'unknown', streamId: ev.streamId });
    } else if ('inMsg' in ev) {
      // Route an authoritative row through the REAL onmessage dispatch (handleWsMessage)
      // — exercises reconcileEchoedPending etc., not just updateLastTurn. Optional ev.streamId
      // sits on the envelope (as the bridge does for headless rows; watcher echoes omit it).
      const env = { action: 'messages', sessionId: state.wsSessionId, messages: [ev.inMsg] };
      if (ev.streamId) env.streamId = ev.streamId;
      hooks.handleWsMessage(env);
    } else if ('newSessionThen' in ev) {
      // Reproduce ws.js's send_message_result new-session `.then` body (line 173-199):
      // after the first send creates the session, it rebuilds the DOM from wsAllMessages
      // unless a turn is streaming. This is where later optimistic bubbles get wiped.
      state.appState.session = ev.newSessionThen;
      state.wsSessionId = ev.newSessionThen;
      const container = h.document.querySelector('.messages');
      if (container && state.wsAllMessages.length) {
        // Proposed fix: incremental render only. A full innerHTML rebuild renders just
        // wsAllMessages and wipes other in-flight optimistic bubbles (2/3/4).
        hooks.updateLastTurn();
      }
    }
    await h.tick(3);
  }
  await h.tick(60); // let trailing rAF ticks settle
}

// Assertions over the rendered DOM. Returns array of failure strings (empty = pass).
export function assertTurns(h, expected) {
  const fails = [];
  const nodes = h.dumpDom();
  // Walk user→assistant pairs in order.
  const users = nodes.filter(n => /\bmsg-user\b/.test(n.cls));
  if (users.length !== expected.length) fails.push(`user bubble count ${users.length} != ${expected.length}`);
  // Order + attribution: for each expected turn, the user bubble at position i, and the
  // next assistant-turn sibling contains the answer.
  let ui = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (!/\bmsg-user\b/.test(nodes[i].cls)) continue;
    const want = expected[ui];
    if (!want) { fails.push(`extra user bubble: ${JSON.stringify(nodes[i].text.slice(0, 30))}`); ui++; continue; }
    if (want.u != null && nodes[i].text.trim() !== want.u.trim()) fails.push(`turn ${ui} user: got ${JSON.stringify(nodes[i].text.slice(0, 30))} want ${JSON.stringify(want.u)}`);
    const next = nodes[i + 1];
    if (want.a != null) {
      if (!next || !/assistant-turn/.test(next.cls)) fails.push(`turn ${ui} (${want.a}) has no assistant reply after it`);
      else if (!next.text.includes(want.a)) fails.push(`turn ${ui} reply: got ${JSON.stringify(next.text.slice(0, 40))} want ~${want.a}`);
    }
    ui++;
  }
  // No duplicate answers.
  for (const want of expected) {
    if (want.a == null) continue;
    const hits = nodes.filter(n => /assistant/.test(n.cls) && n.text.includes(want.a)).length;
    if (hits !== 1) fails.push(`answer ${want.a} appears in ${hits} nodes (want 1)`);
  }
  return fails;
}
