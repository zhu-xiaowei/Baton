import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const source = dirname(require.resolve('pdfjs-dist/package.json'));
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../web/public/pdfjs');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'LICENSE']) {
  cpSync(resolve(source, name), resolve(target, name), { recursive: true });
}
for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
  cpSync(resolve(source, 'legacy/build', name), resolve(target, name));
}
for (const name of ['pdf_viewer.mjs', 'pdf_viewer.css', 'images']) {
  cpSync(resolve(source, 'legacy/web', name), resolve(target, name), { recursive: true });
}
