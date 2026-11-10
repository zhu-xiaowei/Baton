import assert from 'node:assert/strict';
import test from 'node:test';

import { makeHarness, resetSession } from './harness.mjs';

const h = await makeHarness();
const TS = (s) => `2026-10-28T10:00:${String(s).padStart(2, '0')}.000Z`;
const prior = [
  { uuid: 'u0', type: 'user', content: 'old question', timestamp: TS(0) },
  { uuid: 'a0', type: 'assistant', content: [{ type: 'text', text: 'OLD-ANSWER' }], timestamp: TS(1) },
];

// One Claude headless turn: text, Bash tool + result, closing text. Frames carry the
// LiveExecutionStream fields a regular Claude send publishes (bridge `userInitiated` → steer).
function claudeTurn(sessionId, turnId) {
  const user = { uuid: turnId.replace(/^sent-/, ''), nativeId: `live:user:${turnId}`, type: 'user', content: 'NEW-QUESTION', timestamp: TS(10) };
  const first = { uuid: 'first', type: 'assistant', content: [{ type: 'text', text: 'FIRST-TEXT' }], timestamp: TS(11) };
  const tool = { uuid: 'tool', type: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }], timestamp: TS(12) };
  const result = { uuid: 'result', type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'out' }], timestamp: TS(13) };
  const summary = { uuid: 'summary', type: 'assistant', content: [{ type: 'text', text: 'SUMMARY' }], timestamp: TS(14) };
  let seq = 0;
  const e = (action, extra = {}) => ({
    action, sessionId, turnId, seq, ...extra,
    executionId: turnId, executionSeq: seq, consumedInputIds: seq++ > 1 ? [turnId] : [],
  });
  const events = [
    e('stream_turn_start'),
    e('messages', { messages: [user], noCache: true }),
    e('stream_block_start', { kind: 'text' }),
    e('stream_delta', { chunk: 'FIRST-TEXT' }),
    e('stream_block_stop'),
    e('messages', { messages: [first], noCache: true }),
    e('stream_block_start', { kind: 'tool_use', name: 'Bash' }),
    e('stream_tool_input', { chunk: '{"command":"ls"}' }),
    e('stream_block_stop'),
    e('messages', { messages: [tool], noCache: true }),
    e('messages', { messages: [result], noCache: true }),
    e('stream_block_start', { kind: 'text' }),
    e('stream_delta', { chunk: 'SUMMARY' }),
    e('stream_block_stop'),
    e('messages', { messages: [summary], noCache: true }),
  ];
  const end = e('stream_end', { messages: [first, tool, result, summary] });
  const { nativeId, ...persistedUser } = user;
  return { events, end, user: persistedUser, ddb: [...prior, persistedUser, first, tool, result, summary] };
}

function start(sessionId, turnId) {
  h.window.disconnectWs();
  resetSession(h, { sessionId });
  h.state.wsAllMessages = prior.slice();
  h.state.ws = { readyState: 1, send() {}, close() {} };
  h.state.appState.runtime = 'claude';
  h.document.querySelector('.messages').innerHTML = h.window.renderMessages(prior, 'claude')
    + `<div class="msg-user" id="${turnId}" data-pending="1" data-anchor="${turnId}">NEW-QUESTION</div>`;
  h.state.pendingSentMessages = [{
    id: turnId, seq: 1, text: 'NEW-QUESTION', fullText: 'NEW-QUESTION', images: [],
    sentAt: Date.now(), sessionId, serverReceived: true,
  }];
  return claudeTurn(sessionId, turnId);
}

// Real frames and REST bodies are freshly parsed JSON; never share objects across them.
const send = (events) => { for (const event of events) h.hooks.handleWsMessage(structuredClone(event)); };
const setRest = (handler) => h.setApiHandler(async () => structuredClone(await handler()));
const textOrder = () => {
  const text = h.document.querySelector('.messages').textContent;
  return ['NEW-QUESTION', 'FIRST-TEXT', 'SUMMARY'].map(key => text.indexOf(key));
};
const assertOrdered = () => {
  const [question, first, summary] = textOrder();
  assert.ok(question >= 0 && question < first && first < summary, h.document.querySelector('.messages').innerHTML);
  assert.equal(h.document.querySelector('.messages').textContent.split('SUMMARY').length, 2);
};

test('a frame lost mid-turn is recovered once a pong proves it is not in flight', async () => {
  const turn = start('gap-session', 'sent-00000000-0000-4000-8000-000000000001');
  let requests = 0;
  setRest(async () => {
    requests++;
    return { messages: turn.ddb.filter(message => message.uuid !== 'summary'), status: 'running', hasMore: false };
  });
  send(turn.events.filter(event => event.seq !== 7 && event.seq < 11));
  // The execution queue holds the later frames first and releases them after its own REST.
  await h.tick(650);
  assert.equal(requests, 1, 'a turn gap without a pong is still treated as reordering');
  send([{ action: 'realtime_pong' }]);
  await h.tick(100);
  assert.equal(requests, 2);
  send(turn.events.filter(event => event.seq >= 11));
  await h.tick(1000);
  assert.equal(requests, 2, 'frames after the refresh continue the same execution');
  await h.tick(150);
  assertOrdered();
  send([turn.end]);
  await h.tick(150);
  assertOrdered();
  assert.equal(h.state.wsRunning, false);
});

test('REST recovery after a gapped turn keeps the first reply above the summary', async () => {
  const turn = start('compact-session', 'sent-00000000-0000-4000-8000-000000000002');
  setRest(async () => ({ messages: turn.ddb, status: 'completed', hasMore: false }));
  send(turn.events.filter(event => event.seq !== 7));
  const { messages, ...compactEnd } = turn.end;
  send([{ ...compactEnd, recoveryRequired: true }]);
  await h.tick(1200);
  assertOrdered();
});

test('a silent running turn whose stream_end was lost is settled from REST status', async () => {
  const turn = start('silent-session', 'sent-00000000-0000-4000-8000-000000000004');
  send(turn.events);
  await h.tick(200);
  assert.equal(h.state.wsRunning, true);
  setRest(async () => ({ messages: turn.ddb, status: 'completed', hasMore: false }));
  await h.hooks.checkSilentTurn();
  await h.tick(50);
  assertOrdered();
  assert.equal(h.state.wsRunning, false);
});
