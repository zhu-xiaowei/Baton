import fs from 'node:fs';
import path from 'node:path';

const homes = new Map();

export function publishCodexArchiveRecords(home, records) {
  homes.set(path.resolve(home), records);
}

export function codexArchiveRecords() {
  return [...homes.values()].flatMap((records) => [...records.values()]);
}

export function codexArchiveRecord(id, filePath) {
  const matches = codexArchiveRecords().filter((record) => record.id === id);
  const record = matches.length === 1 ? matches[0] : null;
  return record && (!filePath || safeCodexArchivePath(record.home, filePath)) ? record : null;
}

export function safeCodexArchivePath(home, filePath) {
  if (typeof filePath !== 'string' || !filePath.endsWith('.jsonl')) return '';
  try {
    const root = fs.realpathSync(home);
    const resolved = fs.realpathSync(filePath);
    return resolved.startsWith(root + path.sep) && fs.statSync(resolved).isFile() ? resolved : '';
  } catch {
    return '';
  }
}
