const PDF_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174';
let pdfModulesPromise;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Failed to load PDF viewer'));
    document.head.appendChild(script);
  });
}

function loadPdfModules() {
  if (!pdfModulesPromise) pdfModulesPromise = (async () => {
    const cssPromise = fetch(`${PDF_CDN}/web/pdf_viewer.css`).then(async response => {
      if (!response.ok) throw new Error('Failed to load PDF styles');
      return (await response.text()).replace(
        /url\((["']?)images\//g,
        (_, quote) => `url(${quote}${PDF_CDN}/web/images/`,
      );
    });
    const scriptsPromise = (async () => {
      await loadScript(`${PDF_CDN}/build/pdf.min.js`);
      const pdfjs = globalThis.pdfjsLib;
      if (!pdfjs) throw new Error('PDF viewer is unavailable');
      pdfjs.GlobalWorkerOptions.workerSrc = `${PDF_CDN}/build/pdf.worker.min.js`;
      const worker = new pdfjs.PDFWorker({ name: 'baton-pdf' });
      await Promise.all([loadScript(`${PDF_CDN}/web/pdf_viewer.js`), worker.promise]);
      return worker;
    })();
    const [css, worker] = await Promise.all([cssPromise, scriptsPromise]);
    const pdfjs = globalThis.pdfjsLib;
    const pdfjsViewer = globalThis.pdfjsViewer;
    if (!pdfjs || !pdfjsViewer) throw new Error('PDF viewer is unavailable');
    return { pdfjs, pdfjsViewer, css, worker };
  })().catch(error => { pdfModulesPromise = null; throw error; });
  return pdfModulesPromise;
}

let activePreview = null;
const RANGE_CHUNK_SIZE = 64 * 1024;
const RANGE_CACHE_LIMIT = 16 * 1024 * 1024;
const rangeCache = new Map();
let rangeCacheBytes = 0;

export function clearPdfRangeCache(prefix) {
  if (!prefix) return;
  for (const [id, entry] of rangeCache) {
    if (!id.startsWith(prefix)) continue;
    rangeCache.delete(id);
    rangeCacheBytes -= entry.bytes.length;
  }
}

async function fetchPdfRange(url, begin, end, signal, cacheKey) {
  if (signal?.aborted) throw new DOMException('PDF loading cancelled', 'AbortError');
  const id = cacheKey ? `${cacheKey}:${begin}-${end}` : '';
  const cached = id && rangeCache.get(id);
  if (cached) {
    rangeCache.delete(id);
    rangeCache.set(id, cached);
    return { bytes: cached.bytes.slice(), partial: cached.partial };
  }
  const response = await fetch(url, {
    headers: { Range: `bytes=${begin}-${end - 1}` },
    signal,
  });
  if (response.status !== 200 && response.status !== 206) throw new Error(`PDF download failed (${response.status})`);
  const result = { bytes: new Uint8Array(await response.arrayBuffer()), partial: response.status === 206 };
  if (id && result.bytes.length <= RANGE_CACHE_LIMIT) {
    const previous = rangeCache.get(id);
    if (previous) {
      rangeCache.delete(id);
      rangeCacheBytes -= previous.bytes.length;
    }
    while (rangeCacheBytes + result.bytes.length > RANGE_CACHE_LIMIT) {
      const oldest = rangeCache.keys().next().value;
      const removed = rangeCache.get(oldest);
      rangeCache.delete(oldest);
      rangeCacheBytes -= removed.bytes.length;
    }
    rangeCache.set(id, { bytes: result.bytes.slice(), partial: result.partial });
    rangeCacheBytes += result.bytes.length;
  }
  return result;
}

export async function mountPdfPreview(body, url, size, signal, cacheKey) {
  const hasSize = Number.isSafeInteger(size) && size > 0;
  const initialRange = hasSize
    ? fetchPdfRange(url, 0, Math.min(size, RANGE_CHUNK_SIZE), signal, cacheKey)
    : Promise.resolve(null);
  const [{ pdfjs, pdfjsViewer, css: pdfViewerCss, worker }, firstRange] =
    await Promise.all([loadPdfModules(), initialRange]);
  activePreview?.destroy();

  const previousLoading = body.querySelector('.file-loading');
  const host = document.createElement('div');
  host.className = 'pdf-preview-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    ${pdfViewerCss}
    :host { display: block; width: 100%; height: 100%; }
    .pdf-surface { position: relative; width: 100%; height: 100%; background: #0d1117; }
    .pdf-container { position: absolute; inset: 0; overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .pdf-loading { position: absolute; inset: 0; z-index: 5; display: flex; align-items: center; justify-content: center; background: #0d1117; color: #8b949e; font: 14px system-ui; }
    .pdf-loading-indicator { display: flex; align-items: center; gap: 10px; visibility: hidden; animation: pdf-loading-reveal 0s 250ms forwards; }
    .pdf-loading-indicator::before { content: ''; width: 18px; height: 18px; border: 2px solid #484f58; border-top-color: #e6edf3; border-radius: 50%; animation: pdf-loading-spin .6s linear infinite; }
    @keyframes pdf-loading-reveal { to { visibility: visible; } }
    @keyframes pdf-loading-spin { to { transform: rotate(360deg); } }
    .pdf-controls { position: absolute; right: 12px; bottom: 12px; z-index: 10; display: flex; gap: 4px; padding: 4px; border-radius: 8px; background: rgba(22,27,34,.9); box-shadow: 0 2px 12px #0008; }
    .pdf-controls[hidden] { display: none; }
    .pdf-controls button { min-width: 36px; min-height: 36px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: #e6edf3; font: 14px system-ui; cursor: pointer; }
    .pdf-controls button:hover { background: #30363d; }
    .pdf-controls button:focus-visible { outline: 2px solid #58a6ff; }
  </style>
  <div class="pdf-surface">
    <div class="pdf-container" tabindex="0" aria-label="PDF pages. Press Enter to toggle zoom controls"><div class="pdfViewer"></div></div>
    ${previousLoading ? '' : '<div class="pdf-loading" role="status" aria-label="Loading PDF page"><span class="pdf-loading-indicator">Loading PDF…</span></div>'}
    <div class="pdf-controls" aria-label="PDF zoom" hidden>
      <button type="button" data-action="out" aria-label="Zoom out">−</button>
      <button type="button" data-action="fit" aria-label="Fit page width">Fit</button>
      <button type="button" data-action="in" aria-label="Zoom in">+</button>
    </div>
  </div>`;
  if (previousLoading) {
    body.insertBefore(host, previousLoading);
    previousLoading.classList.add('pdf-overlay-loading');
  } else {
    body.replaceChildren(host);
  }
  body.classList.add('pdf-preview-active');

  const container = shadow.querySelector('.pdf-container');
  const eventBus = new pdfjsViewer.EventBus();
  const linkService = new pdfjsViewer.PDFLinkService({ eventBus });
  const viewer = new pdfjsViewer.PDFViewer({
    container,
    viewer: shadow.querySelector('.pdfViewer'),
    eventBus,
    linkService,
    removePageBorders: true,
    annotationEditorMode: pdfjs.AnnotationEditorType.DISABLE,
  });
  linkService.setViewer(viewer);

  let disposed = false;
  let finishFirstPaint;
  let failFirstPaint;
  const firstPaint = new Promise((resolve, reject) => {
    finishFirstPaint = resolve;
    failFirstPaint = reject;
  });
  eventBus.on('pagerendered', event => {
    if (disposed || event.cssTransform) return;
    if (event.error) return failFirstPaint(event.error);
    previousLoading?.remove();
    shadow.querySelector('.pdf-loading')?.remove();
    finishFirstPaint();
  });
  let press = null;
  let toggleTimer = 0;
  const controls = shadow.querySelector('.pdf-controls');
  const pages = shadow.querySelector('.pdfViewer');
  container.addEventListener('keydown', event => {
    if (event.target !== container || event.key !== 'Enter') return;
    event.preventDefault();
    controls.hidden = !controls.hidden;
  });
  pages.addEventListener('pointerdown', event => {
    press = { x: event.clientX, y: event.clientY, started: Date.now(), moved: false };
  });
  pages.addEventListener('pointermove', event => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 8) press.moved = true;
  });
  pages.addEventListener('pointercancel', () => { if (press) press.moved = true; });
  pages.addEventListener('click', event => {
    const pendingToggle = !!toggleTimer;
    if (toggleTimer) clearTimeout(toggleTimer);
    toggleTimer = 0;
    const tap = press;
    press = null;
    if (tap && (tap.moved || Date.now() - tap.started > 500)) return;
    if (event.detail > 1 && pendingToggle) return;
    if (event.target.closest('a, button, input, textarea, select')) return;
    if (window.getSelection()?.toString()) return;
    toggleTimer = setTimeout(() => {
      toggleTimer = 0;
      if (!disposed && !window.getSelection()?.toString()) controls.hidden = !controls.hidden;
    }, 250);
  });

  let fitWidth = true;
  const fit = () => {
    if (!viewer.pagesCount) return;
    fitWidth = true;
    viewer.currentScaleValue = 'page-width';
  };
  eventBus.on('pagesinit', fit);
  const resizeObserver = new ResizeObserver(() => {
    if (fitWidth) fit();
  });
  resizeObserver.observe(container);
  controls.addEventListener('click', event => {
    const action = event.target.closest('button')?.dataset.action;
    if (!action || !viewer.pagesCount) return;
    if (action === 'fit') return fit();
    fitWidth = false;
    viewer.currentScaleValue = String(Math.max(0.25, Math.min(4,
      viewer.currentScale * (action === 'in' ? 1.25 : 0.8))));
  });

  const controllers = new Set();
  let loadingTask;
  let failRange;
  const rangeFailure = new Promise((_, reject) => { failRange = reject; });
  async function readRange(begin, end) {
    const controller = new AbortController();
    controllers.add(controller);
    try {
      return await fetchPdfRange(url, begin, end, controller.signal, cacheKey);
    } finally {
      controllers.delete(controller);
    }
  }

  const ready = (async () => {
    if (hasSize) {
      const first = firstRange;
      if (disposed) return;
      if (!first.partial || first.bytes.length === size) {
        loadingTask = pdfjs.getDocument({ data: first.bytes, worker, isEvalSupported: false });
      } else {
        const transport = new class extends pdfjs.PDFDataRangeTransport {
          requestDataRange(begin, end) {
            readRange(begin, end).then(({ bytes, partial }) => {
              if (!disposed) this.onDataRange(partial ? begin : 0, bytes);
            }).catch(error => {
              if (!disposed) failRange(error);
            });
          }
          abort() {
            for (const controller of controllers) controller.abort();
          }
        }(size, first.bytes);
        loadingTask = pdfjs.getDocument({
          range: transport,
          worker,
          disableAutoFetch: true,
          disableStream: true,
          isEvalSupported: false,
        });
      }
    } else {
      loadingTask = pdfjs.getDocument({ url, worker, isEvalSupported: false });
    }
    const document = await Promise.race([loadingTask.promise, rangeFailure]);
    if (disposed) return;
    linkService.setDocument(document);
    viewer.setDocument(document);
    await firstPaint;
  })();
  const preview = {
    ready,
    destroy() {
      if (disposed) return;
      disposed = true;
      previousLoading?.remove();
      finishFirstPaint();
      if (toggleTimer) clearTimeout(toggleTimer);
      resizeObserver.disconnect();
      viewer.setDocument(null);
      for (const controller of controllers) controller.abort();
      loadingTask?.destroy();
      body.classList.remove('pdf-preview-active');
      host.remove();
      if (activePreview === preview) activePreview = null;
    },
  };
  activePreview = preview;
  return preview;
}
