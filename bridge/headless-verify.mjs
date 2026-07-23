// Step 0 standalone verification for headless.mjs ClaudePool.
// No ws/server/frontend — drives the pool directly against a temp cwd and
// prints per-line arrival so you can eyeball delta streaming, result收尾,
// context持久, multi-turn queue, and interrupt.
//
// Usage: node headless-verify.mjs [cwd]
//   cwd defaults to a fresh /tmp dir. Uses a NEW session (no --resume) so it's
//   safe to run repeatedly.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { ClaudePool } from './headless.mjs';

const cwd = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'hlverify-'));
console.log(`[verify] cwd=${cwd}`);

const pool = new ClaudePool();
const t0 = Date.now();
const log = (m) => console.log(`+${Date.now() - t0}ms ${m}`);

const KEY = 'verify-' + process.pid; // temp pool key for a new session

function turn(text, streamId) {
  return new Promise((resolve) => {
    let acc = '';
    log(`>>> send: ${JSON.stringify(text)}`);
    pool.send(KEY, text, {
      cwd,
      streamId,
      onDelta: (sid, delta) => { acc += delta; process.stdout.write(delta); },
      onResult: (sid, result) => {
        process.stdout.write('\n');
        log(`<<< result subtype=${result.subtype} is_error=${result.is_error} accLen=${acc.length} sessionId=${result.session_id?.slice(0, 8)}`);
        resolve({ acc, result });
      },
      onControlRequest: (req) => {
        log(`[control_request] tool=${req.request?.tool_name} requires_user_interaction=${req.request?.requires_user_interaction}`);
        // Auto-allow普通工具 for this smoke test (no interactive tools expected here)
        pool.replyControl(KEY, req.request_id, { behavior: 'allow', updatedInput: req.request?.input });
      },
      onError: (sid, err) => { log(`[ERROR] code=${err.code} detail=${err.detail}`); resolve({ error: err }); },
    });
  });
}

(async () => {
  // Turn 1: establish context
  await turn('Remember the number 42. Reply with just OK.', 's1');
  // Turn 2: verify context persists (same process, same session)
  const r2 = await turn('What number did I ask you to remember? Reply with just the number.', 's2');
  const ctxOk = /42/.test(r2.acc || '');
  log(`[CHECK] context persisted across turns: ${ctxOk ? '✅' : '❌'}`);

  // Verify pool state: one live proc, sessionId resolved
  const [proc] = pool.procs.values();
  log(`[CHECK] pool size=${pool.procs.size} sessionId=${proc?.sessionId?.slice(0, 8)} busy=${proc?.busy}`);

  // Verify jsonl landed (find the session file under any project hash)
  const sid = proc?.sessionId;
  let jsonlFound = false;
  if (sid) {
    const projects = path.join(os.homedir(), '.claude', 'projects');
    try {
      for (const dir of fs.readdirSync(projects)) {
        if (fs.existsSync(path.join(projects, dir, sid + '.jsonl'))) { jsonlFound = true; break; }
      }
    } catch {}
  }
  log(`[CHECK] jsonl landed for session: ${jsonlFound ? '✅' : '❌'}`);

  pool.shutdownAll();
  log('[verify] done, pool shut down');
  setTimeout(() => process.exit(0), 500);
})();
