import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';

// A turn streaming while the page refreshes or misses frames keeps what it showed; the Bridge's
// replay of the running turn fills what was missed.
test('a running turn survives a foreground refresh, a gap and a late join', async () => {
  const h = await makeHarness();
  globalThis.showWsBanner = h.window.showWsBanner = () => {};
  const shown = () => (h.document.getElementById('content').textContent || '').replace(/\s+/g, ' ');
  const once = (word) => shown().split(word).length - 1;
  let n = 0;
  async function start(history) {
    const sessionId = 'claude-' + ++n;
    h.state.ws = { readyState: 1, send() {}, close() {} };
    h.window.disconnectWs();
    resetSession(h, { sessionId });
    h.state.appState.runtime = 'claude';
    h.state.ws = { readyState: 1, send() {}, close() {} };
    const turnId = `sent-00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const user = { uuid: turnId.slice(5), nativeId: `live:user:${turnId}`, type: 'user', content: 'q', timestamp: new Date().toISOString() };
    const events = [{ action: 'stream_turn_start' }, { action: 'messages', messages: [user] }, { action: 'stream_block_start', kind: 'text' },
      ...Array.from({ length: 20 }, (_, i) => ({ action: 'stream_delta', chunk: `w${i} ` }))]
      // Claude turns also carry the execution order (a regular send is an execution of one turn).
      .map((event, seq) => ({ ...event, sessionId, turnId, seq, executionId: turnId, executionSeq: seq, consumedInputIds: seq > 1 ? [turnId] : [] }));
    h.setApiHandler(async () => structuredClone(await history(user)));
    return { sessionId, events, push: (list) => list.forEach((e) => h.bridge.push(structuredClone(e))) };
  }
  const running = (user) => ({ messages: [user], status: 'running', hasMore: false });

  let t = await start(running);
  t.push(t.events.slice(0, 13));
  await h.tick(150);
  h.window.resumeSessionForeground();
  await h.tick(150);
  t.push(t.events.slice(13));
  await h.tick(250);
  assert.deepEqual([once('w0 '), once('w19 ')], [1, 1], 'the foreground refresh keeps the streamed text');

  t = await start(running);
  t.push(t.events.slice(0, 8));
  await h.tick(150);
  h.window.resumeSessionForeground();
  await h.tick(100);
  h.bridge.push({ action: 'turn_replay', sessionId: t.sessionId, events: structuredClone(t.events.slice(0, 18)) });
  t.push(t.events.slice(18));
  await h.tick(250);
  assert.deepEqual([once('w0 '), once('w10 '), once('w19 ')], [1, 1, 1], 'the replay fills the frames missed while hidden');

  let release;
  t = await start((user) => new Promise((resolve) => { release = () => resolve(running(user)); }));
  const loading = h.window.loadLatestMessages(t.sessionId);
  await h.tick(20);
  h.bridge.push({ action: 'turn_replay', sessionId: t.sessionId, events: structuredClone(t.events) });
  release();
  await loading;
  await h.tick(250);
  assert.deepEqual([once('w0 '), once('w19 ')], [1, 1], 'a page opened mid-turn shows the turn from its start');

  // Reopening the Session on screen (a notification tap): the snapshot resets the turn, the replay rebuilds it.
  t = await start(running);
  t.push(t.events.slice(0, 10));
  await h.tick(150);
  h.document.getElementById('content').innerHTML = '<div class="skeleton-messages"></div>';
  h.state.wsAllMessages = [];
  h.window.startWs(t.sessionId);
  const reopening = h.window.loadLatestMessages(t.sessionId);
  await h.tick(20);
  h.bridge.push({ action: 'turn_replay', sessionId: t.sessionId, events: structuredClone(t.events.slice(0, 14)) });
  await reopening;
  t.push(t.events.slice(14));
  await h.tick(300);
  assert.deepEqual([once('w0 '), once('w10 '), once('w19 ')], [1, 1, 1], 'reopening mid-turn rebuilds the turn');

  // Opened mid-turn after the transcript has reply rows: the history keeps them, the replay adds only what follows.
  const row = (uuid, text) => ({ uuid, type: 'assistant', content: [{ type: 'text', text }], timestamp: new Date().toISOString() });
  const rows = [row('a-1', Array.from({ length: 20 }, (_, i) => `w${i} `).join('')), row('a-2', 'second ')];
  t = await start((user) => new Promise((resolve) => { release = () => resolve({ ...running(user), messages: [user, ...rows] }); }));
  const base = t.events[t.events.length - 1];
  const block = (chunk) => [{ action: 'stream_block_start', kind: 'text' }, { action: 'stream_delta', chunk }];
  // Claude Code sends a block's row before its stop.
  const more = [{ action: 'messages', messages: [rows[0]] }, { action: 'stream_block_stop' }, ...block('second '),
    { action: 'messages', messages: [rows[1]] }, { action: 'stream_block_stop' }, ...block('tail ')]
    .map((event, i) => ({ ...base, chunk: undefined, ...event, seq: base.seq + 1 + i, executionSeq: base.seq + 1 + i }));
  const opening = h.window.loadLatestMessages(t.sessionId);
  await h.tick(20);
  h.bridge.push({ action: 'turn_replay', sessionId: t.sessionId, events: structuredClone([...t.events, ...more]) });
  release();
  await opening;
  assert.equal(once('second '), 1, 'the newest history row is not taken back to be revealed again');
  await h.tick(250);
  assert.deepEqual([once('w0 '), once('second '), once('tail ')], [1, 1, 1], 'rows the history has are not replayed');
  h.window.close();
});
