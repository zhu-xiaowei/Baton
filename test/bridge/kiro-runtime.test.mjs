import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// One Kiro home for the file (kiro.mjs reads KIRO_HOME on import), so each test also runs alone.
const home = process.env.KIRO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-kiro-'));
const file = path.join(home, 'sessions/0123456789abcdef/s/messages.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.mkdirSync(path.join(home, 'session-leases'));
fs.writeFileSync(path.join(home, 'session-leases/s.lease'), JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
fs.writeFileSync(path.join(path.dirname(file), 'session.json'), JSON.stringify({ workspacePaths: [home] }));
const rows = [['u', 'user', { content: 'Hi', _meta: { kiro: { userMessageTag: 'T1' } } }], ['x', 'turn_start', { executionId: 'x', userMessageTag: 'T1' }],
  ['steer-T2', 'user', { content: 'also' }], ['i', 'user', { content: '[LIVE STEERING]', _meta: { kiro: { syntheticUserMessageReason: 'steering-injection' } } }],
  ['a-say', 'assistant', { operationType: 'Say', content: 'ok [STEERING steer-T2: done] X' }], ['e', 'turn_end', { stopReason: 'cancelled', executionId: 'x' }], ['p', 'pending_interaction', {}]];
fs.writeFileSync(file, rows.map(([id, type, p]) => `${JSON.stringify({ id, timestamp: '', payload: { type, ...p } })}\n`).join(''));

test('kiro: Baton turn ids become nativeIds, steering rows hide, an open approval under a live lease needs input', async () => {
  const { default: kiro, KiroReader } = await import('../../bridge/kiro.mjs');
  assert.equal(kiro.catalog.status({ file, id: 's', state: kiro.catalog.summarize(file, 's') }, kiro.catalog.running()), 'needs_input');
  const reader = new KiroReader(file);
  reader.update();
  assert.deepEqual((await reader.rows(0, 7)).map((r) => [r.nativeId, r.content[0].text]), [['live:user:T1', 'Hi'], ['live:user:T2', 'also'],
    [undefined, 'ok X'], ['live:interrupt:T1', '[Request interrupted by user]']]);
});

test('kiro: a watcher error (a dir gone mid-scan) is handled and the watch is armed again', async (t) => {
  const opened = [];
  const watch = fs.watch;
  fs.watch = (...args) => { const w = watch(...args); opened.push(Object.assign(w, { recursive: !!args[1]?.recursive })); return w; };
  const { default: kiro } = await import('../../bridge/kiro-runtime.mjs');
  kiro.watcher.start(null);
  t.after(() => { fs.watch = watch; kiroWatches().forEach((w) => w.close()); });
  const kiroWatches = () => opened.filter((w) => w.listenerCount('error')); // not Node's per-dir inner watchers
  kiroWatches().find((w) => w.recursive).emit('error', Object.assign(new Error('ENOENT: scandir .lock.acquire'), { code: 'ENOENT' }));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(kiroWatches().filter((w) => w.recursive).length, 2); // sessions/, then its replacement
});

test('kiro: rename is refused while another client holds the session', async () => {
  const [{ default: kiro }, { sessionIndex }, { registerRuntime }] = await Promise.all(['kiro-runtime', 'session-index', 'runtime-registry']
    .map((name) => import(`../../bridge/${name}.mjs`)));
  registerRuntime(kiro);
  sessionIndex.touch(file);
  await assert.rejects(kiro.rename('s', 'New', sessionIndex.view(sessionIndex.records.get(file)).project), /in use/);
});
