import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { catalog, DshHistoryReader } from '../../bridge/runtimes/dsh/catalog.mjs';

test('DSH logs: concatenated zstd frames become the catalog row and history rows', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-')), 'session.v4.jsonl.zstd');
  const frame = (...events) => zlib.zstdCompressSync(Buffer.from(events.map((e) => `${JSON.stringify(e)}\n`).join('')));
  fs.writeFileSync(file, Buffer.concat([frame({ type: 'session', version: 4, cwd: '/p/app' }, { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the  failing\ttests now please' }] } }),
  frame({ type: 'assistant/message', data: { message: { id: 'a1', content: [{ type: 'reasoning', text: 'hm' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }] } } },
    { type: 'tool/result', data: { message: { id: 'r1', toolCallId: 'c1', content: [{ type: 'text', text: 'fail\n[exit code: 1]' }] } } })]));
  const state = catalog.summarize(file);
  assert.equal(catalog.view({ id: 's', state }, { cwdProject: (cwd) => cwd }).preview, 'Fix the failing tests now');
  const reader = new DshHistoryReader(file, 's');
  reader.update();
  const rows = await reader.rows(0, reader.index.count);
  assert.deepEqual(rows.map((r) => [r.uuid, r.content[0].type, r.content[0].name || r.content[0].is_error]), [['u1', 'text', undefined], ['a1', 'thinking', undefined], ['a1:1', 'tool_use', 'Bash'], ['r1', 'tool_result', true]]);
  assert.equal(reader.stableLine(), 0); // the turn is still open
});
