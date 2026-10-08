import * as pdfjs from 'pdfjs-dist/build/pdf.js';
import * as pdfjsViewer from 'pdfjs-dist/web/pdf_viewer.js';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import pdfViewerCss from 'pdfjs-dist/web/pdf_viewer.css?inline';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

let activePreview = null;
const RANGE_CHUNK_SIZE = 64 * 1024;

export function mountPdfPreview(body, url, size) {
  activePreview?.destroy();

  const host = document.createElement('div');
  host.className = 'pdf-preview-host';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    ${pdfViewerCss}
    :host { display: block; width: 100%; height: 100%; }
    .pdf-surface { position: relative; width: 100%; height: 100%; background: #0d1117; }
    .pdf-container { position: absolute; inset: 0; overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
    .pdf-controls { position: absolute; right: 12px; bottom: 12px; z-index: 10; display: flex; gap: 4px; padding: 4px; border-radius: 8px; background: rgba(22,27,34,.9); box-shadow: 0 2px 12px #0008; }
    .pdf-controls button { min-width: 36px; min-height: 36px; padding: 0 8px; border: 0; border-radius: 5px; background: transparent; color: #e6edf3; font: 14px system-ui; cursor: pointer; }
    .pdf-controls button:hover { background: #30363d; }
    .pdf-controls button:focus-visible { outline: 2px solid #58a6ff; }
  </style>
  <div class="pdf-surface">
    <div class="pdf-container" tabindex="0" aria-label="PDF pages"><div class="pdfViewer"></div></div>
    <div class="pdf-controls" aria-label="PDF zoom">
      <button type="button" data-action="out" aria-label="Zoom out">−</button>
      <button type="button" data-action="fit" aria-label="Fit page width">Fit</button>
      <button type="button" data-action="in" aria-label="Zoom in">+</button>
    </div>
  </div>`;
  body.replaceChildren(host);
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

  let fitWidth = true;
  let disposed = false;
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

  shadow.querySelector('.pdf-controls').addEventListener('click', event => {
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
      const response = await fetch(url, {
        headers: { Range: `bytes=${begin}-${end - 1}` },
        signal: controller.signal,
      });
      if (response.status !== 200 && response.status !== 206) throw new Error(`PDF download failed (${response.status})`);
      return { bytes: new Uint8Array(await response.arrayBuffer()), partial: response.status === 206 };
    } finally {
      controllers.delete(controller);
    }
  }

  const ready = (async () => {
    if (Number.isSafeInteger(size) && size > 0) {
      const first = await readRange(0, Math.min(size, RANGE_CHUNK_SIZE));
      if (disposed) return;
      if (!first.partial || first.bytes.length === size) {
        loadingTask = pdfjs.getDocument({ data: first.bytes, isEvalSupported: false });
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
          disableAutoFetch: true,
          disableStream: true,
          isEvalSupported: false,
        });
      }
    } else {
      loadingTask = pdfjs.getDocument({ url, isEvalSupported: false });
    }
    const document = await Promise.race([loadingTask.promise, rangeFailure]);
    if (disposed) return;
    linkService.setDocument(document);
    viewer.setDocument(document);
  })();
  const preview = {
    ready,
    destroy() {
      if (disposed) return;
      disposed = true;
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
