import fs from 'fs';
import os from 'os';
import path from 'path';

export function resolveProjectPath(value = '', home = os.homedir()) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid path');
  if (value === '~') return home;
  if (/^~[/\\]/.test(value)) value = value.slice(2);
  return path.resolve(home, value || '.');
}

export function createProjectDirectory(value, home = os.homedir()) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Path cannot be empty');
  const projectPath = resolveProjectPath(value, home);
  fs.mkdirSync(projectPath, { recursive: true });
  // Native resolution also expands Windows short names, which directory listings omit.
  const realPath = fs.realpathSync.native(projectPath);
  return {
    projectPath: realPath,
    projectHash: realPath.replace(/[^a-zA-Z0-9-]/g, '-'),
    projectName: path.basename(projectPath),
  };
}
