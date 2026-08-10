import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  buildCatalogAggregates,
  isRecentSession,
  knownProjects,
  lastKnownStatus,
  recentSessions,
  syncSessions,
  uploadCatalog,
} from '../../bridge/sync.mjs';
import { synced } from '../../bridge/extract.mjs';

const CODEX_FIXTURE = fileURLToPath(new URL(
  '../codex/phase1/fixtures/codex/rollout-2026-08-06T00-00-00-22222222-2222-4222-8222-222222222222.jsonl',
  import.meta.url,
));

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

test('mixed runtime catalog aggregates into the same project', () => {
  const capabilities = { claude: { canRead: true }, codex: { canRead: true } };
  const aggregates = buildCatalogAggregates([
    session(1, 'claude'),
    session(2, 'codex'),
    session(3, 'codex', '-other'),
  ], capabilities);
  assert.equal(aggregates.deviceAggregate.sessionCount, 3);
  assert.equal(aggregates.deviceAggregate.projectCount, 2);
  assert.equal(aggregates.deviceAggregate.runningCount, 1);
  assert.equal(aggregates.deviceAggregate.runtimeCapabilities, capabilities);
  assert.equal(aggregates.projectAggregates.find((p) => p.projectHash === '-repo').sessionCount, 2);
});

test('catalog batching sends authoritative aggregates only in the first request', async () => {
  const sessions = Array.from({ length: 5001 }, (_, index) => session(index));
  const aggregates = buildCatalogAggregates(sessions);
  const requests = [];
  await uploadCatalog(
    { deviceName: 'Mac' },
    sessions,
    aggregates,
    true,
    async (url, body) => requests.push({ url, body }),
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.sessions.length, 5000);
  assert.ok(requests[0].body.device);
  assert.ok(requests[0].body.projects);
  assert.equal(requests[1].body.sessions.length, 1);
  assert.equal(requests[1].body.device, undefined);
  assert.equal(requests[1].body.projects, undefined);
  assert.equal(requests[0].body.sessions[0]._filePath, undefined);
});

test('incomplete discovery uploads sessions without overwriting aggregates', async () => {
  const requests = [];
  await uploadCatalog(
    { deviceName: 'Mac' },
    [session(1, 'codex')],
    buildCatalogAggregates([session(1, 'codex')]),
    false,
    async (_url, body) => requests.push(body),
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].device, undefined);
  assert.equal(requests[0].projects, undefined);
});

test('24-hour cutoff includes the boundary and future timestamps', () => {
  const now = Date.parse('2026-08-06T12:00:00.000Z');
  assert.equal(isRecentSession('2026-08-05T11:59:59.999Z', now), false);
  assert.equal(isRecentSession('2026-08-05T12:00:00.000Z', now), true);
  assert.equal(isRecentSession('2026-08-06T12:01:00.000Z', now), true);
});

test('startup accepts Claude-only, Codex-only, mixed, and empty catalogs', async () => {
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
    knownProjects.clear();
    let aggregate;
    let messageUploads = 0;
    const result = await syncSessions({ deviceName: 'test' }, {
      skipMessages: true,
      runtimeCatalogs: {
        claude: { sessions: item.claude, complete: true },
        codex: {
          sessions: item.codex,
          complete: true,
          diagnostics: { files: item.codex.length, errors: [], malformedLines: 0 },
        },
      },
      runtimeCapabilities: { claude: {}, codex: {} },
      postFn: async (_url, body) => { if (body.device) aggregate = body.device; },
      messageUploader: async () => { messageUploads++; },
    });
    assert.equal(result.sessions.length, item.expected);
    assert.equal(aggregate.sessionCount, item.expected);
    assert.equal(messageUploads, 0);
    assert.equal(result.messageCount, 0);
    assert.equal(synced.size, item.expected);
    assert.equal(recentSessions.size, item.expected);
  }
});

test('startup reports messages written during recovery', async () => {
  synced.clear();
  recentSessions.clear();
  lastKnownStatus.clear();
  knownProjects.clear();
  const recovered = {
    ...session(1, 'codex'),
    id: '22222222-2222-4222-8222-222222222222',
    nativeSessionId: '22222222-2222-4222-8222-222222222222',
    lastActive: '2026-08-06T00:00:10.000Z',
    _filePath: CODEX_FIXTURE,
  };
  let uploaded = 0;

  const result = await syncSessions({ deviceName: 'test' }, {
    now: Date.parse('2026-08-06T00:00:20.000Z'),
    runtimeCatalogs: {
      claude: { sessions: [], complete: true },
      codex: {
        sessions: [recovered],
        complete: true,
        diagnostics: { files: 1, errors: [], malformedLines: 0 },
      },
    },
    runtimeCapabilities: { claude: {}, codex: {} },
    postFn: async () => {},
    messageUploader: async (_sessionId, messages) => { uploaded += messages.length; },
  });

  assert.ok(uploaded > 0);
  assert.equal(result.messageCount, uploaded);
});
