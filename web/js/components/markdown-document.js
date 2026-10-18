// GitHub-style rendering for project Markdown files (README etc.).
import DOMPurify from 'dompurify';

// GitHub's allowlist (html-pipeline SanitizationFilter) plus <picture>/<source> and task-list checkboxes.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'b', 'i', 'strong', 'em', 'a', 'pre', 'code', 'img', 'tt',
  'div', 'ins', 'del', 'sup', 'sub', 'p', 'ol', 'ul', 'table', 'thead', 'tbody', 'tfoot', 'blockquote',
  'dl', 'dt', 'dd', 'kbd', 'q', 'samp', 'var', 'hr', 'ruby', 'rt', 'rp', 'li', 'tr', 'td', 'th', 's',
  'strike', 'summary', 'details', 'caption', 'figure', 'figcaption', 'abbr', 'bdo', 'cite', 'dfn',
  'mark', 'small', 'span', 'time', 'wbr', 'picture', 'source', 'input',
];
const ALLOWED_ATTR = [
  'href', 'src', 'srcset', 'media', 'longdesc', 'cite', 'abbr', 'align', 'alt', 'aria-describedby',
  'aria-hidden', 'aria-label', 'aria-labelledby', 'axis', 'border', 'cellpadding', 'cellspacing',
  'char', 'charoff', 'clear', 'cols', 'colspan', 'color', 'compact', 'datetime', 'dir', 'headers',
  'height', 'hreflang', 'hspace', 'lang', 'nowrap', 'open', 'rel', 'rev', 'role', 'rows', 'rowspan',
  'rules', 'scope', 'span', 'start', 'summary', 'title', 'valign', 'value', 'vspace', 'width',
  'checked', 'disabled', 'type', 'data-baton-slot',
];
// DOMPurify's default URI rule, plus `dir/file.ext:12` links, which (as in chat) open a file at a line.
const ALLOWED_URI_REGEXP = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$)|[^:?#]*[./][^:?#]*:\d+(?:-\d+)?$)/i;
const ALERTS = { NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important', WARNING: 'Warning', CAUTION: 'Caution' };

const purify = DOMPurify(window);
const SHORTCODE = /:([a-z0-9_+-]+):/g;
let emojiNames = null;

// GitHub's shortcode list (gemoji), loaded only for documents that contain one.
async function loadEmoji(text) {
  if (emojiNames || !new RegExp(SHORTCODE.source).test(text)) return;
  emojiNames = new Map(Object.entries((await import('./emoji-shortcodes.js')).default));
}

function replaceShortcodes(root) {
  if (!emojiNames) return;
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const nodes = [];
  while (walker.nextNode()) {
    if (walker.currentNode.data.includes(':') && !walker.currentNode.parentElement.closest('code, pre')) {
      nodes.push(walker.currentNode);
    }
  }
  nodes.forEach((node) => {
    node.data = node.data.replace(SHORTCODE, (match, name) => emojiNames.get(name) || match);
  });
}

// Baton is always dark, so color-scheme queries are fixed to dark (also inside SVG images,
// where WebKit follows the OS appearance instead of the page's color-scheme).
export function darkColorScheme(css) {
  return css
    .replace(/\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi, '(min-width: 0px)')
    .replace(/\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi, '(max-width: 0px)');
}

function isRelative(url) {
  return !!url && !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url);
}

// Relative assets are resolved by the file viewer; moving them keeps the browser from requesting them
// against the app origin first.
function prepareMedia(root) {
  root.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (/#gh-light-mode-only$/.test(src)) { img.remove(); return; }
    if (!isRelative(src)) return;
    img.dataset.mdSrc = src;
    img.removeAttribute('src');
  });
  root.querySelectorAll('source').forEach((source) => {
    const media = source.getAttribute('media');
    if (media) source.setAttribute('media', darkColorScheme(media));
    const srcset = source.getAttribute('srcset');
    if (!srcset || !srcset.split(',').some((part) => isRelative(part.trim().split(/\s+/)[0]))) return;
    source.dataset.mdSrcset = srcset;
    source.removeAttribute('srcset');
  });
}

// github-slugger: lowercase, drop punctuation, spaces to dashes, de-duplicate with -1, -2 ...
function addHeadingIds(root) {
  const seen = new Map();
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const base = heading.textContent.trim().toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '').replace(/ /g, '-');
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    heading.id = 'user-content-' + (count ? base + '-' + count : base);
  });
}

function addAlerts(root) {
  root.querySelectorAll('blockquote').forEach((quote) => {
    const first = quote.firstElementChild;
    const text = first?.tagName === 'P' ? first.firstChild : null;
    const match = text?.nodeType === 3 && /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/i.exec(text.data);
    if (!match) return;
    text.data = text.data.slice(match[0].length);
    if (first.firstChild === text && !text.data.trim()) text.remove();
    if (first.firstChild?.tagName === 'BR') first.firstChild.remove();
    if (!first.childNodes.length) first.remove();
    const kind = match[1].toUpperCase();
    const alert = root.ownerDocument.createElement('div');
    alert.className = 'markdown-alert markdown-alert-' + kind.toLowerCase();
    const title = root.ownerDocument.createElement('p');
    title.className = 'markdown-alert-title';
    title.textContent = ALERTS[kind];
    alert.append(title, ...quote.childNodes);
    quote.replaceWith(alert);
  });
}

function sanitize(html) {
  const root = purify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP, ALLOW_DATA_ATTR: false, RETURN_DOM: true });
  prepareMedia(root);
  addHeadingIds(root);
  addAlerts(root);
  replaceShortcodes(root);
  return root;
}

export async function renderMarkdownDocument(text) {
  await loadEmoji(text || '').catch(() => {});
  return window.renderMdDocument(text, sanitize);
}
