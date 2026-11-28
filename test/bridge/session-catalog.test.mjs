import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lastKnownStatus,
  recentSessions,
  syncSessions,
} from '../../bridge/sync.mjs';
import { synced } from '../../bridge/extract.mjs';
import {
  rebuildAgentCounts,
  trackAgentSession,
} from '../../bridge/agent-counts.mjs';

function session(index, runtime = 'claude', project = '-repo') {
  const id = String(index).padStart(4, '0');
  return {
    id,
    nativeSessionId: id,
    runtime,
    project,
    projectName: 'repo',
    lastActive: `2026-08-06T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
    status: index % 3 === 0 ? 'running' : 'completed',
    _filePath: `/private/${id}.jsonl`,
    _lineCount: 10,
  };
}

test('agent count tracking overwrites exact Set size across duplicates and internal migration', () => {
  const root = session(1, 'codex');
  const first = {
    ...session(2, 'codex'),
    parentSessionId: 'codex:0001',
    threadKind: 'subagent',
  };
  const second = {
    ...session(3, 'codex'),
    parentSessionId: 'codex:0001',
    threadKind: 'subagent',
  };
  const guardian = {
    ...session(4, 'codex'),
    parentSessionId: 'codex:0001',
    threadKind: 'internal',
  };
  const grandchild = {
    ...session(5, 'codex'),
    parentSessionId: 'codex:0002',
    threadKind: 'subagent',
  };

  rebuildAgentCounts([root, first, second, guardian, grandchild]);
  assert.equal(root.agentCount, 3);
  assert.equal(root.runningAgentCount, 1);
  assert.equal(root.needsInputAgentCount, 0);
  assert.equal(root.activeStatus, 'running');
  assert.equal(root.threadRootId, 'codex:0001');
  assert.equal(first.threadRootId, 'codex:0001');
  assert.equal(grandchild.threadRootId, 'codex:0001');
  assert.equal(guardian.threadRootId, '');
  assert.deepEqual(trackAgentSession(first), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 3,
    runningAgentCount: 1,
    needsInputAgentCount: 0,
    activeStatus: 'running',
  }]);
  assert.deepEqual(trackAgentSession(grandchild), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 3,
    runningAgentCount: 1,
    needsInputAgentCount: 0,
    activeStatus: 'running',
  }]);
  assert.deepEqual(trackAgentSession({ ...second, status: 'completed' }), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 3,
    runningAgentCount: 0,
    needsInputAgentCount: 0,
    activeStatus: 'completed',
  }]);
  assert.deepEqual(trackAgentSession({ ...grandchild, status: 'needs_input' }), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 3,
    runningAgentCount: 0,
    needsInputAgentCount: 1,
    activeStatus: 'needs_input',
  }]);
  assert.deepEqual(trackAgentSession({ ...first, threadKind: 'internal' }), [{
    sessionId: 'codex:0001',
    project: '-repo',
    agentCount: 1,
    runningAgentCount: 0,
    needsInputAgentCount: 0,
    activeStatus: 'completed',
  }]);
  assert.deepEqual(trackAgentSession(guardian), []);
});

test('startup reads every catalog and starts each Session at the end of its file', async () => {
  const cases = [
    { claude: [session(1, 'claude')], codex: [], expected: 1 },
    { claude: [], codex: [session(2, 'codex')], expected: 1 },
    { claude: [session(3, 'claude')], codex: [session(4, 'codex')], expected: 2 },
    { claude: [], codex: [], expected: 0 },
  ];
  for (const item of cases) {
    synced.clear();
    recentSessions.clear();
    lastKnownStatus.clear();
    const result = syncSessions({ deviceName: 'test' }, {
      runtimeCatalogs: {
        claude: { sessions: item.claude, complete: true },
        codex: {
          sessions: item.codex,
          complete: true,
          diagnostics: { files: item.codex.length, errors: [], malformedLines: 0 },
        },
      },
    });
    assert.equal(result.sessions.length, item.expected);
    assert.equal(synced.size, item.expected);
    for (const s of [...item.claude, ...item.codex]) assert.equal(synced.get(s.runtime === 'codex' ? `codex:${s.id}` : s.id), 10);
    assert.equal(recentSessions.size, item.expected);
  }
});
