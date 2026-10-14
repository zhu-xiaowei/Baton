import { state } from '../state.js';
import { requestProjectFiles } from '../project/rpc.js';
import { loadVisualizationIcons } from './visualization-icons.js';

const previews = new WeakMap();
const documents = new Map();
const pending = new Map();
const selector = '.codex-visualization[data-visualization-path]';
const maxDocuments = 12;
const maxBytes = 1024 * 1024;
const themeProperties = {
  '--color-text-primary': 'light-dark(#24292f,#e6edf3)',
  '--color-text-secondary': 'light-dark(#656d76,#8b949e)',
  '--color-background-primary': 'light-dark(#fff,#0d1117)',
  '--color-background-secondary': 'light-dark(#f6f8fa,#161b22)',
  '--color-border-primary': 'light-dark(#d0d7de,#30363d)',
  '--font-sans': 'system-ui,sans-serif',
  '--font-mono': 'ui-monospace,monospace',
};
let fullscreen = null;
const fullscreenBack = window.registerEdgeBackLayer?.({
  navigateBack: closeVisualizationFullscreen,
  foregroundSelectors: ['.visualization-surface.is-fullscreen'],
  guardZIndex: 2002,
});

function captureVisualizationSnapshot() {
  const root = document.documentElement.cloneNode(true);
  const controls = root.querySelectorAll('input, textarea, select, canvas');
  document.querySelectorAll('input, textarea, select, canvas').forEach(function (source, index) {
    const copy = controls[index];
    if (source.tagName === 'INPUT') {
      copy.setAttribute('value', source.value);
      copy.toggleAttribute('checked', source.checked);
    } else if (source.tagName === 'TEXTAREA') {
      copy.textContent = source.value;
    } else if (source.tagName === 'SELECT') {
      copy.querySelectorAll('option').forEach(function (option, optionIndex) {
        option.toggleAttribute('selected', source.options[optionIndex].selected);
      });
    } else {
      try {
        const image = document.createElement('img');
        Array.from(copy.attributes).forEach(attribute => image.setAttribute(attribute.name, attribute.value));
        image.src = source.toDataURL();
        image.width = source.width;
        image.height = source.height;
        copy.replaceWith(image);
      } catch {}
    }
  });
  const styles = root.querySelectorAll('style');
  document.querySelectorAll('style').forEach(function (style, index) {
    try { styles[index].textContent = Array.from(style.sheet.cssRules, rule => rule.cssText).join('\n'); } catch {}
  });
  root.querySelectorAll('script').forEach(element => element.remove());
  return '<!doctype html>' + root.outerHTML;
}

function visualizationThemeDefaults(parsed) {
  const defined = new Set();
  const values = [];
  const readStyle = function (style) {
    Array.from(style).forEach(name => defined.add(name));
    values.push(style.cssText
      .replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, ''));
  };
  const readRules = function (rules) {
    for (const rule of rules) {
      if (typeof rule.name === 'string' && 'initialValue' in rule) defined.add(rule.name);
      if (rule.style) readStyle(rule.style);
      if (rule.cssRules) readRules(rule.cssRules);
    }
  };
  parsed.querySelectorAll('[style]').forEach(element => readStyle(element.style));
  for (const element of parsed.querySelectorAll('style')) {
    if (element.type && element.type.toLowerCase() !== 'text/css') continue;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(element.textContent);
      readRules(sheet.cssRules);
    } catch {
      return '';
    }
  }
  const missing = Object.entries(themeProperties).filter(([name]) => {
    if (defined.has(name)) return false;
    const reference = new RegExp('(?:^|[^\\w-])var\\(\\s*' + name + '\\s*\\)');
    return values.some(value => reference.test(value));
  });
  const adaptive = values.some(value => /(?:^|[^\w-])light-dark\s*\(/i.test(value))
    || missing.some(([name]) => name.startsWith('--color-'));
  const hostScheme = getComputedStyle(document.documentElement).colorScheme;
  const scheme = adaptive && !parsed.querySelector('meta[name="color-scheme" i]')
    ? 'color-scheme:' + (/^(?:only )?(?:dark|light)$/.test(hostScheme) ? hostScheme : 'dark') + ';' : '';
  return scheme + missing.map(([name, value]) => name + ':' + value + ';').join('');
}

export function createVisualizationDocument(content, channel, iconRuntime = '') {
  const parsed = new DOMParser().parseFromString(content, 'text/html');
  parsed.querySelectorAll('base, meta[http-equiv]').forEach(function (element) { element.remove(); });
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
    + "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; "
    + "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const channelLiteral = JSON.stringify(channel).replace(/</g, '\\u003c');
  const meta = function (attributes) {
    const element = parsed.createElement('meta');
    Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
    return element;
  };
  const defaults = parsed.createElement('style');
  defaults.textContent = '@layer baton-visualization-defaults{:where(html){'
    + visualizationThemeDefaults(parsed) + 'font:14px/1.5 var(--font-sans,system-ui,sans-serif)}'
    + ':where(html,body){margin:0;padding:0}:where(body){overflow-wrap:anywhere}'
    + ':where(img){max-width:100%}}';
  const bootstrap = parsed.createElement('script');
  bootstrap.textContent = 'addEventListener("DOMContentLoaded",function(){'
    + 'var snapshot=' + captureVisualizationSnapshot.toString() + ';'
    + 'addEventListener("message",function(event){'
    + 'if(event.source!==parent||event.data?.type!=="baton-visualization-snapshot-request"'
    + '||event.data.channel!==' + channelLiteral + ')return;'
    + 'parent.postMessage({type:"baton-visualization-snapshot",channel:' + channelLiteral
    + ',requestId:event.data.requestId,html:snapshot()},"*")});'
    + 'var scheduled=false;function report(){if(scheduled)return;scheduled=true;'
    + 'requestAnimationFrame(function(){scheduled=false;parent.postMessage({type:"baton-visualization-size",'
    + 'channel:' + channelLiteral + ',height:Math.ceil(Math.max(document.body.scrollHeight,'
    + 'document.body.getBoundingClientRect().height))},"*")})}'
    + 'if(typeof ResizeObserver!=="undefined")new ResizeObserver(report).observe(document.body);'
    + 'addEventListener("load",report);report();'
    + 'document.addEventListener("click",function(event){if(event.target.closest("a[href]"))event.preventDefault();report()},true);'
    + 'document.addEventListener("submit",function(event){event.preventDefault()},true);'
    + 'document.addEventListener("keydown",function(event){if(event.key==="Escape")'
    + 'parent.postMessage({type:"baton-visualization-close",channel:' + channelLiteral + '},"*")});'
    + '});';
  const additions = [
    meta({ charset: 'utf-8' }),
    meta({ 'http-equiv': 'Content-Security-Policy', content: policy }),
    meta({ name: 'referrer', content: 'no-referrer' }),
  ];
  if (!parsed.querySelector('meta[name="viewport" i]')) {
    additions.push(meta({ name: 'viewport', content: 'width=device-width, initial-scale=1' }));
  }
  additions.push(defaults);
  if (iconRuntime) {
    const icons = parsed.createElement('script');
    icons.textContent = iconRuntime;
    additions.push(icons);
  }
  additions.push(bootstrap);
  parsed.head.prepend(...additions);
  return '<!doctype html>' + parsed.documentElement.outerHTML;
}

function createVisualizationSnapshot(content, channel) {
  const parsed = new DOMParser().parseFromString(createVisualizationDocument(content, channel), 'text/html');
  parsed.querySelectorAll('script').forEach(element => element.remove());
  return '<!doctype html>' + parsed.documentElement.outerHTML;
}

function requestFullscreenSnapshot() {
  if (!fullscreen?.snapshot) return;
  fullscreen.preview.frame.contentWindow.postMessage({
    type: 'baton-visualization-snapshot-request', channel: fullscreen.preview.channel,
    requestId: fullscreen.snapshotId,
  }, '*');
}

function context() {
  const project = state.appState.project;
  return {
    device: state.appState.device || '',
    projectHash: (typeof project === 'string' ? project : project?.hash) || state.wsProjectHash || '',
    sessionId: state.activeThreadId || state.wsSessionId || state.appState.session || '',
  };
}

function contextKey(value) {
  return JSON.stringify([value.device, value.projectHash, value.sessionId]);
}

function projectRelativePath(normalized, projectHash) {
  if (!projectHash) return null;
  const parts = normalized.split('/');
  for (let length = parts.length - 1; length > 0; length--) {
    const directory = parts.slice(0, length).join('/') || '/';
    const candidates = [directory];
    if (/^[a-z]:/i.test(directory)) {
      const drive = directory[0].toUpperCase();
      candidates.push(drive + directory.slice(1), drive + directory.slice(2));
    }
    if (candidates.some(candidate => candidate.replace(/[^a-zA-Z0-9-]/g, '-') === projectHash)) {
      return parts.slice(length).join('/');
    }
  }
  return null;
}

export function validateVisualizationPath(filePath, sessionId, projectHash = '') {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const thread = String(sessionId || '').replace(/^codex:/, '');
  const match = normalized.match(/\/visualizations\/\d{4}\/\d{2}\/\d{2}\/([\da-f-]+)\/[^/]+\.html?$/i);
  if (!/^(?:\/|[a-z]:\/)/i.test(normalized) || /[\x00-\x1f]/.test(normalized)
    || normalized.split('/').some(part => part === '.' || part === '..')
    || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(thread)
    || !/\.html?$/i.test(normalized)) {
    throw new Error('Preview must reference an HTML artifact from this session or its project.');
  }
  const relativePath = projectRelativePath(normalized, projectHash);
  if (relativePath) return relativePath;
  if (match && match[1] === thread) return filePath;
  throw new Error('Preview must reference an HTML artifact from this session or its project.');
}

async function fetchDocument(filePath, current, reload) {
  const key = JSON.stringify([contextKey(current), filePath]);
  if (reload) documents.delete(key);
  if (documents.has(key)) return documents.get(key);
  if (pending.has(key)) return pending.get(key);
  const requestPath = validateVisualizationPath(filePath, current.sessionId, current.projectHash);
  const promise = requestProjectFiles('read', {
    projectHash: current.projectHash,
    path: requestPath,
  }).then(async function (response) {
    if (response.truncated || response.size > maxBytes || response.image || response.video) {
      throw new Error('Preview must be an HTML file no larger than 1 MB.');
    }
    let content = response.content;
    if (!content && response.key && response.size > 0) {
      content = await window.apiText('/api/bridge/file/' + encodeURIComponent(response.key));
    }
    if (typeof content !== 'string') throw new Error('Preview content is unavailable.');
    if (new TextEncoder().encode(content).length > maxBytes || content.includes('\0')) {
      throw new Error('Preview must be HTML text no larger than 1 MB.');
    }
    documents.set(key, content);
    while (documents.size > maxDocuments) documents.delete(documents.keys().next().value);
    return content;
  }).finally(function () { pending.delete(key); });
  pending.set(key, promise);
  return promise;
}

function followVisualizationBottom(block) {
  if (!state.stickBottom || fullscreen || !block.isConnected) return;
  const scrollContainer = block.closest('#content');
  if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
}

export async function loadVisualization(block, reload = false) {
  if (previews.has(block) && !reload) return;
  const current = context();
  const preview = { context: contextKey(current) };
  previews.set(block, preview);
  if (fullscreen?.block === block) closeVisualizationFullscreen();
  block.querySelector('.visualization-surface')?.remove();
  const status = block.querySelector('.visualization-status');
  status.hidden = false;
  status.removeAttribute('role');
  status.innerHTML = window.loadingSpinner?.({ label: 'Loading preview' }) || '';
  try {
    if (!current.device || !current.projectHash || !current.sessionId) {
      throw new Error('Open the original session to load this preview.');
    }
    const content = await fetchDocument(block.dataset.visualizationPath, current, reload);
    const iconRuntime = /\b(?:data-lucide|lucide)\b/.test(content) ? await loadVisualizationIcons() : '';
    if (!block.isConnected || previews.get(block) !== preview || contextKey(context()) !== preview.context) return;
    preview.content = content;
    preview.channel = crypto.randomUUID();
    const surface = document.createElement('dialog');
    surface.className = 'visualization-surface';
    surface.open = true;
    const title = block.dataset.visualizationPath.split(/[\\/]/).pop();
    surface.setAttribute('aria-label', title);
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'visualization-expand';
    expand.setAttribute('aria-label', 'Fullscreen preview');
    expand.title = 'Fullscreen preview';
    expand.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>';
    expand.addEventListener('click', function () { openVisualizationFullscreen(block); });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'visualization-close';
    close.setAttribute('aria-label', 'Close fullscreen preview');
    close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m6 6 12 12M6 18 18 6"/></svg>';
    close.addEventListener('click', closeVisualizationFullscreen);
    surface.addEventListener('cancel', function (event) { event.preventDefault(); closeVisualizationFullscreen(); });
    const frame = document.createElement('iframe');
    frame.className = 'visualization-frame';
    frame.title = title;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
    frame.srcdoc = createVisualizationDocument(content, preview.channel, iconRuntime);
    frame.addEventListener('load', function () {
      if (fullscreen?.block === block) requestFullscreenSnapshot();
    });
    preview.frame = frame;
    preview.surface = surface;
    surface.append(frame, expand, close);
    block.appendChild(surface);
    status.hidden = true;
    followVisualizationBottom(block);
  } catch (error) {
    if (previews.get(block) !== preview) return;
    preview.failed = true;
    status.setAttribute('role', 'status');
    status.textContent = 'Preview unavailable: ' + error.message;
  }
}

export function hydrateVisualizations(root) {
  if (root.matches?.(selector)) loadVisualization(root);
  root.querySelectorAll?.(selector).forEach(function (block) { loadVisualization(block); });
}

export function openVisualizationFullscreen(block) {
  const preview = previews.get(block);
  if (!preview?.surface || fullscreen?.block === block) return;
  closeVisualizationFullscreen();
  const scrollContainer = block.closest('#content');
  fullscreen = {
    block, preview, previousFocus: document.activeElement,
    minHeight: block.style.minHeight,
    scrollContainer, scrollTop: scrollContainer?.scrollTop,
  };
  block.style.minHeight = block.getBoundingClientRect().height + 'px';
  if (window.__BATON_NATIVE_MOBILE__) {
    const snapshot = preview.frame.cloneNode(false);
    snapshot.classList.add('visualization-snapshot');
    snapshot.setAttribute('sandbox', '');
    snapshot.setAttribute('aria-hidden', 'true');
    snapshot.tabIndex = -1;
    snapshot.inert = true;
    snapshot.srcdoc = createVisualizationSnapshot(preview.content, preview.channel);
    fullscreen.snapshot = snapshot;
    fullscreen.snapshotId = crypto.randomUUID();
    block.appendChild(snapshot);
  }
  preview.surface.classList.add('is-fullscreen');
  if (!window.__BATON_NATIVE_MOBILE__ && preview.surface.showModal) {
    preview.surface.close();
    preview.surface.showModal();
  }
  fullscreenBack?.activate();
  requestFullscreenSnapshot();
  preview.surface.querySelector('.visualization-close').focus({ preventScroll: true });
}

export function closeVisualizationFullscreen() {
  if (!fullscreen) return false;
  const { block, preview, previousFocus, minHeight, scrollContainer, scrollTop, snapshot } = fullscreen;
  fullscreen = null;
  if (preview.surface.close) preview.surface.close();
  preview.surface.classList.remove('is-fullscreen');
  preview.surface.open = true;
  snapshot?.remove();
  block.style.minHeight = minHeight;
  fullscreenBack?.deactivate();
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  if (block.isConnected && scrollContainer?.isConnected) scrollContainer.scrollTop = scrollTop;
  return true;
}

document.addEventListener('keydown', function (event) {
  if (event.key === 'Escape') closeVisualizationFullscreen();
});

window.addEventListener('message', function (event) {
  if (!['baton-visualization-size', 'baton-visualization-close', 'baton-visualization-snapshot'].includes(event.data?.type)) return;
  document.querySelectorAll(selector).forEach(function (block) {
    const preview = previews.get(block);
    if (!preview?.frame || event.source !== preview.frame.contentWindow
      || event.data.channel !== preview.channel) return;
    if (event.data.type === 'baton-visualization-close') {
      if (fullscreen?.block === block) closeVisualizationFullscreen();
      return;
    }
    if (event.data.type === 'baton-visualization-snapshot') {
      if (fullscreen?.block === block && fullscreen.snapshot && event.data.requestId === fullscreen.snapshotId
        && typeof event.data.html === 'string' && event.data.html.length <= maxBytes
        && event.data.html !== fullscreen.snapshotHtml) {
        fullscreen.snapshotHtml = event.data.html;
        fullscreen.snapshot.srcdoc = createVisualizationSnapshot(event.data.html, preview.channel);
      }
      return;
    }
    if (!Number.isFinite(event.data.height)) return;
    if (fullscreen?.block === block) { requestFullscreenSnapshot(); return; }
    const height = Math.max(180, Math.min(900, event.data.height + 2)) + 'px';
    if (preview.frame.style.height === height) return;
    preview.frame.style.height = height;
    followVisualizationBottom(block);
  });
});

const observer = new MutationObserver(function (records) {
  if (fullscreen && !fullscreen.block.isConnected) closeVisualizationFullscreen();
  records.forEach(function (record) {
    record.addedNodes.forEach(function (node) {
      if (node.nodeType === 1) hydrateVisualizations(node);
    });
  });
});
observer.observe(document.body, { childList: true, subtree: true });
hydrateVisualizations(document.body);

function retryFailedPreviews() {
  if (document.visibilityState === 'hidden') return;
  document.querySelectorAll(selector).forEach(function (block) {
    if (previews.get(block)?.failed) loadVisualization(block, true);
  });
}

window.addEventListener('online', retryFailedPreviews);
document.addEventListener('visibilitychange', retryFailedPreviews);
