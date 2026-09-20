import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fileIconHtml,
  fileIconName,
  fileIconSource,
} from '../../web/js/components/file-icon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('common project file types map to the vendored SVG subset', () => {
  assert.equal(fileIconName('app.ts'), 'typescript');
  assert.equal(fileIconName('component.tsx'), 'react');
  assert.equal(fileIconName('index.html'), 'html');
  assert.equal(fileIconName('README.md'), 'markdown');
  assert.equal(fileIconName('script.sh'), 'console');
  assert.equal(fileIconName('notes.txt'), 'document');
  assert.equal(fileIconName('vector.svg'), 'svg');
  assert.equal(fileIconName('photo.png'), 'image');
  assert.equal(fileIconName('photo.avif'), 'image');
  assert.equal(fileIconName('sound.mp3'), 'audio');
  assert.equal(fileIconName('movie.mkv'), 'video');
  assert.equal(fileIconName('archive.7z'), 'zip');
  for (const extension of ['doc', 'DOCX', 'docm', 'dotx', 'odt']) {
    assert.equal(fileIconName('document.' + extension), 'word');
  }
  for (const extension of ['xls', 'XLSX', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods']) {
    assert.equal(fileIconName('spreadsheet.' + extension), 'table');
  }
  for (const extension of ['ppt', 'PPTX', 'pptm', 'ppsx', 'potx', 'odp']) {
    assert.equal(fileIconName('slides.' + extension), 'powerpoint');
  }
  assert.equal(fileIconName('Cargo.toml'), 'rust');
  assert.equal(fileIconName('Dockerfile'), 'docker');
  assert.equal(fileIconName('settings.properties'), 'document');
  assert.equal(fileIconName('main.c'), 'document');
  assert.equal(fileIconName('.env'), 'document');
  assert.equal(fileIconName('env.local'), 'document');
  assert.equal(fileIconName('.env.local.example'), 'document');
  assert.equal(fileIconName('.env.production.local'), 'document');
  assert.equal(fileIconName('unknown.xyz'), '');
  assert.equal(fileIconSource('data.json'), './assets/file-icons/json.svg');
  assert.equal(fileIconSource('settings.properties'), './assets/file-icons/document.svg');
  assert.equal(fileIconSource('unknown.xyz'), '');
  assert.equal(fileIconSource('LICENSE'), './assets/file-icons/document.svg');
  assert.match(fileIconHtml('app.ts'), /class="file-type-icon"[\s\S]*typescript\.svg/);
  assert.match(fileIconHtml('unknown.xyz'), /<svg viewBox="0 0 24 24"/);
});

test('every mapped icon is a small local SVG and the list fixes its display size', () => {
  const mapped = new Set([
    'audio', 'console', 'css', 'database', 'docker', 'document', 'git', 'go',
    'html', 'image', 'java', 'javascript', 'json', 'markdown', 'pdf', 'python',
    'react', 'rust', 'svg', 'swift', 'toml', 'typescript', 'video', 'xml',
    'yaml', 'zip', 'word', 'table', 'powerpoint',
  ]);
  for (const icon of mapped) {
    const file = path.join(ROOT, 'web/public/assets/file-icons', `${icon}.svg`);
    assert.equal(fs.existsSync(file), true, icon);
    assert.ok(fs.statSync(file).size < 2048, icon);
  }
  const totalBytes = Array.from(mapped).reduce(function (total, icon) {
    return total + fs.statSync(
      path.join(ROOT, 'web/public/assets/file-icons', `${icon}.svg`),
    ).size;
  }, 0);
  assert.ok(totalBytes < 16 * 1024, totalBytes);

  const css = fs.readFileSync(path.join(ROOT, 'web/css/file-icons.css'), 'utf8');
  assert.match(
    css,
    /\.file-type-icon \{[\s\S]*?width: 18px;[\s\S]*?height: 18px;/,
  );
});
