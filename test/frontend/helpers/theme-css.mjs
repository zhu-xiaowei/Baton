import { readFileSync } from 'node:fs';

const palette = readFileSync(new URL('../../../web/css/themes/dark.css', import.meta.url), 'utf8');
const tokens = new Map(Array.from(palette.matchAll(/(--[\w-]+):\s*([^;]+);/g), match => [match[1], match[2]]));

// Existing layout regressions compare the resolved dark appearance, not token spelling.
export function readDarkStyles(file) {
  return readFileSync(file, 'utf8').replace(/var\((--[\w-]+)\)/g, (match, token) => tokens.get(token) || match);
}
