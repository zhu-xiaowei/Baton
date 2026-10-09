// Project file viewer: text up to 300 KB arrives over WS; larger content uses S3.
import { state } from '../state.js';
import { registerEdgeBackLayer } from '../edge-back.js';
import { mountBackButton } from '../components/back-button.js';
import { loadingSpinner } from '../components/loading.js';
import { currentProjectHash } from './project-hash.js';
import { requestProjectFiles } from './rpc.js';
import { renderSourceView } from './source-view.js';
import { escapeAttachment, isTextAttachment, readAttachmentText } from '../components/attachment.js';
import { BROWSER_SHARE_MAX_BYTES, browserCanShare, downloadFile, prepareSharedFile } from './download.js';

var FILE_REQ_TIMEOUT = 20000;

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var _current = null;
var _view = null;
var _downloadTarget = null;
var _pdfPreview = null;
var _pdfLoadController = null;
var _viewedPdfKeys = new Set();
var _clearPdfRanges = null;

function clearAttachmentPreviewCache(key) {
  if (!key) return;
  const prefix = state.SERVER + '|' + state.KEY + '|' + key + '|';
  for (const viewed of _viewedPdfKeys) {
    if (viewed.startsWith(prefix)) _viewedPdfKeys.delete(viewed);
  }
  _clearPdfRanges?.(prefix);
}

function downloadStatus(text) {
  const status = document.getElementById('file-download-status');
  if (status) status.textContent = text;
}

function updateDownloadButtons() {
  const busy = !!_downloadTarget?.busy;
  document.querySelectorAll('#file-download-btn, #fileOverlay .file-download-action').forEach(button => {
    button.disabled = !_downloadTarget || busy;
    button.classList.toggle('is-downloading', busy);
    button.setAttribute('aria-busy', String(busy));
    if (busy && !button.querySelector('.file-download-spinner')) {
      button.insertAdjacentHTML('beforeend', '<span class="file-download-spinner">'
        + loadingSpinner({ size: 'small', label: 'Downloading file' }) + '</span>');
    }
  });
}

async function prepareViewedDownload(target) {
  if (!target.key) {
    const result = await requestProjectFiles('download', {
      projectHash: target.projectHash, path: target.path,
    }, { timeout: 30 * 60_000 });
    target.key = result.key;
  }
  return window.api('/api/bridge/file-url/' + target.key);
}

async function downloadViewedFile() {
  const target = _downloadTarget;
  if (!target || target.busy) return;
  target.busy = true;
  updateDownloadButtons();
  downloadStatus('Preparing download…');
  try {
    let result;
    if (target.sharedFile) {
      result = await shareDownloadedFile(target);
    } else {
      const file = await prepareViewedDownload(target);
      if (_downloadTarget !== target) return;
      downloadStatus('Downloading…');
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
    if (_downloadTarget === target) downloadStatus({
      saved: 'Saved to Downloads.', queued: 'Added to system Downloads.',
      shared: 'Shared.', cancelled: '', started: 'Download started.',
      share_opened: 'Download complete. System sharing opened.',
      ready: 'File ready. Tap Download again to open the system share sheet.',
    }[result.status] || 'Download started.');
  } catch (error) {
    if (_downloadTarget === target) downloadStatus(String(error.message || error));
  } finally {
    target.busy = false;
    if (_downloadTarget === target) updateDownloadButtons();
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

function requestFileAsync(absPath) {
  return requestProjectFiles('read', {
    projectHash: currentProjectHash(),
    path: absPath,
  }).catch(function () { return null; });
}

function overlay() { return document.getElementById('fileOverlay'); }

function clearFileBody() {
  const body = document.getElementById('fileOverlayBody');
  if (!body) return;
  _pdfLoadController?.abort();
  _pdfLoadController = null;
  _pdfPreview?.destroy();
  _pdfPreview = null;
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
function isPreviewable(path) { return isHtml(path) || isMarkdown(path); }

function showPreview(html) {
  setBody('<iframe class="file-preview" sandbox="allow-scripts allow-forms allow-popups allow-modals"></iframe>');
  var f = document.querySelector('#fileOverlayBody .file-preview');
  if (f) f.srcdoc = html;
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
    setBody('<div class="file-loading' + (attachment ? ' file-loading-delayed' : '') + '">'
      + (attachment ? '<span class="file-loading-content">' : '')
      + loadingSpinner({ label: 'Loading file' })
      + (attachment ? '</span>' : '') + '</div>');
    if (_view.path.startsWith('baton-file:')) return showAttachment(_view.path.slice('baton-file:'.length));
    return sendFileRequest(_view.path, _view.line, _view.snippet, 1);
  }
  if (mode !== 'preview') {
    return renderSource(_current.path, _current.text, _current.truncated, _current.line, _current.snippet);
  }
  if (isMarkdown(_current.path) && window.renderMd) {
    setBody('<div class="assistant-text md-preview">' + window.renderMd(_current.text) + '</div>');
    var mdDir = _current.path.slice(0, _current.path.lastIndexOf('/') + 1);
    var mdBody = document.querySelector('#fileOverlayBody .md-preview');
    if (mdBody) inlineImages(mdBody, mdDir); // mutates this node; harmless if view later changes
    return;
  }
  setBody('<div class="file-loading">'
    + loadingSpinner({ label: 'Loading preview' }) + '</div>');
  buildPreviewHtml(_current.text, _current.path).then(function (html) {
    if (token === _previewToken) showPreview(html);
  });
}

async function showDiff(loadDiff, token) {
  setBody('<div class="file-loading">'
    + loadingSpinner({ label: 'Loading diff' }) + '</div>');
  try {
    var results = await Promise.all([loadDiff(), window.loadDiffViewer?.()]);
    if (token !== _previewToken) return;
    var result = results[0];
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

// Replace relative <img src> in a live container with synced data URLs.
function inlineImages(container, dir) {
  var jobs = [];
  container.querySelectorAll('img[src]').forEach(function (el) {
    var src = el.getAttribute('src');
    if (!isRelativeUrl(src)) return;
    jobs.push(requestFileAsync(resolvePath(dir, src)).then(function (m) {
      if (m && m.ok !== false && m.image) return window.apiText('/api/bridge/image/' + m.key).then(function (b64) {
        var ext = (m.key.split('.').pop() || '').toLowerCase();
        var mime = ext === 'svg' ? 'image/svg+xml' : 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
        el.setAttribute('src', 'data:' + mime + ';base64,' + b64);
      });
    }));
  });
  return Promise.all(jobs);
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
        var cssPromise = m.content != null
          ? Promise.resolve(m.content)
          : window.apiText('/api/bridge/file/' + m.key);
        return cssPromise.then(function (css) {
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
        var scriptPromise = m.content != null
          ? Promise.resolve(m.content)
          : window.apiText('/api/bridge/file/' + m.key);
        return scriptPromise.then(function (js) {
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
  downloadStatus('');
  _fileRequestToken++;
  _previewToken++;
  setBody('');
  updateTabs();
  if (wasOpen && onClose) onClose(options);
  else if (wasOpen && options.refresh !== false) window.refreshProjectFiles?.();
  return wasOpen;
}

async function sendFileRequest(absPath, line, snippet, retriesLeft) {
  var token = ++_fileRequestToken;
  try {
    var message = await requestProjectFiles('read', {
      projectHash: _view.options.projectHash || currentProjectHash(),
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
  _view = { path: absPath, line: lineHint || '', snippet: matchId ? snippetForTool(matchId) : '', options: options };
  _downloadTarget = options.canRead === false ? null : { path: absPath, projectHash: options.projectHash || currentProjectHash(),
    key: absPath.startsWith('baton-file:') ? absPath.slice('baton-file:'.length) : '' };
  downloadStatus('');
  updateDownloadButtons();
  var titleEl = document.getElementById('fileOverlayTitle');
  titleEl.textContent = displayName || absPath;
  titleEl.title = absPath;
  _current = null;
  _previewToken++;
  updateTabs();
  o.style.display = 'flex';
  _edgeBack.activate();
  if (window.attachScrollIndicator) window.attachScrollIndicator(document.getElementById('fileOverlayBody'));
  setFileViewMode(options.loadDiff && options.mode !== 'source' ? 'diff' : 'source');
  return true;
}

async function showAttachment(key) {
  const token = ++_fileRequestToken;
  let pdfFallbackUrl = '';
  try {
    if (!/^[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/.test(key)) throw new Error('Invalid file key');
    const file = await window.api('/api/bridge/file-url/' + key);
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
    const url = escapeAttachment(file.previewUrl);
    if (file.previewType === 'application/pdf') {
      pdfFallbackUrl = url;
      if (!window.ResizeObserver || !window.requestAnimationFrame) {
        setBody('<iframe class="attachment-pdf" title="PDF preview" src="' + url + '"></iframe>');
        return;
      }
      const { mountPdfPreview, clearPdfRangeCache } = await import('../components/pdf-preview.js');
      if (token !== _fileRequestToken) return;
      _clearPdfRanges = clearPdfRangeCache;
      const cacheKey = state.SERVER + '|' + state.KEY + '|' + key + '|' + file.size;
      const showLoadingText = !_viewedPdfKeys.has(cacheKey);
      const body = document.getElementById('fileOverlayBody');
      const loading = body.querySelector('.file-loading');
      if (loading) {
        loading.querySelector('.loading-spinner')?.setAttribute('aria-label', 'Loading PDF');
        if (showLoadingText) {
          (loading.querySelector('.file-loading-content') || loading)
            .insertAdjacentHTML('beforeend', '<span>Loading PDF…</span>');
        }
      } else {
        setBody('<div class="file-loading file-loading-delayed"><span class="file-loading-content">'
          + loadingSpinner({ label: 'Loading PDF' })
          + (showLoadingText ? '<span>Loading PDF…</span>' : '') + '</span></div>');
      }
      const controller = new AbortController();
      _pdfLoadController = controller;
      const pdfPreview = await mountPdfPreview(body,
        file.previewUrl, file.size, controller.signal, cacheKey);
      if (_pdfLoadController === controller) _pdfLoadController = null;
      if (token !== _fileRequestToken) { pdfPreview.destroy(); return; }
      _pdfPreview = pdfPreview;
      await pdfPreview.ready;
      if (token === _fileRequestToken) {
        _viewedPdfKeys.delete(cacheKey);
        _viewedPdfKeys.add(cacheKey);
        if (_viewedPdfKeys.size > 100) _viewedPdfKeys.delete(_viewedPdfKeys.values().next().value);
      }
      return;
    } else if (file.previewType?.startsWith('image/')) {
      preview = '<img class="file-image" alt="" src="' + url + '">';
    } else if (file.previewType?.startsWith('video/')) {
      preview = '<video class="file-video" controls playsinline preload="metadata" src="' + url + '"></video>';
    } else if (file.previewType?.startsWith('audio/')) {
      preview = '<audio controls preload="metadata" src="' + url + '"></audio>';
    }
    setBody(preview);
  } catch (error) {
    if (token !== _fileRequestToken) return;
    if (pdfFallbackUrl) {
      setBody('<iframe class="attachment-pdf" title="PDF preview" src="' + pdfFallbackUrl + '"></iframe>');
    } else {
      setBody('<div class="file-error">' + escapeAttachment(error.message) + '</div>');
    }
  }
}

// Find the Edit/Write tool_use by id and return the text it wrote (new_string / content).
function snippetForTool(toolId) {
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

function render(absPath, text, truncated, lineHint, snippet) {
  _current = { path: absPath, text: text, truncated: truncated, line: lineHint, snippet: snippet };
  updateTabs();
  setFileViewMode(_view.mode);
}

function renderSource(absPath, text, truncated, lineHint, snippet) {
  var body = document.getElementById('fileOverlayBody');
  if (!body) return;
  clearFileBody();
  renderSourceView(body, {
    path: absPath,
    text: text,
    truncated: truncated,
    lineHint: lineHint,
    snippet: snippet,
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
    var ext = (msg.key.split('.').pop() || '').toLowerCase();
    var mime = ext === 'svg' ? 'image/svg+xml' : 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
    return window.getImageDataUrl(msg.key, mime).then(function (dataUrl) {
      if (token !== _fileRequestToken) return;
      closeFileViewer({ refresh: false });
      if (window.viewImage) window.viewImage(dataUrl);
    }).catch(function () {
      if (token === _fileRequestToken) setBody('<div class="file-error">Failed to download image.</div>');
    });
  }

  var cached = state.fileCache.get(msg.key);
  if (cached) return render(cached.path, cached.text, cached.truncated, line, snippet);

  var contentPromise = msg.content != null
    ? Promise.resolve(msg.content)
    : window.apiText('/api/bridge/file/' + msg.key);
  contentPromise.then(function (text) {
    if (token !== _fileRequestToken) return;
    if (state.fileCache.size > 50) state.fileCache.delete(state.fileCache.keys().next().value);
    state.fileCache.set(msg.key, { text: text, path: msg.path, truncated: msg.truncated });
    render(msg.path, text, msg.truncated, line, snippet);
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
