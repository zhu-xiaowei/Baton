import fs from 'fs';
import path from 'path';

export function normalizeRuntime(runtime) {
  return runtime === 'codex' ? 'codex' : 'claude';
}

export function storageSessionId(runtime, nativeSessionId) {
  runtime = normalizeRuntime(runtime);
  const native = String(nativeSessionId || '');
  if (runtime === 'codex') return native.startsWith('codex:') ? native : `codex:${native}`;
  return native;
}

export function parseStorageSessionId(sessionId, runtimeHint) {
  const value = String(sessionId || '');
  if (runtimeHint === 'codex' || value.startsWith('codex:')) {
    return {
      runtime: 'codex',
      nativeSessionId: value.startsWith('codex:') ? value.slice('codex:'.length) : value,
      sessionId: value.startsWith('codex:') ? value : `codex:${value}`,
    };
  }
  return { runtime: 'claude', nativeSessionId: value, sessionId: value };
}

export function normalizeProjectHash(hash) {
  return String(hash || '').replace(/--claude-worktrees-.*$/, '');
}

function hashPath(value) {
  return value.replace(/[^a-zA-Z0-9-]/g, '-');
}

function windowsPathCandidates(cwd) {
  const normalized = path.win32.normalize(cwd.replace(/\//g, '\\'));
  const drive = normalized.slice(0, 1).toUpperCase();
  const rest = normalized.slice(2).replace(/\\/g, '/');
  // Prefer an existing canonical or literal Windows drive hash.
  return [
    normalizeProjectHash(hashPath(`${drive}${rest}`)),
    normalizeProjectHash(hashPath(`${drive}:${rest}`)),
  ];
}

export function projectHashCandidatesFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return [];
  if (/^[a-zA-Z]:[\\/]/.test(cwd)) return [...new Set(windowsPathCandidates(cwd))];
  return [normalizeProjectHash(hashPath(path.resolve(cwd)))];
}

export function projectHashFromCwd(cwd, claudeProjectsRoot) {
  const candidates = projectHashCandidatesFromCwd(cwd);
  if (!candidates.length) return '';
  if (claudeProjectsRoot) {
    for (const candidate of candidates) {
      try {
        if (fs.statSync(path.join(claudeProjectsRoot, candidate)).isDirectory()) return candidate;
      } catch {}
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(cwd) && candidates.length > 1) return candidates[1];
  return candidates[0];
}
