import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { assertTurns, replay } from './replay.mjs';

test('Codex live events reuse the CC preview and authoritative-row handoff', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: 'codex:thread-1' });
  h.state.appState.runtime = 'codex';

  await replay(h, [
    { u: 'hello codex' },
    { ack: 'hello codex', streamId: 'codex-stream-1' },
    {
      inMsg: {
        uuid: 'codex-live-user',
        type: 'user',
        content: 'hello codex',
        timestamp: '2026-08-11T00:00:00.000Z',
      },
      streamId: 'codex-stream-1',
    },
    { start: true, sid: 'codex-stream-1', block: 0, kind: 'text' },
    { delta: true, sid: 'codex-stream-1', block: 0, text: 'streamed ' },
    { delta: true, sid: 'codex-stream-1', block: 0, text: 'answer' },
    { stop: true, sid: 'codex-stream-1', block: 0 },
    { authAsst: 'streamed answer', streamId: 'codex-stream-1' },
    { end: true, sid: 'codex-stream-1', finalSeq: 4 },
  ]);

  assert.deepEqual(assertTurns(h, [
    { u: 'hello codex', a: 'streamed answer' },
  ]), []);
  assert.equal(h.document.querySelector('[id^="stream-turn-"]'), null);

  resetSession(h, { sessionId: 'codex:thread-reloaded-approval' });
  h.state.appState.runtime = 'codex';
  await replay(h, [{ authUser: 'approval question' }]);
  h.hooks.pushStreamFrame('codex-stream-reloaded', {
    t: 'start',
    seq: 10,
    blockId: 3,
    kind: 'text',
  });
  h.hooks.pushStreamFrame('codex-stream-reloaded', {
    t: 'delta',
    seq: 11,
    blockId: 3,
    chunk: 'THREE_DONE',
  });
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: 'codex:thread-reloaded-approval',
    streamId: 'codex-stream-reloaded',
    messages: [{
      uuid: 'live-reloaded-final',
      nativeId: 'codex:item:agent-reloaded',
      type: 'assistant',
      content: [{ type: 'text', text: 'THREE_DONE' }],
      timestamp: '2026-08-14T03:26:13.553Z',
    }],
  });

  assert.deepEqual(assertTurns(h, [
    { u: 'approval question', a: 'THREE_DONE' },
  ]), []);
  assert.equal(
    h.state.wsAllMessages.filter(
      (message) => message.nativeId === 'codex:item:agent-reloaded',
    ).length,
    1,
  );

  resetSession(h, { sessionId: 'codex:thread-tools' });
  h.state.appState.runtime = 'codex';
  h.state.streamAnchors = { 'codex-stream-tools': 'sent-tools' };
  h.document.querySelector('.messages').innerHTML = [
    '<div class="msg-user" data-anchor="sent-tools">tool question</div>',
    '<div class="assistant-turn"><div class="tl-item tool-node">first tool</div></div>',
    '<div class="assistant-turn"><div class="tl-item tool-node">second tool</div></div>',
  ].join('');
  h.hooks.handleStreamEnd('codex-stream-tools', 0);
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: 'codex:thread-tools',
    streamId: 'codex-stream-tools',
    messages: [{
      uuid: 'live-tool-answer',
      nativeId: 'codex:item:tool-answer',
      type: 'assistant',
      content: [{ type: 'text', text: 'answer after tools' }],
      timestamp: '2026-08-11T00:03:00.000Z',
    }],
  });

  const toolRows = h.document.querySelectorAll('.assistant-turn');
  assert.equal(toolRows.length, 2);
  assert.equal(toolRows[0].textContent, 'first tool');
  assert.equal(toolRows[1].textContent, 'second toolanswer after tools');

  resetSession(h, { sessionId: 'codex:thread-race' });
  h.state.appState.runtime = 'codex';
  await replay(h, [
    { u: 'race question' },
    { ack: 'race question', streamId: 'codex-stream-race' },
    {
      inMsg: {
        uuid: 'live-user',
        nativeId: 'codex:user:stream-race',
        type: 'user',
        content: 'race question',
        timestamp: '2026-08-11T00:01:00.000Z',
      },
      streamId: 'codex-stream-race',
    },
    {
      inMsg: {
        uuid: 'watcher-user',
        nativeId: 'codex:user:stream-race',
        type: 'user',
        content: 'race question',
        timestamp: '2026-08-11T00:01:00.001Z',
      },
    },
    { start: true, sid: 'codex-stream-race', block: 0, kind: 'text' },
    { delta: true, sid: 'codex-stream-race', block: 0, text: 'race ' },
    { delta: true, sid: 'codex-stream-race', block: 0, text: 'answer' },
    {
      inMsg: {
        uuid: 'watcher-assistant',
        nativeId: 'codex:item:agent-race',
        type: 'assistant',
        content: [{ type: 'text', text: 'race answer' }],
        timestamp: '2026-08-11T00:01:01.000Z',
      },
    },
    {
      inMsg: {
        uuid: 'live-assistant',
        nativeId: 'codex:item:agent-race',
        type: 'assistant',
        content: [{ type: 'text', text: 'race answer' }],
        timestamp: '2026-08-11T00:01:01.001Z',
      },
      streamId: 'codex-stream-race',
    },
    { stop: true, sid: 'codex-stream-race', block: 0 },
    { end: true, sid: 'codex-stream-race', finalSeq: 4 },
  ]);

  assert.deepEqual(assertTurns(h, [
    { u: 'race question', a: 'race answer' },
  ]), []);
  assert.equal(h.state.wsAllMessages.filter(
    (message) => message.nativeId === 'codex:user:stream-race',
  ).length, 1);
  assert.equal(h.state.wsAllMessages.filter(
    (message) => message.nativeId === 'codex:item:agent-race',
  ).length, 1);

  resetSession(h, { sessionId: 'codex:thread-late-frames' });
  h.state.appState.runtime = 'codex';
  await replay(h, [
    { u: 'late frame question' },
    { ack: 'late frame question', streamId: 'codex-stream-late' },
  ]);
  h.hooks.pushStreamFrame('codex-stream-late', {
    t: 'delta',
    seq: 1,
    blockId: 0,
    chunk: 'late answer',
  });
  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: 'codex:thread-late-frames',
    streamId: 'codex-stream-late',
    messages: [{
      uuid: 'live-late-assistant',
      nativeId: 'codex:item:agent-late',
      type: 'assistant',
      content: [{ type: 'text', text: 'late answer' }],
      timestamp: '2026-08-11T00:02:01.000Z',
    }],
  });
  h.hooks.handleStreamEnd('codex-stream-late', 3);
  h.hooks.pushStreamFrame('codex-stream-late', {
    t: 'start',
    seq: 0,
    blockId: 0,
    kind: 'text',
  });
  h.hooks.pushStreamFrame('codex-stream-late', {
    t: 'stop',
    seq: 2,
    blockId: 0,
  });
  await h.tick(300);

  assert.deepEqual(assertTurns(h, [
    { u: 'late frame question', a: 'late answer' },
  ]), []);
  assert.equal(h.document.querySelector('[id^="stream-turn-"]'), null);

  resetSession(h, { sessionId: 'codex:thread-1' });
  h.state.appState.device = 'Mac';

  await replay(h, [{ u: 'hello codex' }]);
  const pending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:thread-1',
    clientId: pending.id,
    deviceName: 'Other',
    ok: false,
    error: 'wrong device',
  });

  assert.equal(pending.delivered, undefined);
  assert.equal(h.document.querySelector('.send-retry'), null);

  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:thread-1',
    clientId: pending.id,
    deviceName: 'Mac',
    streamId: 'stream-1',
    ok: true,
  });
  assert.equal(pending.delivered, true);
  assert.equal(h.state.streamAnchors['stream-1'], pending.id);

  resetSession(h, { sessionId: 'codex:thread-1' });
  h.state.appState.runtime = 'codex';
  h.state.appState.device = 'Mac';
  const sent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send: (raw) => sent.push(JSON.parse(raw)),
  };

  h.window.doSend('take over test', 'take over test', []);
  const takeoverPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:thread-1',
    clientId: takeoverPending.id,
    deviceName: 'Mac',
    ok: false,
    error: 'already has an active writer',
    errorCode: 'codex_active_writer',
    writer: {
      pid: 123,
      tty: 'ttys001',
      label: 'Codex terminal (ttys001)',
      canTerminate: true,
      status: 'running',
    },
  });

  assert.equal(takeoverPending.delivered, undefined);
  assert.equal(h.document.getElementById('codexTakeoverModal').style.display, 'flex');
  assert.match(h.document.getElementById('codexTakeoverDesc').textContent, /Codex terminal/);
  assert.equal(sent.length, 1);

  h.window.confirmCodexTakeover();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], {
    ...sent[0],
    takeover: true,
    expectedWriterPid: 123,
  });
  assert.equal(h.document.getElementById('codexTakeoverConfirm').disabled, true);

  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:thread-1',
    clientId: takeoverPending.id,
    deviceName: 'Mac',
    streamId: 'stream-takeover',
    ok: true,
  });
  assert.equal(takeoverPending.delivered, true);
  assert.equal(h.document.getElementById('codexTakeoverModal').style.display, 'none');
  assert.equal(h.state.streamAnchors['stream-takeover'], takeoverPending.id);

  resetSession(h, { sessionId: 'codex:thread-1' });
  h.state.appState.runtime = 'codex';
  const cancelledSent = [];
  h.state.ws = {
    readyState: WebSocket.OPEN,
    send: (raw) => cancelledSent.push(JSON.parse(raw)),
  };

  h.window.doSend('leave tui alone', 'leave tui alone', []);
  const cancelledPending = h.state.pendingSentMessages[0];
  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:thread-1',
    clientId: cancelledPending.id,
    ok: false,
    errorCode: 'codex_active_writer',
    writer: {
      pid: 321,
      label: 'Codex terminal',
      canTerminate: true,
      status: 'running',
    },
  });
  h.window.closeCodexTakeoverModal();

  assert.equal(cancelledSent.length, 1);
  assert.equal(cancelledPending.delivered, true);
  assert.equal(h.document.getElementById('codexTakeoverModal').style.display, 'none');
  assert.match(h.document.querySelector('.sending-status').textContent, /Not sent/);

  resetSession(h, { sessionId: 'codex:idle-conflict' });
  h.window.doSend('hello', 'hello', []);
  const idlePending = h.state.pendingSentMessages[0];

  h.hooks.handleWsMessage({
    action: 'send_message_result',
    sessionId: 'codex:idle-conflict',
    clientId: idlePending.id,
    ok: false,
    error: 'Could not verify that the Codex session is idle',
    errorCode: 'codex_writer_unsafe',
    writer: {
      pid: 456,
      label: 'Codex terminal',
      canTerminate: true,
      status: null,
    },
  });

  assert.equal(h.document.getElementById('codexTakeoverModal').style.display, 'none');
  assert.equal(idlePending.delivered, true);
});
