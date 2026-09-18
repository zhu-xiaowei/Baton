import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodexArchive } from '../../../bridge/codex-archive.mjs';
import { createCodexArchiveSync } from '../../../bridge/codex-archive-sync.mjs';

export async function statusSyncFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-status-roundtrip-'));
  const target = '01a0a040-cc5d-7a61-b546-e8764fed17db';
  const active = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const children = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-9000-${String(i + 1).padStart(12, '0')}`);
  const rows = [];
  for (const id of [...active, target, ...children]) {
    const archived = !active.includes(id);
    const dir = path.join(home, archived ? 'archived_sessions' : 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `rollout-2026-09-18T00-00-00-${id}.jsonl`);
    const parent = children.includes(id) ? target : '';
    const entries = [
      { type: 'session_meta', payload: {
        id, cwd: '/tmp/baton-status-regression', source: 'vscode',
        ...(parent ? { parent_thread_id: parent } : {}),
      } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: id } },
      { type: 'event_msg', payload: { type: 'user_message', message: archived ? 'Archived regression task' : 'Active regression task' } },
      ...(archived ? [{ type: 'event_msg', payload: { type: 'task_complete', turn_id: id } }] : []),
    ];
    fs.writeFileSync(file, entries.map((entry) => JSON.stringify({
      timestamp: '2026-09-18T00:00:00.000Z', ...entry,
    })).join('\n') + '\n');
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(file, old, old);
    rows.push({ id, path: file, cwd: '/tmp/baton-status-regression', archived,
      status: archived ? { type: 'notLoaded' } : { type: 'active', activeFlags: [] } });
  }
  const calls = [];
  const client = new EventEmitter();
  client.socketTransport = { writable: true };
  client.start = async () => {};
  client.stop = async () => {};
  client.request = async (method, params) => {
    assert.equal(method, 'thread/list', 'Observation must not resume, interrupt, or mutate native tasks');
    const found = rows.filter((row) => row.archived === params.archived);
    const offset = Number(params.cursor || 0);
    return { data: found.slice(offset, offset + 3), nextCursor: offset + 3 < found.length ? String(offset + 3) : null };
  };
  const archive = new CodexArchive({
    homes: [home], stateFile: path.join(home, 'observations.json'),
    clientFactory: () => client, probe: async () => ({ supported: true }),
    sync: createCodexArchiveSync({ deviceName: 'local-regression' }, async (endpoint, body) => {
      calls.push({ endpoint, body: structuredClone(body) });
      return { json: async () => ({ acknowledged: body.observations || [] }) };
    }),
  });
  try {
    await archive.start();
    return { target, active, children, calls, project: calls[0].body.sessions[0].project };
  } finally {
    await archive.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await statusSyncFixture()));
}
