import { FILE_ICON_SVG } from './icons.js';

const ICON_ROOT = './assets/file-icons/';

const CATEGORY_EXTENSIONS = Object.freeze({
  word: new Set(['doc', 'docx', 'docm', 'dot', 'dotx', 'dotm', 'rtf', 'odt']),
  table: new Set(['xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm', 'csv', 'tsv', 'ods']),
  powerpoint: new Set(['ppt', 'pptx', 'pptm', 'pot', 'potx', 'potm', 'pps', 'ppsx', 'ppsm', 'odp']),
  audio: new Set(['aac', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav']),
  image: new Set([
    'avif', 'bmp', 'gif', 'heic', 'heif', 'icns', 'ico', 'jpeg', 'jpg',
    'png', 'tif', 'tiff', 'webp',
  ]),
  video: new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'ogv', 'webm']),
  zip: new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip']),
});

const TEXT_EXTENSIONS = new Set([
  'c', 'cc', 'cfg', 'conf', 'config', 'cpp', 'cs', 'cxx', 'dart', 'editorconfig',
  'env', 'example', 'gql', 'graphql', 'h', 'hpp', 'ini', 'lua', 'm', 'mm',
  'php', 'pl', 'prisma', 'properties', 'proto', 'r', 'rb', 'svelte', 'tf',
  'tfvars', 'vue', 'zig',
]);

const FILE_NAMES = Object.freeze({
  '.bashrc': 'console',
  '.bash_profile': 'console',
  '.gitattributes': 'git',
  '.gitignore': 'git',
  '.gitmodules': 'git',
  '.editorconfig': 'document',
  '.env': 'document',
  '.env.example': 'document',
  '.zprofile': 'console',
  '.zshrc': 'console',
  'cargo.lock': 'rust',
  'cargo.toml': 'rust',
  'authors': 'document',
  'changelog': 'document',
  'changelog.md': 'markdown',
  'contributors': 'document',
  'copying': 'document',
  'dockerfile': 'docker',
  'go.mod': 'go',
  'go.sum': 'go',
  'license': 'document',
  'makefile': 'document',
  'notice': 'document',
  'package-lock.json': 'json',
  'package.json': 'json',
  'readme.md': 'markdown',
  'tsconfig.json': 'typescript',
});

const EXTENSIONS = Object.freeze({
  bash: 'console',
  bat: 'console',
  cjs: 'javascript',
  cmd: 'console',
  css: 'css',
  db: 'database',
  go: 'go',
  gradle: 'java',
  gz: 'zip',
  htm: 'html',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsonl: 'json',
  jsx: 'react',
  kt: 'java',
  kts: 'java',
  less: 'css',
  log: 'document',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  pdf: 'pdf',
  ps1: 'console',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  sass: 'css',
  scss: 'css',
  sh: 'console',
  sql: 'database',
  sqlite: 'database',
  svg: 'svg',
  swift: 'swift',
  text: 'document',
  txt: 'document',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'react',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'console',
});

export function fileIconName(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  if (normalized === '.env'
    || normalized.startsWith('.env.')
    || normalized.startsWith('env.')) {
    return 'document';
  }
  if (FILE_NAMES[normalized]) return FILE_NAMES[normalized];
  const dot = normalized.lastIndexOf('.');
  if (dot < 0 || dot === normalized.length - 1) return '';
  const extension = normalized.slice(dot + 1);
  if (EXTENSIONS[extension]) return EXTENSIONS[extension];
  for (const [icon, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (extensions.has(extension)) return icon;
  }
  if (TEXT_EXTENSIONS.has(extension)) return 'document';
  return '';
}

export function fileIconSource(fileName) {
  const icon = fileIconName(fileName);
  return icon ? `${ICON_ROOT}${icon}.svg` : '';
}

export function fileIconHtml(fileName) {
  const source = fileIconSource(fileName);
  return source
    ? '<img class="file-type-icon" src="' + source
      + '" alt="" aria-hidden="true" decoding="async">'
    : FILE_ICON_SVG;
}
