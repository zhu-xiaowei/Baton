import fs from 'node:fs';
import path from 'node:path';
import { scanJsonlLines } from './jsonl.mjs';
import { codexSessionIdFromPath } from './codex-session.mjs';
import { safeCodexArchivePath } from './codex-archive-index.mjs';

export function readCodexArchiveTree(home, records) {
  const files = new Set();
  function walk(directory) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Cannot verify a linked Codex rollout directory.');
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.add(file);
    }
  }
  walk(path.join(home, 'sessions'));
  walk(path.join(home, 'archived_sessions'));
  for (const record of records.values()) {
    const file = safeCodexArchivePath(home, record.path);
    if (file) files.add(file);
  }
  const tree = new Map(records);
  for (const file of files) {
    const id = codexSessionIdFromPath(file);
    if (!id || !safeCodexArchivePath(home, file)) throw new Error('Cannot verify a Codex rollout identity.');
    let metadata;
    const found = {};
    try {
      scanJsonlLines(file, (line) => {
        let entry;
        try { entry = JSON.parse(line); } catch { return; }
        if (entry.type === 'session_meta' && (entry.payload?.id || entry.payload?.session_id) === id) {
          metadata = entry.payload;
          throw found;
        }
      });
    } catch (error) {
      if (error !== found) throw error;
    }
    if (!metadata) throw new Error('Cannot verify Codex rollout ancestry.');
    const parentThreadId = String(metadata.parent_thread_id
      || metadata.source?.subagent?.thread_spawn?.parent_thread_id || '');
    const previous = tree.get(id);
    if (previous && previous.parentThreadId && previous.parentThreadId !== parentThreadId) {
      throw new Error('Codex rollout ancestry conflicts with the native catalog.');
    }
    tree.set(id, {
      id, home, archiveState: 'unknown', available: false,
      ...previous,
      parentThreadId: parentThreadId || previous?.parentThreadId || '',
    });
  }
  return tree;
}
