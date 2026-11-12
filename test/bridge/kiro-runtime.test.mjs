import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('kiro: turn ids become nativeIds, Kiro steering rows hide, a live lease with an open approval needs input', async () => {
  const home = process.env.KIRO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-kiro-'));
  const dir = path.join(home, 'sessions/0123456789abcdef/sess_1');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(home, 'session-leases'));
  fs.writeFileSync(path.join(home, 'session-leases/sess_1.lease'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ title: 'New Session', workspacePaths: [home] }));
  const line = (id, payload) => JSON.stringify({ id, timestamp: '2026-11-12T00:00:00.000Z', payload });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), [line('u1', { type: 'user', content: 'Hi\nmore', _meta: { kiro: { userMessageTag: 'T1' } } }),
    line('T1x-turn-start', { type: 'turn_start', executionId: 'x', userMessageTag: 'T1' }), line('steer-T2', { type: 'user', content: 'also', source: 'steer' }),
    line('s1', { type: 'user', content: '[LIVE STEERING …]', _meta: { kiro: { syntheticUserMessageReason: 'steering-injection' } } }),
    line('a1-say', { type: 'assistant', operationType: 'Say', content: 'ok [STEERING steer-T2: done] STEERED' }),
    line('x-turn-end', { type: 'turn_end', stopReason: 'cancelled', executionId: 'x' }), line('p', { type: 'pending_interaction', question: 'rm' }), ''].join('\n'));
  const { default: kiro, KiroReader } = await import('../../bridge/kiro.mjs');
  const rec = { file: path.join(dir, 'messages.jsonl'), id: 'sess_1', ms: Date.now(), state: kiro.catalog.summarize(path.join(dir, 'messages.jsonl'), 'sess_1') };
  assert.equal(kiro.catalog.view(rec, { cwdProject: () => 'p' }).preview, 'Hi');
  assert.equal(kiro.catalog.status(rec, kiro.catalog.running(), Date.now()), 'needs_input');
  const reader = new KiroReader(rec.file);
  reader.update();
  assert.deepEqual((await reader.rows(0, reader.index.count)).map((r) => [r.nativeId, r.content[0].text]), [['live:user:T1', 'Hi\nmore'],
    ['live:user:T2', 'also'], [undefined, 'ok STEERED'], ['live:interrupt:T1', '[Request interrupted by user]']]);
});
