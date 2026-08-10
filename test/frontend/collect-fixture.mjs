// Capture a REAL WS event sequence by driving the bridge headless pool against live CC,
// so scenarios can be checked against wire-format-faithful data. Slow (real CC turns)
// and non-deterministic (CC's wording) — use to spot-check the wire shape, not for
// routine regression (use run.mjs synthetic scenarios for that).
//
// Usage: node test/frontend/collect-fixture.mjs <out.json> [--burst]
//   default: serial sends (wait for each reply);  --burst: send all before any reply.
import { ClaudePool } from '../../bridge/headless.mjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const OUT = process.argv[2] || 'test/frontend/fixtures/ws-real.json';
const BURST = process.argv.includes('--burst');
const CWD = '/tmp/apeek-fixture-' + crypto.randomUUID().slice(0, 8);
fs.mkdirSync(CWD, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const pool = new ClaudePool();
const sid = crypto.randomUUID();
const events = [];
let clock = 0;
const push = (e) => events.push(Object.assign({ seq: ++clock }, e));

const QA = [
  ['Reply with exactly the single word: APPLE', 'APPLE'],
  ['Reply with exactly the single word: BANANA', 'BANANA'],
  ['Reply with exactly the single word: CHERRY', 'CHERRY'],
  ['Reply with exactly the single word: DELTA', 'DELTA'],
];
const expected = QA.map(([q, a]) => ({ u: q, a }));

const cb = (streamId, resolve) => ({
  onDelta: (s, chunk, sq, blockId) => push({ action: 'stream_delta', streamId: s, seq_: sq, blockId, chunk }),
  onBlockStart: (s, blockId, kind, name, sq) => push({ action: 'stream_block_start', streamId: s, blockId, kind, seq_: sq }),
  onBlockStop: (s, blockId, sq) => push({ action: 'stream_block_stop', streamId: s, blockId, seq_: sq }),
  onMessage: (s, raw) => push({ action: 'messages', streamId: s, msg: { uuid: raw.uuid, type: raw.type, content: raw.message?.content || raw.content } }),
  onResult: (s, r, finalSeq) => { push({ action: 'stream_end', streamId: s, finalSeq }); resolve(); },
  onError: (s, e) => { push({ action: 'error', streamId: s }); resolve(); },
});

function send(i) {
  const streamId = 'sid-' + i;
  push({ action: 'user_send', clientId: 'c-' + i, streamId, text: QA[i][0] });
  return new Promise((resolve) => pool.send(sid, QA[i][0], Object.assign(
    { cwd: CWD, streamId }, i === 0 ? { createId: sid } : { resumeId: sid }, cb(streamId, resolve))));
}

(async () => {
  if (BURST) { await Promise.all(QA.map((_, i) => send(i))); }
  else { for (let i = 0; i < QA.length; i++) await send(i); }
  fs.writeFileSync(OUT, JSON.stringify({ sessionId: sid, expected, events }, null, 2));
  console.log(`wrote ${events.length} events, ${expected.length} turns → ${OUT}`);
  pool.shutdownAll();
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(os.homedir(), '.claude/projects', '-' + CWD.slice(1).replace(/\//g, '-')), { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(0), 300);
})();
