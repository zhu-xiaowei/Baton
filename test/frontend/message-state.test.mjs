import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractCodexMessages } from '../../bridge/codex-extract.mjs';
import {
  dedupeMessages,
  commitMessageState,
  reconcilePendingMessages,
  mergeMessages,
} from '../../web/js/message-state.js';

const CODEX_ROLLOUT_FIXTURE = fileURLToPath(new URL(
  '../codex/phase1/fixtures/codex/rollout-2026-08-06T00-00-00-22222222-2222-4222-8222-222222222222.jsonl',
  import.meta.url,
));

function message(uuid, timestamp, extra = {}) {
  return {
    uuid,
    type: 'assistant',
    content: [{ type: 'text', text: uuid }],
    timestamp,
    ...extra,
  };
}

test('dedupeMessages preserves arrival order without mutating input', () => {
  const incoming = [message('a', '03'), message('b', '01'), message('c', '02')];
  const result = dedupeMessages(incoming);
  assert.deepEqual(result.map((item) => item.uuid), ['a', 'b', 'c']);
  assert.notEqual(result[0], incoming[0]);
  assert.equal(incoming[0].identityAliases, undefined);
});

test('dedupeMessages keeps the first complete copy for the same identity', () => {
  const result = dedupeMessages([
    message('shared', '01', { content: 'first' }),
    message('shared', '01', { content: 'different' }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].content, 'first');
});

for (const flag of ['truncated', 'provisional']) {
  test(`dedupeMessages upgrades a ${flag} copy without changing its position`, () => {
    const result = dedupeMessages([
      message('shared', '01', { [flag]: true }),
      message('later', '02'),
      message('shared', '01', { content: 'complete' }),
    ]);
    assert.deepEqual(result.map((item) => item.uuid), ['shared', 'later']);
    assert.equal(result[0].content, 'complete');
    assert.equal(result[0][flag], undefined);
  });
}

test('dedupeMessages preserves distinct UUIDs sharing a legacy nativeId', () => {
  const result = dedupeMessages([
    message('first', '01', { type: 'user', nativeId: 'codex:turn:reused:user', content: 'first' }),
    message('second', '02', { type: 'user', nativeId: 'codex:turn:reused:user', content: 'second' }),
  ]);
  assert.deepEqual(result.map((item) => item.uuid), ['first', 'second']);
});

test('dedupeMessages merges transitive aliases into one canonical message', () => {
  const result = dedupeMessages([
    message('first', '01', { identityAliases: ['logical-user'] }),
    message('mirror', '01', { identityAliases: ['logical-mirror'] }),
    message('bridge', '01', { identityAliases: ['logical-user', 'logical-mirror'] }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].uuid, 'first');
  assert.ok(result[0].identityAliases.includes('uuid:mirror'));
  assert.ok(result[0].identityAliases.includes('uuid:bridge'));
});

test('commitMessageState replaces history and rebuilds only message identities', () => {
  const state = { wsMessageUuids: new Set(['stale']), wsMessageCount: 99 };
  const messages = [
    message('canonical', '', {
      nativeId: 'canonical-native',
      identityAliases: ['uuid:old', 'native:old', 'turn:shared', 'pending:shared'],
    }),
    { nativeId: 'native-only', type: 'assistant', content: 'answer' },
  ];
  commitMessageState(state, messages);
  assert.equal(state.wsAllMessages, messages);
  assert.equal(state.wsMessageCount, 2);
  assert.deepEqual([...state.wsMessageUuids], ['canonical', 'uuid:old', 'native:old', 'native:native-only']);
});

for (const identity of [
  { turnId: 'sent-one' },
  { uuid: 'sent-one' },
  { uuid: 'one' },
  { nativeId: 'codex:user:sent-one' },
  { nativeId: 'live:user:sent-one' },
  { nativeId: 'codex:turn:sent-one:user' },
  { identityAliases: ['pending:sent-one'] },
  { identityAliases: ['turn:sent-one'] },
  { identityAliases: ['native:codex:user:sent-one'] },
  { identityAliases: ['native:live:user:sent-one'] },
]) {
  test(`pending reconciliation matches exact identity ${JSON.stringify(identity)}`, () => {
    const pending = [{ id: 'sent-one', text: 'same' }, { id: 'sent-two', text: 'same' }];
    const echo = { type: 'user', content: 'same', ...identity };
    const result = reconcilePendingMessages(pending, [echo]);
    assert.deepEqual(result.promoted, [{ pending: pending[0], echo }]);
    assert.deepEqual(result.remaining, [pending[1]]);
    assert.equal(echo.turnId, 'sent-one');
  });
}

test('pending reconciliation never matches prompt text or tool results', () => {
  const pending = [{ id: 'sent-one', text: 'same' }];
  const result = reconcilePendingMessages(pending, [
    { uuid: 'other', type: 'user', content: 'same' },
    { turnId: 'sent-one', type: 'assistant', content: 'same' },
    { turnId: 'sent-one', type: 'user', content: [{ type: 'tool_result', content: 'same' }] },
  ]);
  assert.deepEqual(result.promoted, []);
  assert.deepEqual(result.remaining, pending);
});

test('mergeMessages fills an empty local history', () => {
  const incomingMessages = [
    message('a', '2026-08-27T02:00:00.000Z'),
    message('b', '2026-08-27T02:00:01.000Z'),
  ];
  const result = mergeMessages({
    localMessages: [],
    incomingMessages,
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['a', 'b']);
  assert.deepEqual(result.inserted.map((item) => item.index), [0, 1]);
  assert.equal(result.patched.length, 0);
  assert.equal(result.conflicts.length, 0);
});

test('mergeMessages keeps unchanged overlap and object identity', () => {
  const a = message('a', '2026-08-27T02:00:00.000Z');
  const b = message('b', '2026-08-27T02:00:01.000Z');
  const result = mergeMessages({
    localMessages: [a, b],
    incomingMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
    ],
  });

  assert.equal(result.messages[0], a);
  assert.equal(result.messages[1], b);
  assert.equal(result.inserted.length, 0);
  assert.equal(result.patched.length, 0);
  assert.equal(result.identityUpdated.length, 0);
});

test('mergeMessages appends a fetched tail and inserts missing history in order', () => {
  const result = mergeMessages({
    localMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('c', '2026-08-27T02:00:02.000Z'),
    ],
    incomingMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
      message('c', '2026-08-27T02:00:02.000Z'),
      message('d', '2026-08-27T02:00:03.000Z'),
    ],
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['a', 'b', 'c', 'd']);
  assert.deepEqual(
    result.inserted.map((item) => [item.message.uuid, item.index]),
    [['b', 1], ['d', 3]],
  );
});

test('mergeMessages preserves fetched causal order for equal timestamps', () => {
  const timestamp = '2026-08-27T02:00:00.000Z';
  const toolUse = message('z-tool-use', timestamp, {
    content: [{
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pwd' },
    }],
  });
  const toolResult = message('a-tool-result', timestamp, {
    type: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'done',
    }],
  });
  const result = mergeMessages({
    localMessages: [toolResult],
    incomingMessages: [toolUse, toolResult],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['z-tool-use', 'a-tool-result'],
  );
  assert.deepEqual(result.inserted.map((item) => item.index), [0]);
});

test('mergeMessages inserts a missing fetched prefix before the first shared anchor', () => {
  const result = mergeMessages({
    localMessages: [message('c', '2026-08-27T02:00:02.000Z')],
    incomingMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
      message('c', '2026-08-27T02:00:02.000Z'),
    ],
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['a', 'b', 'c']);
  assert.deepEqual(
    result.inserted.map((item) => [item.message.uuid, item.index]),
    [['a', 0], ['b', 1]],
  );
});

test('mergeMessages appends a fetched suffix when no later shared anchor exists', () => {
  const result = mergeMessages({
    localMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('local-only', '2026-08-27T02:00:02.000Z'),
    ],
    incomingMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
    ],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['a', 'local-only', 'b'],
  );
  assert.deepEqual(result.inserted.map((item) => item.index), [2]);
});

test('mergeMessages preserves a local tail missing from fetched history', () => {
  const result = mergeMessages({
    localMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
      message('local-newer', '2026-08-27T02:00:02.000Z'),
    ],
    incomingMessages: [
      message('a', '2026-08-27T02:00:00.000Z'),
      message('b', '2026-08-27T02:00:01.000Z'),
    ],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['a', 'b', 'local-newer'],
  );
  assert.equal(result.inserted.length, 0);
  assert.equal(result.patched.length, 0);
});

test('mergeMessages patches better fetched copies at the original position', () => {
  const local = [
    message('before', '2026-08-27T02:00:00.000Z'),
    message('shared', '2026-08-27T02:00:01.000Z', {
      truncated: true,
      content: [{ type: 'text', text: 'partial' }],
    }),
    message('after', '2026-08-27T02:00:02.000Z'),
  ];
  const result = mergeMessages({
    localMessages: local,
    incomingMessages: [message('shared', '2026-08-27T02:00:01.000Z', {
      revision: 2,
      content: [{ type: 'text', text: 'complete' }],
    })],
  });

  assert.deepEqual(result.messages.map((item) => item.uuid), ['before', 'shared', 'after']);
  assert.equal(result.messages[1].content[0].text, 'complete');
  assert.equal(result.messages[1].truncated, undefined);
  assert.equal(result.patched.length, 1);
  assert.equal(result.patched[0].index, 1);
  assert.equal(local[1].content[0].text, 'partial');
});

test('mergeMessages updates the same identity for live authority', () => {
  const local = message('shared', '2026-08-27T02:00:00.000Z', {
    content: [{
      type: 'tool_use',
      id: 'tool-shared',
      name: 'Bash',
      input: { command: '/bin/bash -lc "echo ok"' },
    }],
    _strictManaged: true,
  });
  const result = mergeMessages({
    localMessages: [local],
    replaceConflicts: true,
    incomingMessages: [message('shared', '2026-08-27T02:00:00.000Z', {
      content: [{
        type: 'tool_use',
        id: 'tool-shared',
        name: 'Bash',
        input: { command: 'echo ok' },
      }],
    })],
  });

  assert.equal(result.messages.length, 1);
  assert.equal(
    result.messages[0].content[0].input.command,
    'echo ok',
  );
  assert.equal(result.messages[0]._strictManaged, undefined);
  assert.equal(result.patched.length, 1);
  assert.equal(result.patched[0].index, 0);
  assert.equal(result.conflicts.length, 0);
});

test('mergeMessages keeps complete local content on a REST conflict', () => {
  const local = message('shared-rest-conflict', '2026-08-27T02:00:00.000Z', {
    content: [{ type: 'text', text: 'complete local content' }],
  });
  const result = mergeMessages({
    localMessages: [local],
    incomingMessages: [message(
      'shared-rest-conflict',
      '2026-08-27T02:00:00.000Z',
      {
        content: [{ type: 'text', text: 'different REST content' }],
      },
    )],
  });

  assert.equal(result.messages[0], local);
  assert.equal(result.patched.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].type, 'content-conflict');
});

test('mergeMessages never downgrades complete content with a provisional copy', () => {
  const local = message('shared-complete', '2026-08-27T02:00:00.000Z', {
    nativeId: 'codex:item:shared-complete',
    content: [{ type: 'text', text: 'complete REST content' }],
  });
  const result = mergeMessages({
    localMessages: [local],
    incomingMessages: [message(
      'shared-complete',
      '2026-08-27T02:00:00.000Z',
      {
        nativeId: 'codex:item:shared-complete',
        turnId: 'turn-shared-complete',
        content: [{
          type: 'text',
          text: 'partial WS content',
          codexProvisional: true,
        }],
      },
    )],
  });

  assert.equal(result.messages[0].content[0].text, 'complete REST content');
  assert.equal(result.messages[0].turnId, 'turn-shared-complete');
  assert.equal(result.patched.length, 0);
});

test('history recovery merges canonical interrupt identity and authoritative stopReason', () => {
  const interruptId = 'codex:turn:native-turn-1:interrupt';
  const local = [
    message('user-one', '2026-08-31T08:11:35.362Z', {
      nativeId: 'codex:user:sent-one',
      turnId: 'sent-one',
      type: 'user',
      content: 'question one',
    }),
    message(interruptId, '2026-08-31T08:11:43.910Z', {
      nativeId: interruptId,
      turnId: 'sent-one',
      type: 'user',
      content: [{ type: 'text', text: '[Request interrupted by user]' }],
    }),
    message('user-two', '2026-08-31T08:11:44.443Z', {
      nativeId: 'codex:user:sent-two',
      turnId: 'sent-two',
      type: 'user',
      content: 'question two',
    }),
    message('assistant-two', '2026-08-31T08:11:45.000Z', {
      nativeId: 'codex:item:assistant-two',
      content: [{ type: 'text', text: 'answer two' }],
    }),
  ];
  const fetched = [
    message('user-one', '2026-08-31T08:11:35.362Z', {
      nativeId: 'codex:user:sent-one',
      type: 'user',
      content: 'question one',
    }),
    message(interruptId, '2026-08-31T08:11:43.925Z', {
      nativeId: interruptId,
      type: 'user',
      content: [{ type: 'text', text: '[Request interrupted by user]' }],
    }),
    message('user-two', '2026-08-31T08:11:44.443Z', {
      nativeId: 'codex:user:sent-two',
      type: 'user',
      content: 'question two',
    }),
    message('assistant-two', '2026-08-31T08:11:45.000Z', {
      nativeId: 'codex:item:assistant-two',
      content: [{ type: 'text', text: 'answer two' }],
      stopReason: 'end_turn',
    }),
  ];

  const result = mergeMessages({
    localMessages: local,
    incomingMessages: fetched,
    authoritative: true,
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['user-one', interruptId, 'user-two', 'assistant-two'],
  );
  assert.equal(result.messages[1].turnId, 'sent-one');
  assert.equal(result.messages[3].stopReason, 'end_turn');
  assert.equal(result.messages.filter((item) => item.uuid === interruptId).length, 1);
  assert.equal(result.conflicts.length, 0);
});

test('mergeMessages preserves different UUIDs that reuse one nativeId', () => {
  const result = mergeMessages({
    localMessages: [message('local-user', '2026-08-27T02:00:00.000Z', {
      nativeId: 'codex:turn:reused:user',
      type: 'user',
      content: 'first prompt',
    })],
    incomingMessages: [message('fetched-user', '2026-08-27T02:00:01.000Z', {
      nativeId: 'codex:turn:reused:user',
      type: 'user',
      content: 'second prompt',
    })],
  });

  assert.deepEqual(
    result.messages.map((item) => item.uuid),
    ['local-user', 'fetched-user'],
  );
});

test('strict lifecycle preserves distinct UUIDs with identical content', () => {
  const shared = {
    turnId: 'turn-identical-assistants',
    _strictLifecycle: true,
    content: [{ type: 'text', text: 'same answer' }],
  };
  const result = dedupeMessages([
    message('assistant-one', '', shared),
    message('assistant-two', '', shared),
  ]);

  assert.deepEqual(
    result.map((item) => item.uuid),
    ['assistant-one', 'assistant-two'],
  );
});

test('message merging preserves legacy user messages that reuse one turn UUID', () => {
  const sharedId = 'codex:turn:turn-reused:user';
  const fetched = [{
    uuid: sharedId,
    nativeId: sharedId,
    type: 'user',
    content: 'first prompt',
    timestamp: '2026-08-31T03:22:04.523Z',
  }, {
    uuid: sharedId,
    nativeId: sharedId,
    type: 'user',
    content: 'second prompt',
    timestamp: '2026-08-31T03:22:34.496Z',
  }];

  const incoming = dedupeMessages(fetched);
  const result = mergeMessages({
    localMessages: [],
    incomingMessages: incoming,
    authoritative: true,
  });

  assert.deepEqual(
    result.messages.map((item) => item.content),
    ['first prompt', 'second prompt'],
  );
});

test('mergeMessages merges explicit aliases without creating a duplicate', () => {
  const local = message('local-user', '2026-08-27T02:00:00.000Z', {
    nativeId: 'codex:turn:turn-1:user',
    identityAliases: ['logical-user-1'],
    content: [{ type: 'text', text: 'same user prompt' }],
  });
  const result = mergeMessages({
    localMessages: [local],
    incomingMessages: [message('fetched-user', '2026-08-27T02:00:00.000Z', {
      nativeId: 'codex:user:client-1',
      identityAliases: ['logical-user-1'],
      content: [{ type: 'text', text: 'same user prompt' }],
    })],
  });

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].uuid, 'local-user');
  assert.equal(result.inserted.length, 0);
  assert.equal(result.identityUpdated.length, 1);
  assert.ok(
    result.messages[0].identityAliases.includes('uuid:fetched-user'),
  );
  assert.ok(
    result.messages[0].identityAliases.includes('native:codex:user:client-1'),
  );
});

test('mergeMessages never moves a new row before an already processed alias predecessor', () => {
  const restUser = {
    uuid: 'rest-user',
    nativeId: 'codex:user:turn-1',
    type: 'user',
    content: 'question',
  };
  const answer = {
    uuid: 'answer',
    type: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
  };
  const liveUser = {
    uuid: 'live-user',
    nativeId: 'codex:user:turn-1',
    turnId: 'turn-1',
    type: 'user',
    content: 'question',
  };

  const result = mergeMessages({
    localMessages: [],
    incomingMessages: [restUser, answer, liveUser],
  });

  assert.deepEqual(
    result.messages.map((message) => message.uuid),
    ['rest-user', 'answer'],
  );
});

test('real Codex rollout preserves every message across overlapping message batches', () => {
  const all = extractCodexMessages(
    CODEX_ROLLOUT_FIXTURE,
    '22222222-2222-4222-8222-222222222222',
  ).messages;
  const expectedOrder = all.map((item) => item.uuid);

  assert.equal(all.length, 11);
  assert.equal(
    new Set(all.map((item) => item.nativeId).filter(Boolean)).size,
    all.filter((item) => item.nativeId).length,
    'stable Codex native ids must uniquely identify each logical message',
  );

  const scenarios = [
    [all, all.slice(-4)],
    [all.slice(0, -2), all.slice(-5)],
    [all.slice(0, -1), all.slice(-1)],
    [all.slice(0, -3), all.slice(-3)],
  ];
  for (const [firstBatch, secondBatch] of scenarios) {
    const result = dedupeMessages([...firstBatch, ...secondBatch]);
    assert.deepEqual(result.map((item) => item.uuid), expectedOrder);
  }
});

test('real Codex rollout restores local prefixes, missing rows, and stale snapshots', () => {
  const all = extractCodexMessages(
    CODEX_ROLLOUT_FIXTURE,
    '22222222-2222-4222-8222-222222222222',
  ).messages;
  const expectedOrder = all.map((item) => item.uuid);
  const middle = Math.floor(all.length / 2);
  const truncatedLocal = all.map((item, index) => index === all.length - 1
    ? {
        ...item,
        truncated: true,
        content: [{ type: 'text', text: 'partial fixture preview' }],
      }
    : item);

  const scenarios = [
    [all.slice(0, -3), all],
    [all, all.slice(0, -3)],
    [all.filter((_, index) => index !== middle), all.slice(middle - 2)],
    [all, all.slice(0, -1)],
    [truncatedLocal, all.slice(-1)],
  ];
  for (const [localMessages, incomingMessages] of scenarios) {
    const result = mergeMessages({ localMessages, incomingMessages });
    assert.deepEqual(result.messages.map((item) => item.uuid), expectedOrder);
  }
});
