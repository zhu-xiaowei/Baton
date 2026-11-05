import fs from 'node:fs';
import { findCodexSessionFile } from './codex-session.mjs';

// Reading status must never acquire a thread writer or start a model process.
export function readCodexModel(nativeSessionId, findFile = findCodexSessionFile) {
  const file = findFile(nativeSessionId);
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 512 * 1024);
    const bytes = Buffer.alloc(size - start);
    fs.readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.toString('utf8').split('\n');
    if (start) lines.shift();
    for (let index = lines.length - 1; index >= 0; index--) {
      let entry;
      try { entry = JSON.parse(lines[index]); } catch { continue; }
      if (entry.type !== 'turn_context' || !entry.payload?.model) continue;
      return {
        model: entry.payload.model,
        reasoningEffort: entry.payload.effort ?? entry.payload.reasoning_effort ?? null,
        source: 'last-known',
      };
    }
  } catch { /* Missing, rotated, or incomplete files have no confirmed status. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}
