import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness, resetSession } from './harness.mjs';
import { assertTurns, replay } from './replay.mjs';

const SESSION_ID = 'codex:019fefc3-4ae0-7b51-8a98-a4da30ec122e';
const STREAM_ID = '131f4f1b-6394-4ca7-bfdb-21dcdd9ef41a';
const ANSWER = '沈砚回到故乡，整理外婆留下的老旧照相馆。一卷胶片揭开父亲十八年前失踪的真正原因。原来他为营救七名学生，最终牺牲在洪水中。多年流言被照片和信件澄清，真相终于归来。沈砚留在故乡，让老照相馆守护父亲的记忆。';

function send(h, action, extra = {}) {
  h.hooks.handleWsMessage({
    action,
    sessionId: SESSION_ID,
    streamId: STREAM_ID,
    ...extra,
  });
}

function assistant(uuid) {
  return {
    uuid,
    nativeId: 'codex:item:msg_3c04b66ba98a55cfa1468bd0136b4123',
    type: 'assistant',
    content: [{ type: 'text', text: ANSWER }],
    timestamp: '2026-08-11T13:33:22.509Z',
  };
}

test('captured Codex sequence renders deltas before the authoritative row', async () => {
  const h = await makeHarness();
  resetSession(h, { sessionId: SESSION_ID });
  h.state.appState.runtime = 'codex';
  h.window.markCodexExploreGroups = (container) => {
    for (const row of Array.from(container.children)) {
      if (row.classList.contains('assistant-turn') && !row.children.length) row.remove();
    }
  };

  await replay(h, [
    { u: '给我100字总结' },
    { ack: '给我100字总结', streamId: STREAM_ID },
  ]);

  // The captured turn contains two empty reasoning items followed by the real
  // agent message. That produces three start/stop block pairs.
  send(h, 'stream_block_start', { seq: 0, blockId: 0, kind: 'thinking' });
  send(h, 'stream_block_stop', { seq: 1, blockId: 0 });
  send(h, 'stream_block_start', { seq: 2, blockId: 1, kind: 'thinking' });
  send(h, 'stream_block_stop', { seq: 3, blockId: 1 });
  send(h, 'stream_block_start', { seq: 4, blockId: 2, kind: 'text' });

  const prefixChunks = [
    '沈砚回到故乡，',
    '整理外婆留下的老旧照相馆。',
    '一卷胶片揭开父亲十八年前',
    '失踪的真正原因。',
    '原来他为营',
    '救七名学生，最终牺牲在洪水中。多年流言被照片和信件澄清',
  ];
  for (let i = 0; i < prefixChunks.length; i++) {
    send(h, 'stream_delta', { seq: 5 + i, blockId: 2, chunk: prefixChunks[i] });
  }
  await h.tick(250);

  const preview = h.document.getElementById(`stream-turn-${STREAM_ID}`);
  assert.ok(preview, 'the contiguous prefix should create a live preview');
  assert.equal(preview.querySelectorAll('.thinking-tl').length, 2);
  const prefixBeforeGap = preview.querySelector('.assistant-text').textContent;
  assert.match(prefixBeforeGap, /沈砚回到故乡/);

  // Continue with the complete captured sequence. In particular, seq 11 is
  // present and must let all later frames commit without any gap recovery.
  const suffixFrames = [
    [11, '，'],
    [12, '真相终于归'],
    [13, '来'],
    [14, '。'],
    [15, '沈'],
    [16, '砚留在故乡，让老照相'],
    [17, '馆'],
    [18, '守'],
    [19, '护'],
    [20, '父亲的记忆。'],
  ];
  for (const [seq, chunk] of suffixFrames) {
    send(h, 'stream_delta', { seq, blockId: 2, chunk });
  }
  await h.tick(300);

  assert.equal(preview.querySelector('.assistant-text').textContent, ANSWER);

  h.hooks.handleWsMessage({
    action: 'messages',
    sessionId: SESSION_ID,
    messages: [assistant('codex_0000000365_90757e0ad41ca14f')],
  });
  send(h, 'stream_block_stop', { seq: 21, blockId: 2 });
  send(h, 'messages', {
    messages: [assistant('codex_live_agent_msg_3c04b66ba98a55cfa1468bd0136b4123')],
  });
  send(h, 'stream_end', { finalSeq: 22 });
  await h.tick(500);

  assert.deepEqual(assertTurns(h, [
    { u: '给我100字总结', a: ANSWER },
  ]), []);
  assert.equal(h.document.getElementById(`stream-turn-${STREAM_ID}`), null);
});
