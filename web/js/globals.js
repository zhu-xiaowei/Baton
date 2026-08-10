// Lazy loader for viewer-only libs and modules.
// Triggered after first paint (inline shell or app.js IIFE) so device-list path doesn't pay
// the ~1.3MB download. Calling multiple times returns the same promise.

let _libsPromise = null;
let _diffPromise = null;

async function loadDiffViewer() {
  if (window.Diff && window.Diff2HtmlUI) return;
  if (_diffPromise) return _diffPromise;
  _diffPromise = Promise.all([
    import('diff'),
    import('diff2html/lib-esm/ui/js/diff2html-ui'),
    import('diff2html/bundles/css/diff2html.min.css'),
  ]).then(([diffMod, diff2htmlMod]) => {
    window.Diff = diffMod;
    window.Diff2HtmlUI = diff2htmlMod.Diff2HtmlUI;
  }).catch((error) => {
    _diffPromise = null;
    throw error;
  });
  return _diffPromise;
}

async function loadViewerLibs() {
  if (_libsPromise) return _libsPromise;
  _libsPromise = (async function () {
    // Phase 1: vendor libs + their CSS. markdown.js's top-level marked.setOptions()
    // requires marked + hljs to be on window first, so phase 2 must run after this.
    const [markedMod, hljsMod, anserMod] = await Promise.all([
      import('marked'),
      import('highlight.js'),
      import('anser'),
      import('highlight.js/styles/vs2015.css'),
    ]);
    window.marked = markedMod.marked;
    window.hljs = hljsMod.default;
    window.Anser = anserMod.default;

    // Phase 2: viewer modules (IIFEs that read window.marked/hljs at top level).
    await Promise.all([
      import('./components/markdown.js'),
      import('./components/mermaid.js'),
      import('./components/katex.js'),
      import('./components/tool.js'),
      import('./components/message.js'),
      import('./runtime-status.js'),
      import('./components/permission.js'),
      import('./components/typing-status.js'),
      import('./components/image.js'),
      import('./components/voice.js'),
      import('./components/fileviewer.js'),
      import('./components/slashcommands.js'),
      import('./render.js'),
      import('./ws.js'),
    ]);
  })();
  return _libsPromise;
}

window.loadViewerLibs = loadViewerLibs;
window.loadDiffViewer = loadDiffViewer;
