import fs from 'fs';
import path from 'path';
import { projectCwdFromCwd } from './repository-identity.mjs';

// Runtimes beyond claude/codex, registered through runtime-registry.mjs (and again in workers).
const descriptors = new Map();

export function registerRuntimeDescriptor(descriptor) {
  descriptors.set(descriptor.runtime, descriptor);
}

export const runtimeDescriptor = (runtime) => descriptors.get(runtime);
export const runtimeDescriptors = () => [...descriptors.values()];
// Modules a worker imports so its descriptors match this thread's.
export const runtimeModules = () => runtimeDescriptors().map((d) => d.module).filter(Boolean);

export async function loadRuntimeModules(urls = []) {
  for (const url of urls) registerRuntimeDescriptor((await import(url)).default);
}

// A missing runtime is claude (unprefixed ids); an unknown one is null, never claude.
export function normalizeRuntime(runtime) {
  if (!runtime || runtime === 'claude') return 'claude';
  return runtime === 'codex' || descriptors.has(runtime) ? runtime : null;
}

export function storageSessionId(runtime, nativeSessionId) {
  const native = String(nativeSessionId || '');
  if (!runtime || runtime === 'claude') return native;
  return native.startsWith(`${runtime}:`) ? native : `${runtime}:${native}`;
}

export function parseStorageSessionId(sessionId, runtimeHint) {
  const value = String(sessionId || '');
  const prefix = value.slice(0, Math.max(0, value.indexOf(':')));
  const runtime = prefix && prefix !== 'claude' && normalizeRuntime(prefix) ? prefix : runtimeHint || 'claude';
  if (runtime === 'claude') return { runtime, nativeSessionId: value, sessionId: value };
  const nativeSessionId = value.startsWith(`${runtime}:`) ? value.slice(runtime.length + 1) : value;
  return { runtime, nativeSessionId, sessionId: `${runtime}:${nativeSessionId}` };
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
  cwd = projectCwdFromCwd(cwd);
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
