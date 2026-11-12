import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pi from '../../bridge/pi-catalog.mjs';

const line = (type, id, parentId, message) => JSON.stringify({ type, id, parentId, timestamp: '2026-11-12T00:00:00.000Z', message });

test('Pi history keeps the current branch, a Baton turn id and one Edit per edit', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-')), 's.jsonl');
  const edit = { role: 'assistant', timestamp: 2, content: [{ type: 'toolCall', id: 'c', name: 'edit', arguments: { path: 'a', edits: [{ oldText: '1', newText: 'x' }, { oldText: '2', newText: 'y' }] } }] };
  fs.writeFileSync(file, [JSON.stringify({ type: 'session', id: 's', cwd: '/w' }), line('message', 'u1', null, { role: 'user', timestamp: 1, content: 'old', batonTurnId: 'T' }),
    line('message', 'a1', 'u1', edit), line('message', 'r1', 'a1', { role: 'toolResult', toolCallId: 'c', content: [{ type: 'text', text: 'ok' }] }),
    line('message', 'u2', null, { role: 'user', timestamp: 3, content: 'branch' })].join('\n') + '\n');
  const reader = pi.history({ file });
  reader.update();
  assert.deepEqual((await reader.rows(0, 5)).map((r) => r.nativeId), ['pi:user:3']);
  assert.notEqual(reader.epoch.split('.').pop(), '0');
  const rows = pi.messages(file);
  assert.equal(rows[0].nativeId, 'live:user:T');
  assert.deepEqual(rows.slice(1, 3).flatMap((r) => r.content.map((b) => b.id || b.tool_use_id)), ['c#0', 'c#1', 'c#0', 'c#1']);
});
