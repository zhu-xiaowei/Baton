import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const modulesRoot = fileURLToPath(new URL('./node_modules/', import.meta.url));

for (const name of Object.keys(packageJson.dependencies || {})) {
  const resolved = import.meta.resolve(name);
  const resolvedPath = fileURLToPath(resolved);
  const relative = path.relative(modulesRoot, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${name} resolved outside the staged node_modules directory`);
  }
  await import(resolved);
}
