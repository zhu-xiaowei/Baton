import fs from 'node:fs';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
for (const name of Object.keys(packageJson.dependencies || {})) await import(name);
