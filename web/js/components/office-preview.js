// Word, PowerPoint and Excel previews with @silurus/ooxml (Rust/WASM parsers, canvas rendering), loaded on
// demand from jsDelivr like PDF.js and Mermaid. Read-only; legacy .doc/.ppt/.xls go through the
// experimental companion readers into the same viewers.
import { attachPinchZoom } from './pdf-pinch.js';

// The companion must match the viewer version exactly.
const OOXML_VERSION = '0.89.0';
const OOXML_CDN = `https://cdn.jsdelivr.net/npm/@silurus/ooxml@${OOXML_VERSION}/dist/`;
const LEGACY_CDN = `https://cdn.jsdelivr.net/npm/@silurus/ooxml-legacy-office@${OOXML_VERSION}/dist/`;
const VIEWERS = { docx: 'DocxScrollViewer', pptx: 'PptxScrollViewer', xlsx: 'XlsxViewer' };
const LEGACY = { doc: 'docx', ppt: 'pptx', xls: 'xlsx' };
const modules = new Map();

// Replaceable in tests, where the CDN is not reachable. The companion entry imports the viewer package
// by name, which only jsDelivr's +esm build resolves; its worker module and WASM are passed explicitly.
export const ooxml = {
  load: kind => import(/* @vite-ignore */ OOXML_CDN + kind + '.mjs'),
  loadLegacy: format => import(/* @vite-ignore */ LEGACY_CDN + format + '.mjs/+esm'),
};

export function officeKind(name) {
  return /\.(docx|pptx|xlsx|doc|ppt|xls)$/i.exec(name || '')?.[1].toLowerCase() || '';
}

async function loadModules(kind) {
  const target = LEGACY[kind];
  if (!target) return { mod: await ooxml.load(kind), options: {} };
  const name = kind[0].toUpperCase() + kind.slice(1);
  const [mod, legacy] = await Promise.all([ooxml.load(target), ooxml.loadLegacy(kind)]);
  const source = legacy['createLegacy' + name]({
    wasmUrl: LEGACY_CDN + `legacy_${kind}_direct_bg.wasm`,
    moduleUrl: LEGACY_CDN + `legacy-${kind}-source-module.mjs`,
  });
  return { mod, options: { ['legacy' + name]: source } };
}

export function loadOfficeViewer(kind) {
  if (!modules.has(kind)) {
    modules.set(kind, loadModules(kind).catch(error => {
      modules.delete(kind);
      throw new Error('Failed to load the document viewer', { cause: error });
    }));
  }
  return modules.get(kind);
}

// Renders behind the current loading indicator, which is removed once the first content is visible.
// Returns at once so the caller can destroy a preview that is still loading. `source` is a URL, an
// ArrayBuffer, or a promise of either, so the file can download while the viewer module loads.
export async function mountOfficePreview(body, source, kind) {
  const { mod, options } = await loadOfficeViewer(kind);
  const viewerKind = LEGACY[kind] || kind;
  const loading = body.querySelector('.file-loading');
  const host = document.createElement('div');
  host.className = 'office-preview-host';
  body.insertBefore(host, loading);
  loading?.classList.add('pdf-overlay-loading');
  body.classList.add('pdf-preview-active');
  const viewer = new mod[VIEWERS[viewerKind]](host, {
    cjkFallback: 'sc', ...options, ...(viewerKind === 'docx' && { progressiveLayout: true }),
  });
  let destroyed = false;
  const preview = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      viewer.destroy?.();
      host.remove();
      body.classList.remove('pdf-preview-active');
    },
  };
  preview.ready = Promise.resolve(source).then(data => destroyed || viewer.load(data)).then(() => {
    if (destroyed) return;
    loading?.remove();
    // Excel has its own zoom bar; documents and decks get the same two-finger zoom as PDFs.
    const scroller = viewerKind !== 'xlsx' && [...host.querySelectorAll('div')].find(div => getComputedStyle(div).overflowY === 'auto');
    if (!scroller) return;
    attachPinchZoom(scroller, () => [...scroller.children].filter(page => page.children.length), {
      get pagesCount() { return 1; },
      get currentScale() { return viewer.getScale(); },
      set currentScale(scale) { viewer.setScale(scale); },
    }, () => {});
  }, error => {
    preview.destroy();
    throw new Error(error?.name === 'OoxmlResourceLimitError'
      ? 'This file is too large to preview. Download to open it.'
      : 'Could not preview this file. Download to open it.', { cause: error });
  });
  return preview;
}
