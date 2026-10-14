import { state } from '../state.js';

export function currentProjectHash() {
  return state.appState.project?.hash || state.wsProjectHash || '';
}

// Return only relative paths: the Bridge validates their real path stays inside the project.
export function relativeProjectImagePath(filePath, projectHash) {
  const normalized = String(filePath || '').replaceAll('\\', '/');
  if (!normalized || /[\x00-\x1f]/.test(normalized)
    || normalized.split('/').includes('..')) return null;
  if (!/^(?:\/|[a-z]:\/)/i.test(normalized)) return normalized.replace(/^(\.\/)+/, '');
  const parts = normalized.split('/');
  for (let length = parts.length - 1; length > 0; length--) {
    const directory = parts.slice(0, length).join('/') || '/';
    const candidates = [directory];
    if (/^[a-z]:/i.test(directory)) {
      candidates.push(directory[0].toUpperCase() + directory.slice(1));
      candidates.push(directory[0].toUpperCase() + directory.slice(2));
    }
    if (candidates.some(path => path.replace(/[^a-zA-Z0-9-]/g, '-') === projectHash)) {
      return parts.slice(length).join('/');
    }
  }
  return null;
}
