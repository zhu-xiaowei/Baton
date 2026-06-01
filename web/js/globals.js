// Lazy loader for viewer-only libs (marked / hljs / diff / diff2html) and viewer modules.
// Triggered after first paint (inline shell or app.js IIFE) so device-list path doesn't pay
// the ~1.3MB download. Calling multiple times returns the same promise.

let _libsPromise = null;

async function loadViewerLibs() {
  if (_libsPromise) return _libsPromise;
  _libsPromise = (async function () {
    // Phase 1: vendor libs + their CSS. markdown.js's top-level marked.setOptions()
    // requires marked + hljs to be on window first, so phase 2 must run after this.
    const [markedMod, hljsMod, diffMod, diff2htmlMod] = await Promise.all([
      import('marked'),
      import('highlight.js'),
      import('diff'),
      import('diff2html/lib-esm/ui/js/diff2html-ui'),
      import('highlight.js/styles/vs2015.css'),
      import('diff2html/bundles/css/diff2html.min.css'),
    ]);
    window.marked = markedMod.marked;
    window.hljs = hljsMod.default;
    window.Diff = diffMod;
    window.Diff2HtmlUI = diff2htmlMod.Diff2HtmlUI;

    // Phase 2: viewer modules (IIFEs that read window.marked/hljs at top level).
    await Promise.all([
      import('./components/markdown.js'),
      import('./components/tool.js'),
      import('./components/message.js'),
      import('./components/permission.js'),
      import('./components/typing-status.js'),
      import('./components/image.js'),
      import('./components/fileviewer.js'),
      import('./render.js'),
      import('./ws.js'),
    ]);
  })();
  return _libsPromise;
}

window.loadViewerLibs = loadViewerLibs;
