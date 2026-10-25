// Project file viewer: text up to 300 KB arrives over WS; larger content uses S3.
import { state } from '../state.js';
import { registerEdgeBackLayer } from '../edge-back.js';
import { mountBackButton } from '../components/back-button.js';
import { loadingSpinner } from '../components/loading.js';
import { setDownloadButtonState } from '../components/download-button.js';
import { showToast } from '../components/toast.js';
import { currentProjectHash, relativeProjectImagePath } from './project-hash.js';
import { requestProjectFiles } from './rpc.js';
import { renderSourceView } from './source-view.js';
import { escapeAttachment, isTextAttachment, readAttachmentText } from '../components/attachment.js';
import { BROWSER_SHARE_MAX_BYTES, browserCanShare, downloadFile, prepareSharedFile } from './download.js';
import { loadOfficeViewer, mountOfficePreview, officeKind } from '../components/office-preview.js';
import { CACHED_PREVIEW_TYPES, cacheAttachment, cachedAttachment } from '../components/attachment-cache.js';
import { toolDetailsSource } from '../tool-details.js';
import { resolveEditLocation } from './edit-location.js';
import { imageMimeType } from '../components/image-type.js';

var FILE_REQ_TIMEOUT = 20000;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var _current = null;
var _view = null;
var _downloadTarget = null;
var _pdfPreview = null;
var _pdfLoadController = null;
var _officePreview = null;
var _objectUrl = '';
var _documentObjectUrls = [];
var _documentImages = new Map(); // path → URL promise for the open file; survives Source/Preview toggles
var _clearPdfRanges = null;
var _clearHtmlPreview = null;

function clearAttachmentPreviewCache(key) {
  if (!key) return;
  _clearPdfRanges?.(state.SERVER + '|' + state.KEY + '|' + key + '|');
}

// A finished check/failure icon stays until its own timer, so unrelated body updates keep it.
function updateDownloadButtons(result) {
  const button = document.getElementById('file-download-btn');
  if (!button) return;
  const busy = !!_downloadTarget?.busy;
  if (result || busy || button.classList.contains('is-downloading')) {
    setDownloadButtonState(button, result || (busy ? 'busy' : 'idle'));
  }
  button.disabled = !_downloadTarget || busy;
}

function uploadedKey(target) {
  if (!target.keyPromise) {
    target.keyPromise = target.key ? Promise.resolve(target.key) : requestProjectFiles('download', {
      projectHash: target.projectHash, path: target.path,
    }, { timeout: 30 * 60_000 }).then(result => (target.key = result.key));
    target.keyPromise.catch(() => { target.keyPromise = null; });
  }
  return target.keyPromise;
}

// Identical content shares one stored file, so the name it was opened under wins over the stored one.
function attachmentUrl(key, name) {
  return '/api/bridge/file-url/' + key + (name ? '?name=' + encodeURIComponent(name) : '');
}

async function prepareViewedDownload(target) {
  return window.api(attachmentUrl(await uploadedKey(target), target.name));
}

async function showUploadedProjectFile(target) {
  const token = ++_fileRequestToken;
  try {
    const key = await uploadedKey(target);
    if (token === _fileRequestToken) showAttachment(key);
  } catch (error) {
    if (token === _fileRequestToken) setBody('<div class="file-error">' + esc(String(error.message || error)) + '</div>');
  }
}

async function downloadViewedFile() {
  const target = _downloadTarget;
  if (!target || target.busy) return;
  target.busy = true;
  updateDownloadButtons();
  let outcome = 'failed';
  try {
    let result;
    if (target.sharedFile) {
      result = await shareDownloadedFile(target);
    } else {
      const file = await prepareViewedDownload(target);
      if (_downloadTarget !== target) return;
      if (browserCanShare() && file.size <= BROWSER_SHARE_MAX_BYTES) {
        try {
          target.sharedFile = await prepareSharedFile(file);
        } catch (error) {
          if (error.name !== 'NotSupportedError') throw error;
        }
        if (_downloadTarget !== target) return;
      }
      result = target.sharedFile ? await shareDownloadedFile(target) : await downloadFile(file);
    }
    // ready: sharing needs a fresh tap, so the button simply returns to Download.
    outcome = result.status === 'cancelled' || result.status === 'ready' ? 'idle' : 'done';
  } catch (error) {
    showToast(String(error.message || error));
  } finally {
    target.busy = false;
    if (_downloadTarget === target) updateDownloadButtons(outcome);
  }
}

async function shareDownloadedFile(target) {
  try {
    await navigator.share({ files: [target.sharedFile] });
    return { status: 'shared' };
  } catch (error) {
    if (error.name === 'AbortError') return { status: 'cancelled' };
    if (error.name === 'NotAllowedError') return { status: 'ready' };
    throw error;
  }
}
var _previewToken = 0;
var _fileRequestToken = 0;
var _edgeBack = registerEdgeBackLayer({
  navigateBack: closeFileViewer,
  foregroundSelectors: ['#fileOverlay'],
  guardZIndex: 1001,
});

function fileContext() {
  return {
    projectHash: _view?.options.projectHash || currentProjectHash(),
    device: _view?.options.device ?? state.appState.device ?? '',
  };
}

function requestFileAsync(absPath, context = fileContext()) {
  return requestProjectFiles('read', { ...context, path: absPath }).catch(function () { return null; });
}

function overlay() { return document.getElementById('fileOverlay'); }

function clearFileBody() {
  const body = document.getElementById('fileOverlayBody');
  if (!body) return;
  _clearHtmlPreview?.();
  _clearHtmlPreview = null;
  _pdfLoadController?.abort();
  _pdfLoadController = null;
  _pdfPreview?.destroy();
  _pdfPreview = null;
  _officePreview?.destroy();
  _officePreview = null;
  if (_objectUrl) URL.revokeObjectURL(_objectUrl);
  _objectUrl = '';
  body.querySelectorAll('video, audio').forEach(media => {
    media.pause();
    media.removeAttribute('src');
    media.querySelectorAll('source').forEach(source => source.removeAttribute('src'));
    media.load();
  });
  body.replaceChildren();
}

function setBody(html) {
  clearFileBody();
  var b = document.getElementById('fileOverlayBody');
  if (b) b.innerHTML = html;
  updateDownloadButtons();
}

function updateTabs() {
  var t = document.getElementById('fileOverlayTabs');
  if (!t) return;
  var hasDiff = !!_view?.options.loadDiff;
  var previewable = isPreviewable(_current?.path || _view?.path);
  t.style.display = !_view?.options.diffOnly && (hasDiff || (_current && previewable)) ? '' : 'none';
  t.querySelectorAll('.file-tab').forEach(function (button) {
    var mode = button.dataset.mode;
    button.style.display = (mode === 'diff' && !hasDiff) || (mode === 'preview' && !previewable) ? 'none' : '';
    button.disabled = mode !== 'diff' && _view?.options.canRead === false;
  });
  setActiveTab(_view?.mode || 'source');
}

function setActiveTab(mode) {
  var t = document.getElementById('fileOverlayTabs');
  if (!t) return;
  t.querySelectorAll('.file-tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}

function isHtml(path) { return /\.html?$/i.test(path || ''); }
function isMarkdown(path) { return /\.(md|markdown)$/i.test(path || ''); }
function isImage(path) { return !!imageMimeType(path); }
function isPreviewable(path) { return isHtml(path) || isMarkdown(path); }

// Like SwiftChat's generated apps: a virtual https origin per file keeps its site storage across reopening.
function nativeHtmlPreview() {
  return !!window.__TAURI_INTERNALS__ && !!window.__BATON_NATIVE_MOBILE__ && !/Android/i.test(navigator.userAgent);
}

async function htmlPreviewUrl(path) {
  var context = fileContext();
  var bytes = new TextEncoder().encode([context.device, context.projectHash, path].join('\n'));
  var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  var host = Array.from(digest.slice(0, 16), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  return 'https://' + host + '.baton.local/' + encodeURIComponent(path.split('/').pop());
}

function showPreview(html, path, token) {
  if (!nativeHtmlPreview()) return showFramePreview(html);
  var fallback = function () { if (token === _previewToken) showFramePreview(html); };
  Promise.all([import('../browser/native-view.js'), htmlPreviewUrl(path)]).then(function (loaded) {
    if (token !== _previewToken) return;
    setBody('');
    var view = loaded[0].createNativePreview({
      root: overlay(),
      area: document.getElementById('fileOverlayBody'),
      onState: function (data) { if (data.closeRequested) closeFileViewer(); },
      onError: fallback,
    });
    _clearHtmlPreview = view.destroy;
    view.loadHTML(loaded[1], html);
  }).catch(fallback);
}

function showFramePreview(html) {
  setBody('');
  var body = document.getElementById('fileOverlayBody');
  if (!body) return;
  var f = document.createElement('iframe');
  f.className = 'file-preview';
  f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-modals');
  var token = crypto.randomUUID();
  var sendHtml = function (event) {
    if (event.source === f.contentWindow && event.data === token) {
      f.contentWindow.postMessage({ token, html }, '*');
    }
  };
  window.addEventListener('message', sendHtml);
  _clearHtmlPreview = function () { window.removeEventListener('message', sendHtml); };
  // Keep the native-compatible URL small, even when the document has large inlined assets.
  f.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<script>(()=>{const token=' + JSON.stringify(token) + ';'
    + 'addEventListener("message",function load(e){'
    + 'if(e.source!==parent||e.data?.token!==token)return;'
    + 'removeEventListener("message",load);document.open();document.write(e.data.html);document.close();'
    + '});parent.postMessage(token,"*");})();</script>',
  );
  body.appendChild(f);
}

function setFileViewMode(mode) {
  if (!_view || !['diff', 'source', 'preview'].includes(mode)) return;
  if (mode === 'diff' ? !_view.options.loadDiff : _view.options.canRead === false) return;
  if (mode === 'preview' && !isPreviewable(_current?.path || _view.path)) return;
  if (_view.mode !== mode) _view.options.onModeChange?.(mode);
  _view.mode = mode;
  _fileRequestToken++;
  var token = ++_previewToken;
  var body = document.getElementById('fileOverlayBody');
  if (body) {
    body.scrollLeft = 0;
    body.scrollTop = 0;
  }
  setActiveTab(mode);
  if (mode === 'diff') return showDiff(_view.options.loadDiff, token);
  if (!_current) {
    const attachment = _view.path.startsWith('baton-file:');
    // PDFs and Office documents cannot be read as text: upload them as for a download, then preview the attachment.
    const uploaded = !attachment && !!_downloadTarget && (officeKind(_view.path) || /\.pdf$/i.test(_view.path));
    const viaAttachment = attachment || uploaded;
    setBody('<div class="file-loading' + (viaAttachment ? ' file-loading-delayed' : '') + '">'
      + (viaAttachment ? '<span class="file-loading-content">' : '')
      + loadingSpinner({ label: 'Loading file' })
      + (viaAttachment ? '</span>' : '') + '</div>');
    if (attachment) return showAttachment(_view.path.slice('baton-file:'.length));
    if (uploaded) return showUploadedProjectFile(_downloadTarget);
    return sendFileRequest(_view.path, _view.line, _view.snippet, 1);
  }
  if (mode !== 'preview') {
    return renderSource(_current.path, _current.text, _current.truncated, _current.line, _current.snippet);
  }
  setBody('<div class="file-loading">'
    + loadingSpinner({ label: 'Loading preview' }) + '</div>');
  // An attachment has no folder beside it, so its relative images, CSS and scripts are not loaded.
  var attachment = _view.path.startsWith('baton-file:');
  if (isMarkdown(_current.path)) {
    var current = _current;
    var documentModule;
    import('../components/markdown-document.js').then(function (module) {
      documentModule = module;
      return module.renderMarkdownDocument(current.text);
    }).then(function (html) {
      if (token !== _previewToken) return;
      setBody('<div class="assistant-text md-preview">' + html + '</div>');
      var mdDir = current.path.slice(0, current.path.lastIndexOf('/') + 1);
      var mdBody = document.querySelector('#fileOverlayBody .md-preview');
      if (!mdBody) return;
      window.renderKatexBlocks?.(mdBody);
      window.renderMermaidBlocks?.(mdBody);
      var hasRootPaths = /(?:src|srcset|href)\s*=\s*["']?\/(?!\/)|\]\(\s*<?\/(?!\/)/.test(current.text);
      var mdRoot = attachment ? null
        : hasRootPaths ? repositoryRoot(current.path, mdDir) : Promise.resolve(documentRoot(current.path));
      bindDocumentLinks(mdBody, mdDir, mdRoot);
      if (attachment) {
        mdBody.querySelectorAll('.img-placeholder[data-path]').forEach(function (el) { el.replaceWith(el.dataset.alt || ''); });
        window.loadImages?.(mdBody);
        return;
      }
      return mdRoot.then(function (root) {
        if (token !== _previewToken) return;
        inlineImages(mdBody, mdDir, root, documentModule.darkColorScheme); // mutates this node; harmless if view later changes
      });
    }).catch(function (error) {
      if (token === _previewToken) setBody('<div class="file-error">' + esc(error.message) + '</div>');
    });
    return;
  }
  (attachment ? Promise.resolve(_current.text) : buildPreviewHtml(_current.text, _current.path)).then(function (html) {
    // An attachment's content key, not its file name, gives it its own native preview origin.
    if (token === _previewToken) showPreview(html, attachment ? _view.path : _current.path, token);
  });
}

async function showDiff(loadDiff, token) {
  setBody('<div class="file-loading">'
    + loadingSpinner({ label: 'Loading diff' }) + '</div>');
  try {
    var results = await Promise.all([loadDiff(), window.loadDiffViewer?.()]);
    if (token !== _previewToken) return;
    var result = results[0];
    var diffPath = /^\+\+\+ b\/(.+)$/m.exec(result.content || '') || /^--- a\/(.+)$/m.exec(result.content || '');
    await window.loadHljsLanguage?.(window.detectLang?.(diffPath?.[1]));
    if (token !== _previewToken) return;
    setBody(result.truncated ? '<div class="git-diff-warning">Showing the first 5 MB.</div>' : '');
    var host = document.createElement('div');
    host.className = 'git-diff-render';
    document.getElementById('fileOverlayBody').appendChild(host);
    var ui = new window.Diff2HtmlUI(host, result.content || '', {
      drawFileList: false,
      outputFormat: 'line-by-line',
      matching: 'lines',
      colorScheme: 'dark',
      highlight: true,
    });
    ui.draw();
  } catch (error) {
    if (token === _previewToken) setBody('<div class="file-error">' + esc(error.message) + '</div>');
  }
}

function isRelativeUrl(u) { return u && !/^(https?:|data:|blob:|#|\/\/|mailto:)/i.test(u); }

// Resolve a relative URL against a directory, collapsing ./ and ../ segments.
function resolvePath(dir, u) {
  var parts = (dir + u.replace(/[?#].*$/, '')).split('/');
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === '' && out.length) continue;
    if (parts[i] === '.') continue;
    if (parts[i] === '..') { if (out.length > 1) out.pop(); continue; }
    out.push(parts[i]);
  }
  return out.join('/');
}

// Project root of a document path ('' for project-relative paths); null outside the project.
function documentRoot(path) {
  if (!/^(?:\/|[a-z]:[\\/])/i.test(path)) return '';
  var relative = relativeProjectImagePath(path, fileContext().projectHash);
  return relative == null ? null : path.slice(0, path.length - relative.length);
}

// GitHub's "/" is the repository root: the nearest folder (document folder upward, within the project) holding .git.
// Only definite answers are cached; a failed probe (timeout, reconnect) is retried on the next open.
var _repositoryRoots = new Map();
function repositoryRoot(path, dir) {
  var projectRoot = documentRoot(path);
  if (projectRoot == null || !dir.startsWith(projectRoot)) return Promise.resolve(projectRoot);
  var context = fileContext();
  var key = JSON.stringify([context.device, context.projectHash, dir]);
  if (!_repositoryRoots.has(key)) {
    var failed = false;
    var probe = function (candidate) {
      return requestProjectFiles('read', { ...context, path: candidate + '.git' })
        .then(function () { return 'found'; }, function (error) {
          if (error.message === 'is a directory') return 'found';
          return /^(?:ENOENT|ENOTDIR)\b/.test(error.message) ? 'missing' : 'failed';
        })
        .then(function (result) {
          if (result === 'found') return candidate;
          if (result === 'failed') failed = true;
          if (failed || candidate.length <= projectRoot.length) return projectRoot;
          return probe(candidate.slice(0, candidate.slice(0, -1).lastIndexOf('/') + 1));
        });
    };
    _repositoryRoots.set(key, probe(dir).then(function (root) {
      if (failed) _repositoryRoots.delete(key);
      return root;
    }));
  }
  return _repositoryRoots.get(key);
}

// Real absolute paths (common in agent-written documents) stay as they are; other "/x" follow GitHub's
// repository-root rule.
var FILESYSTEM_ROOTS = /^\/(?:Users|home|tmp|private|var|opt|Volumes|mnt|usr|root|Applications|Library|System|nix)\//;
function resolveDocumentPath(dir, root, url) {
  if (/^[a-z]:[\\/]/i.test(url)) return url;
  if (!/^\/(?!\/)/.test(url)) return resolvePath(dir, url);
  if (root == null || FILESYSTEM_ROOTS.test(url) || (root[0] === '/' && url.startsWith(root))) return resolvePath('', url);
  return resolvePath(root, url.slice(1));
}

// A link to a file; like chat links, `file.md:12` and `#L12` carry a line. Other schemes (tel:, ftp:) are left to the browser.
function documentLinkTarget(href) {
  if (!href || href[0] === '#') return null;
  var withLine = /^([^:?#]*[./][^:?#]*):(\d+(?:-\d+)?)$/.exec(href);
  if (!withLine && !/^[a-z]:[\\/]/i.test(href) && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return null;
  var path = withLine ? withLine[1] : href;
  try { path = decodeURIComponent(path); } catch (e) {}
  var line = withLine ? withLine[2] : ((/#L(\d+(?:-L?\d+)?)/.exec(href) || [])[1] || '').replace(/L/g, '');
  return { path: path, line: line };
}

// Like GitHub: #heading scrolls inside the preview, relative links open beside this document.
// `rootPromise` may still be probing for the repository root when a link is clicked.
function bindDocumentLinks(container, dir, rootPromise) {
  container.querySelectorAll('a[href]').forEach(function (link) {
    if (!/^https?:/i.test(link.getAttribute('href'))) return;
    link.classList.add('ext-link');
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  });
  container.addEventListener('click', function (event) {
    var link = event.target.closest('a[href]');
    var href = link?.getAttribute('href') || '';
    var target = documentLinkTarget(href);
    if (href[0] === '#') {
      event.preventDefault();
      var id = href.slice(1);
      try { id = decodeURIComponent(id); } catch (e) {}
      container.querySelector('#' + CSS.escape('user-content-' + id.replace(/^user-content-/, '')))
        ?.scrollIntoView({ block: 'start' });
    } else if (target) {
      event.preventDefault();
      if (!rootPromise) return; // attachments have no folder to resolve against
      var view = _view;
      rootPromise.then(function (root) {
        if (_view !== view) return;
        var path = resolveDocumentPath(dir, root, target.path);
        if (/\/(?:[?#].*)?$/.test(href) && openProjectDirectory(path, fileContext().projectHash)) return;
        openFile(path, path.split('/').pop(), target.line, null,
          { projectHash: view.options.projectHash, device: view.options.device, fromDocument: true });
      });
    }
  });
}

// A document link to a folder opens the project file browser there, like GitHub's tree view.
function openProjectDirectory(path, projectHash) {
  var project = state.appState.project;
  if (!project || !window.openProjectFilesPath || projectHash !== project.hash) return false;
  var relative = /^(?:\/|[a-z]:[\\/])/i.test(path)
    ? relativeProjectImagePath(path.replace(/\/?$/, '/'), project.hash)
    : path;
  if (relative == null) return false;
  closeFileViewer();
  window.openProjectFilesPath(relative);
  return true;
}

function syncedImageUrl(path, context, cache, svgScheme) {
  if (!cache.has(path)) {
    cache.set(path, requestFileAsync(path, context).then(function (m) {
      if (!m || m.ok === false || !m.image) return null;
      var url = window.getImageUrl(m.key, m.attachment);
      return svgScheme && /\.svg$/i.test(path) ? url.then(function (src) { return schemedSvgUrl(src, svgScheme); }) : url;
    }).catch(function () { return null; }));
  }
  return cache.get(path);
}

// An SVG's own prefers-color-scheme rules are rewritten so its text follows Baton's dark theme.
function schemedSvgUrl(url, svgScheme) {
  // no-store: the <img> preload cached this URL without CORS headers, which a plain fetch would reuse.
  return fetch(url, { cache: 'no-store' }).then(function (response) { return response.ok ? response.text() : null; }).then(function (svg) {
    if (!svg || !/prefers-color-scheme/i.test(svg)) return url;
    var objectUrl = URL.createObjectURL(new Blob([svgScheme(svg)], { type: 'image/svg+xml' }));
    _documentObjectUrls.push(objectUrl);
    return objectUrl;
  }).catch(function () { return url; });
}

// Document images use the per-file cache; failures fall back to the chat loader's retry UI.
function showDocumentImage(el, path, context, cache, svgScheme) {
  el.dataset.loaded = '1';
  return syncedImageUrl(path, context, cache, svgScheme).then(function (url) {
    if (!url) {
      delete el.dataset.loaded;
      window.loadImages?.(el.parentNode, context);
      return;
    }
    var image = document.createElement('img');
    image.src = url;
    image.alt = el.dataset.alt || '';
    image.onclick = function (event) {
      event.preventDefault();
      event.stopPropagation();
      window.viewImage?.(image.src);
    };
    el.classList.add('loaded');
    el.replaceChildren(image);
  });
}

// Replace relative <img src> in a live container with synced data URLs.
function inlineImages(container, dir, root, svgScheme) {
  var jobs = [];
  var context = fileContext();
  var cache = svgScheme ? _documentImages : new Map();
  container.querySelectorAll('img[data-md-src]').forEach(function (el) {
    jobs.push(syncedImageUrl(resolveDocumentPath(dir, root, el.dataset.mdSrc), context, cache, svgScheme).then(function (url) {
      if (url) el.setAttribute('src', url);
    }));
  });
  container.querySelectorAll('source[data-md-srcset]').forEach(function (el) {
    var parts = el.dataset.mdSrcset.split(',').map(function (part) { return part.trim().split(/\s+/); });
    jobs.push(Promise.all(parts.map(function (part) {
      return isRelativeUrl(part[0]) ? syncedImageUrl(resolveDocumentPath(dir, root, part[0]), context, cache, svgScheme) : part[0];
    })).then(function (urls) {
      if (urls.every(Boolean)) {
        el.setAttribute('srcset', urls.map(function (url, i) { return [url].concat(parts[i].slice(1)).join(' '); }).join(', '));
      }
    }));
  });
  container.querySelectorAll('.img-placeholder[data-path]').forEach(function (el) {
    if (root != null && /^\/(?!\/)/.test(el.dataset.path)) {
      el.dataset.path = resolveDocumentPath(dir, root, el.dataset.path);
    } else if (!/^(?:\/|[a-z]:[\\/])/i.test(el.dataset.path)) {
      el.dataset.path = resolvePath(dir, el.dataset.path);
    }
    if (svgScheme) jobs.push(showDocumentImage(el, el.dataset.path, context, cache, svgScheme));
  });
  window.loadImages?.(container, context);
  container.querySelectorAll('img[src]').forEach(function (el) {
    var src = el.getAttribute('src');
    if (!isRelativeUrl(src)) return;
    jobs.push(requestFileAsync(resolvePath(dir, src), context).then(function (m) {
      if (m && m.ok !== false && m.image) {
        return window.getImageUrl(m.key, m.attachment).then(portableImageUrl).then(function (url) {
          el.setAttribute('src', url);
        });
      }
    }));
  });
  return Promise.all(jobs);
}

// A failed or truncated asset inlines as empty instead of blocking the preview.
function previewAssetText(m) {
  if (m.content != null) return Promise.resolve(m.content);
  if (m.truncated) return Promise.resolve('');
  return window.apiText('/api/bridge/file/' + m.key).catch(function () { return ''; });
}

// HTML previews run in an opaque-origin iframe, which cannot read this page's blob: URLs.
function portableImageUrl(url) {
  if (!url.startsWith('blob:')) return url;
  return fetch(url).then(function (response) { return response.blob(); }).then(function (blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(blob);
    });
  });
}

// Inline same-directory relative assets (link/script/img) so the iframe renders complete.
// Remote (http/https/protocol-relative/data:) refs are left untouched. Top-level refs only.
function buildPreviewHtml(html, basePath) {
  var doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); }
  catch (e) { return Promise.resolve(html); }
  var dir = basePath.slice(0, basePath.lastIndexOf('/') + 1);
  var resolve = function (u) { return resolvePath(dir, u); };
  var jobs = [inlineImages(doc.body, dir)];

  doc.querySelectorAll('link[rel="stylesheet"][href]').forEach(function (el) {
    var href = el.getAttribute('href');
    if (!isRelativeUrl(href)) return;
    jobs.push(requestFileAsync(resolve(href)).then(function (m) {
      if (m && m.ok !== false && !m.image) {
        return previewAssetText(m).then(function (css) {
        var style = doc.createElement('style'); style.textContent = css; el.replaceWith(style);
        });
      }
    }));
  });
  doc.querySelectorAll('script[src]').forEach(function (el) {
    var src = el.getAttribute('src');
    if (!isRelativeUrl(src)) return;
    jobs.push(requestFileAsync(resolve(src)).then(function (m) {
      if (m && m.ok !== false && !m.image) {
        return previewAssetText(m).then(function (js) {
        el.removeAttribute('src'); el.textContent = js;
        });
      }
    }));
  });

  return Promise.all(jobs).then(function () { return '<!DOCTYPE html>' + doc.documentElement.outerHTML; });
}

export function closeFileViewer(options) {
  options = options || {};
  var wasOpen = overlay()?.style.display === 'flex';
  var onClose = _view?.options.onClose;
  _edgeBack.deactivate();
  var o = overlay();
  if (o) o.style.display = 'none';
  _current = null;
  _view = null;
  _downloadTarget = null;
  _fileRequestToken++;
  _previewToken++;
  setBody('');
  _documentObjectUrls.forEach(function (url) { URL.revokeObjectURL(url); });
  _documentObjectUrls = [];
  _documentImages = new Map();
  updateTabs();
  if (wasOpen && onClose) onClose(options);
  else if (wasOpen && options.refresh !== false) window.refreshProjectFiles?.();
  return wasOpen;
}

async function sendFileRequest(absPath, line, snippet, retriesLeft) {
  var token = ++_fileRequestToken;
  try {
    var message = await requestProjectFiles('read', {
      ...fileContext(),
      path: absPath,
    }, {
      timeout: FILE_REQ_TIMEOUT,
      onProgress: function (progress) {
        if (token !== _fileRequestToken) return;
        if (progress.video) {
          setBody('<div class="file-loading">'
            + loadingSpinner({ label: 'Uploading video' }) + '</div>');
        }
      },
    });
    if (token !== _fileRequestToken) return;
    handleFileResponse(message, line, snippet, token);
  } catch (error) {
    if (token !== _fileRequestToken) return;
    if (error.message === 'is a directory' && _view?.options.fromDocument
      && openProjectDirectory(absPath, fileContext().projectHash)) return;
    if (retriesLeft > 0) {
      sendFileRequest(absPath, line, snippet, retriesLeft - 1);
      return;
    }
    var messages = {
      'binary file': 'Cannot preview a binary file.',
      'is a directory': 'That path is a directory.',
      'image too large': 'Image is too large to preview (over 10 MB).',
      'video too large': 'Video is too large to preview (over 5 GB).',
    };
    var detail = error.response?.path || absPath;
    setBody('<div class="file-error">' + esc(messages[error.message] || error.message)
      + (detail ? '<div class="file-error-path">' + esc(detail) + '</div>' : '')
      + '</div>');
  }
}

export function openFile(absPath, displayName, lineHint, matchId, options) {
  if (!absPath) return;
  var o = overlay();
  if (!o) return;
  closeFileViewer({ refresh: false });
  options = options || {};
  // Attachment links carry the real file name; project views may label a file differently (e.g. "a.pdf @ 1a2b3c4").
  var fileName = absPath.startsWith('baton-file:') ? displayName : absPath.split(/[\\/]/).pop();
  _view = { path: absPath, name: fileName, line: lineHint || '', snippet: matchId ? snippetForTool(matchId) : '', matchId, options: options };
  _downloadTarget = options.canRead === false ? null : { path: absPath, projectHash: options.projectHash || currentProjectHash(),
    key: absPath.startsWith('baton-file:') ? absPath.slice('baton-file:'.length) : '', name: fileName };
  updateDownloadButtons('idle');
  var titleEl = document.getElementById('fileOverlayTitle');
  titleEl.textContent = displayName || absPath;
  titleEl.title = absPath;
  _current = null;
  _previewToken++;
  updateTabs();
  o.style.display = 'flex';
  _edgeBack.activate();
  if (window.attachScrollIndicator) window.attachScrollIndicator(document.getElementById('fileOverlayBody'));
  var previewImage = isImage(absPath) && options.canRead !== false && !options.diffOnly;
  // HTML opens rendered even from edit/line links; Markdown keeps source positioning for those links.
  var previewDocument = isPreviewable(absPath) && (isHtml(absPath) || (!lineHint && !matchId))
    && options.mode !== 'source' && options.canRead !== false && !options.diffOnly;
  setFileViewMode(options.loadDiff && options.mode !== 'source' && !previewImage ? 'diff'
    : previewDocument ? 'preview' : 'source');
  return true;
}

async function showAttachment(key) {
  const token = ++_fileRequestToken;
  let pdfFallbackUrl = '';
  let cachedPdf = false;
  try {
    if (!/^[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/.test(key)) throw new Error('Invalid file key');
    const office = officeKind(key);
    if (office) return await showOfficeAttachment(key, office, token);
    const cachedType = CACHED_PREVIEW_TYPES[key.split('.').pop()];
    const cached = cachedType && await cachedAttachment(key);
    if (token !== _fileRequestToken) return;
    const file = cached
      ? { name: _view?.name || cached.name, size: cached.data.byteLength, previewType: cachedType, data: cached.data }
      : await window.api(attachmentUrl(key, _view?.name));
    if (token !== _fileRequestToken) return;
    document.getElementById('fileOverlayTitle').textContent = file.name;
    if (isTextAttachment(file)) {
      const content = await readAttachmentText(file.url);
      if (token !== _fileRequestToken) return;
      if (!content.text.includes('\0')) {
        render(file.name, content.text, content.truncated, '', '');
        return;
      }
    }
    let preview = '<div class="attachment-preview-note">No inline preview for this file type. Download to open it.</div>';
    const url = escapeAttachment(file.previewUrl || '');
    if (file.previewType === 'application/pdf') {
      pdfFallbackUrl = url;
      cachedPdf = !!file.data;
      // Without PDF.js support, the fallback below opens the browser's own viewer.
      if (!window.ResizeObserver || !window.requestAnimationFrame) throw new Error('Could not preview this file. Download to open it.');
      const { mountPdfPreview, clearPdfRangeCache } = await import('../components/pdf-preview.js');
      if (token !== _fileRequestToken) return;
      _clearPdfRanges = clearPdfRangeCache;
      const cacheKey = state.SERVER + '|' + state.KEY + '|' + key + '|' + file.size;
      const body = document.getElementById('fileOverlayBody');
      if (!body.querySelector('.file-loading')) {
        setBody('<div class="file-loading file-loading-delayed"><span class="file-loading-content">'
          + loadingSpinner({ label: 'Loading' }) + '</span></div>');
      }
      const controller = new AbortController();
      _pdfLoadController = controller;
      const pdfPreview = await mountPdfPreview(body, file.previewUrl, file.size, controller.signal, cacheKey, {
        data: file.data, onFile: !file.data && (bytes => cacheAttachment(key, file.name, bytes)),
      });
      if (_pdfLoadController === controller) _pdfLoadController = null;
      if (token !== _fileRequestToken) { pdfPreview.destroy(); return; }
      _pdfPreview = pdfPreview;
      await pdfPreview.ready;
      return;
    } else if (file.previewType?.startsWith('image/')) {
      const data = file.data || await downloadAttachment(key, file);
      if (token !== _fileRequestToken) return;
      const objectUrl = URL.createObjectURL(new Blob([data], { type: file.previewType }));
      setBody('<img class="file-image" alt="" src="' + objectUrl + '">');
      _objectUrl = objectUrl;
      return;
    } else if (file.previewType?.startsWith('video/')) {
      preview = '<video class="file-video" controls playsinline preload="metadata" src="' + url + '"></video>';
    } else if (file.previewType?.startsWith('audio/')) {
      preview = '<audio controls preload="metadata" src="' + url + '"></audio>';
    }
    setBody(preview);
  } catch (error) {
    if (token !== _fileRequestToken) return;
    if (cachedPdf) {
      // A cache hit has no URL; the browser's own viewer needs a fresh one.
      pdfFallbackUrl = await window.api(attachmentUrl(key, _view?.name))
        .then(file => escapeAttachment(file.previewUrl || ''), () => '');
      if (token !== _fileRequestToken) return;
    }
    if (pdfFallbackUrl) {
      setBody('<iframe class="attachment-pdf" title="PDF preview" src="' + pdfFallbackUrl + '"></iframe>');
    } else {
      setBody('<div class="file-error">' + escapeAttachment(error.message) + '</div>');
    }
  }
}

async function downloadAttachment(key, file) {
  const response = await fetch(file.previewUrl);
  if (!response.ok) throw new Error('Download failed (' + response.status + ')');
  const buffer = await response.arrayBuffer();
  cacheAttachment(key, file.name, buffer);
  return buffer;
}

// Office files are parsed in the page: a cached copy opens without any request, otherwise the viewer
// module, the URL request and the download all run at once.
async function showOfficeAttachment(key, kind, token) {
  loadOfficeViewer(kind).catch(() => {});
  const cached = await cachedAttachment(key);
  if (token !== _fileRequestToken) return;
  let source = cached?.data;
  let name = _view?.name || cached?.name;
  if (!cached) {
    const file = await window.api(attachmentUrl(key, _view?.name));
    if (token !== _fileRequestToken) return;
    name = file.name;
    source = downloadAttachment(key, file);
    source.catch(() => {});
  }
  document.getElementById('fileOverlayTitle').textContent = name;
  const officePreview = await mountOfficePreview(document.getElementById('fileOverlayBody'), source, kind);
  if (token !== _fileRequestToken) { officePreview.destroy(); return; }
  _officePreview = officePreview;
  await officePreview.ready;
}

// Find the Edit/Write tool_use by id and return the text it wrote (new_string / content).
function snippetForTool(toolId) {
  // Loaded Edit uses explicit ranges in renderSource; Write still needs its full text.
  var loadedTool = toolDetailsSource(toolId)?.full?.toolUse;
  if (loadedTool?.name === 'Write') return loadedTool.input?.content || '';
  var msgs = state.wsAllMessages || [];
  for (var i = 0; i < msgs.length; i++) {
    var c = msgs[i].content;
    if (!Array.isArray(c)) continue;
    for (var j = 0; j < c.length; j++) {
      if (c[j].type === 'tool_use' && c[j].id === toolId) {
        var inp = c[j].input || {};
        return inp.new_string || inp.content || '';
      }
    }
  }
  return '';
}

function render(absPath, text, truncated, lineHint, snippet, contentVersion) {
  _current = { path: absPath, text: text, truncated: truncated, line: lineHint, snippet: snippet, contentVersion };
  updateTabs();
  setFileViewMode(_view.mode);
}

async function renderSource(absPath, text, truncated, lineHint, snippet) {
  var body = document.getElementById('fileOverlayBody');
  if (!body) return;
  const view = _view;
  const current = _current;
  const token = _previewToken;
  const entry = view.matchId && toolDetailsSource(view.matchId);
  let ranges;
  if (entry?.full?.toolUse.name === 'Edit') {
    try {
      const previous = entry.fileLocation?.path === absPath ? entry.fileLocation : null;
      const location = await resolveEditLocation(text, entry.full.toolUse.input, current.contentVersion, previous);
      ranges = location.ranges;
      if (_view === view && _current === current) {
        entry.fileLocation = location === previous ? previous : { ...location, path: absPath };
      }
    } catch { ranges = []; }
  }
  if (_view !== view || _current !== current || token !== _previewToken || view.mode !== 'source') return;
  clearFileBody();
  renderSourceView(body, {
    path: absPath,
    text: text,
    truncated: truncated,
    lineHint: lineHint,
    snippet: snippet,
    ranges,
  });
}

// Presigned GET URLs expire in 1h; cache them ~50min (10min safety margin) so
// re-opening the same video reuses the URL instead of round-tripping the bridge.
var VIDEO_URL_TTL = 50 * 60 * 1000;

function renderVideo(url) {
  setBody('<video class="file-video" controls playsinline preload="metadata" src="' + esc(url) + '"></video>');
}

function showVideo(key, token) {
  var c = state.videoUrlCache.get(key);
  if (c && c.exp > Date.now()) return renderVideo(c.url);
  return window.api('/api/bridge/video-url/' + key).then(function (r) {
    if (token !== _fileRequestToken) return;
    if (!r || !r.url) return setBody('<div class="file-error">Failed to load video.</div>');
    if (state.videoUrlCache.size > 50) state.videoUrlCache.delete(state.videoUrlCache.keys().next().value);
    state.videoUrlCache.set(key, { url: r.url, exp: Date.now() + VIDEO_URL_TTL });
    renderVideo(r.url);
  }).catch(function () {
    if (token === _fileRequestToken) setBody('<div class="file-error">Failed to load video.</div>');
  });
}

function handleFileResponse(msg, line, snippet, token) {
  if (msg.video) return showVideo(msg.key, token);

  if (msg.image) {
    return window.getImageUrl(msg.key, msg.attachment).then(function (url) {
      if (token !== _fileRequestToken) return;
      closeFileViewer({ refresh: false });
      if (window.viewImage) window.viewImage(url);
    }).catch(function () {
      if (token === _fileRequestToken) setBody('<div class="file-error">Failed to download image.</div>');
    });
  }

  // Inline text already arrived over WS. Uploaded text has a content-derived key, so the shared
  // attachment cache never goes stale and keeps it out of memory.
  var contentPromise = msg.content != null
    ? Promise.resolve(msg.content)
    : cachedAttachment(msg.key).then(function (cached) {
      if (cached) return new TextDecoder().decode(cached.data);
      return window.apiText('/api/bridge/file/' + msg.key).then(function (text) {
        cacheAttachment(msg.key, (msg.path || '').split('/').pop() || msg.key, new Blob([text]));
        return text;
      });
    });
  contentPromise.then(function (text) {
    if (token !== _fileRequestToken) return;
    render(msg.path, text, msg.truncated, line, snippet, msg.contentVersion);
  }).catch(function () {
    if (token === _fileRequestToken) setBody('<div class="file-error">Failed to download file.</div>');
  });
}

var backSlot = document.getElementById('fileBackButton');
if (backSlot) mountBackButton(backSlot, function () { closeFileViewer(); });

document.addEventListener('keydown', function (e) {
  var o = overlay();
  if (!o || o.style.display !== 'flex' || e.key !== 'Escape') return;
  closeFileViewer();
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

Object.assign(window, {
  openFile: openFile,
  closeFileViewer: closeFileViewer,
  clearAttachmentPreviewCache,
  setFileViewMode: setFileViewMode,
  downloadViewedFile,
});
