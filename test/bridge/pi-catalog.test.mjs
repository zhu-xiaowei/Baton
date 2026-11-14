import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pi from '../../bridge/pi-catalog.mjs';

test('Pi history keeps the current branch, the Baton turn id and one Edit per edit; ids after other fields count', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-')), 's.jsonl');
  const entry = (id, parentId, message) => JSON.stringify({ type: 'message', id, parentId, message });
  const edits = [{ oldText: '1', newText: 'x' }, { oldText: '2', newText: 'y' }];
  fs.writeFileSync(file, [entry('u1', null, { role: 'user', timestamp: 1, content: 'a', batonTurnId: 'T' }),
    entry('a1', 'u1', { role: 'assistant', timestamp: 2, content: [{ type: 'toolCall', id: 'c', name: 'edit', arguments: { path: 'f', edits } }] }),
    entry('r1', 'a1', { role: 'toolResult', toolCallId: 'c', content: [] }), entry('u2', null, { role: 'user', timestamp: 3, content: 'b' }),
    JSON.stringify({ type: 'custom', customType: 'x', data: {}, id: 'k1', parentId: 'u2' })].join('\n') + '\n');
  const reader = pi.history({ file });
  reader.update();
  assert.deepEqual((await reader.rows(0, 5)).map((r) => r.nativeId), ['pi:user:3']);
  assert.equal(pi.catalog.summarize(file).leaf, 'k1');
  const rows = pi.messages(file);
  assert.equal(rows[0].nativeId, 'live:user:T');
  assert.deepEqual(rows.slice(1, 3).flatMap((r) => r.content.map((b) => b.id || b.tool_use_id)), ['c#0', 'c#1', 'c#0', 'c#1']);
});
