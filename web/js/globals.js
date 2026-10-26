// Lazy loader for viewer-only libs and modules.
// Triggered after first paint (inline shell or app.js IIFE) so device-list path doesn't pay
// the ~1.3MB download. Calling multiple times returns the same promise.

let _libsPromise = null;
let _diffPromise = null;

// Languages outside highlight.js/lib/common load by canonical name on first use.
const _hljsLanguagePromises = new Map();

function loadHljsLanguage(name) {
  const hljs = window.hljs;
  const language = String(name || '').toLowerCase();
  if (!hljs || !language) return Promise.resolve(false);
  if (hljs.getLanguage(language)) return Promise.resolve(true);
  if (!_hljsLanguagePromises.has(language)) {
    _hljsLanguagePromises.set(language, import('./components/hljs-languages.js').then(({ languageModules, languagePath }) => {
      const load = languageModules[languagePath(language)];
      return load ? load() : null;
    }).then((module) => {
      if (!module) return false;
      hljs.registerLanguage(language, module.default);
      // Code rendered as plain text while the language was loading.
      document.querySelectorAll('code[data-hljs-language="' + language + '"]').forEach((node) => {
        node.removeAttribute('data-hljs-language');
        try { node.innerHTML = hljs.highlight(node.textContent, { language, ignoreIllegals: true }).value; } catch (e) {}
      });
      return true;
    }).catch(() => {
      _hljsLanguagePromises.delete(language);
      return false;
    }));
  }
  return _hljsLanguagePromises.get(language);
}

async function loadDiffViewer() {
  if (window.Diff && window.Diff2HtmlUI) return;
  if (_diffPromise) return _diffPromise;
  _diffPromise = Promise.all([
    import('diff'),
    import('diff2html/lib-esm/ui/js/diff2html-ui-base'),
    import('diff2html/bundles/css/diff2html.min.css'),
  ]).then(([diffMod, diff2htmlMod]) => {
    window.Diff = diffMod;
    // The base class takes the shared hljs instead of bundling all languages.
    window.Diff2HtmlUI = class extends diff2htmlMod.Diff2HtmlUI {
      constructor(target, diffInput, config) {
        super(target, diffInput, config, window.hljs);
      }
    };
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
      import('highlight.js/lib/common'),
      import('anser'),
      import('highlight.js/styles/vs2015.css'),
    ]);
    window.marked = markedMod.marked;
    window.hljs = hljsMod.default;
    window.Anser = anserMod.default;

    // Phase 2: viewer modules (IIFEs that read window.marked/hljs at top level).
    await Promise.all([
      import('./components/markdown.js'),
      import('./components/visualization.js'),
      import('../css/visualization.css'),
      import('./components/mermaid.js'),
      import('./components/katex.js'),
      import('./components/tool.js'),
      import('./components/message.js'),
      import('./components/permission.js'),
      import('./components/typing-status.js'),
      import('./components/image.js'),
      import('./components/voice.js'),
      import('./project/file-viewer.js'),
      import('./components/slashcommands.js'),
      import('./components/claude-usage.js'),
      import('./render.js'),
      import('./ws.js'),
    ]);
  })();
  return _libsPromise;
}

window.loadViewerLibs = loadViewerLibs;
window.loadDiffViewer = loadDiffViewer;
window.loadHljsLanguage = loadHljsLanguage;
