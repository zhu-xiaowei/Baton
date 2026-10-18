const HIGHLIGHT_MAX = 300 * 1024;

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function resolveSourceRange(fileText, lineHint, snippet) {
  if (snippet) {
    var snippetLines = snippet.replace(/\s+$/, '').split('\n').map(function (line) {
      return line.trim();
    });
    while (snippetLines.length && !snippetLines[snippetLines.length - 1]) snippetLines.pop();
    if (snippetLines.length && snippetLines[0]) {
      var fileLines = fileText.split('\n');
      var last = fileLines.length - snippetLines.length;
      var found = null;
      for (var index = 0; index <= last; index++) {
        if (fileLines[index].trim() !== snippetLines[0]) continue;
        var matches = true;
        for (var offset = 1; offset < snippetLines.length; offset++) {
          if (fileLines[index + offset].trim() !== snippetLines[offset]) {
            matches = false;
            break;
          }
        }
        if (matches) {
          if (found) { found = null; break; }
          found = { from: index + 1, to: index + snippetLines.length };
        }
      }
      if (found) return found;
    }
  }
  var range = String(lineHint || '').match(/(\d+)(?:-(\d+))?/);
  if (!range) return null;
  return {
    from: Number(range[1]),
    to: range[2] ? Number(range[2]) : Number(range[1]),
  };
}

function highlightedSource(path, text) {
  var language = window.detectLang ? window.detectLang(path) : null;
  // Unknown extensions stay plain text: detection is slow and wrong for logs.
  if (!language || text.length > HIGHLIGHT_MAX || !window.hljs?.getLanguage(language)) return esc(text);
  try {
    return window.hljs.highlight(text, { language: language, ignoreIllegals: true }).value;
  } catch (error) {
    return esc(text);
  }
}

function scrollToSourceLine(container, line, total) {
  var content = container.querySelector('.file-content');
  if (!content || !total) return;
  var y = content.offsetTop + (content.scrollHeight / total) * (line - 1);
  container.scrollTop = Math.max(0, y - container.clientHeight / 2);
}

export function renderSourceView(container, options) {
  options = options || {};
  var text = String(options.text == null ? '' : options.text);
  var code = highlightedSource(options.path || '', text);
  var language = window.detectLang ? window.detectLang(options.path || '') : null;
  var pendingLanguage = language && text.length <= HIGHLIGHT_MAX && window.hljs
    && !window.hljs.getLanguage(language) && window.loadHljsLanguage ? language : '';
  var lineCount = code.split('\n').length;
  var range = Array.isArray(options.ranges) ? null : resolveSourceRange(text, options.lineHint, options.snippet);
  var ranges = Array.isArray(options.ranges) ? options.ranges : (range ? [range] : []);
  ranges = ranges.slice().sort((left, right) => left.from - right.from);
  var rangeIndex = 0;
  var lineNumbers = Array.from({ length: lineCount }, function (_, index) {
    var line = index + 1;
    while (ranges[rangeIndex] && line > ranges[rangeIndex].to) rangeIndex++;
    var currentRange = ranges[rangeIndex];
    var highlighted = currentRange && line >= currentRange.from && line <= currentRange.to;
    return highlighted ? '<span class="file-line-hl"'
      + (currentRange.deletion ? ' title="Deleted content at this position"' : '')
      + '>' + line + '</span>' : String(line);
  }).join('\n');
  var warning = options.truncated
    ? '<div class="file-truncated">⚠ Download to view full content</div>'
    : '';
  container.innerHTML = '<div class="file-code"><pre class="file-lineno">'
    + lineNumbers + '</pre><pre class="file-content"><code'
    + (pendingLanguage ? ' data-hljs-language="' + pendingLanguage + '"' : '') + '>' + code
    + '</code></pre></div>' + warning;
  if (pendingLanguage) window.loadHljsLanguage(pendingLanguage);
  if (ranges.length) scrollToSourceLine(container, ranges[0].from, lineCount);
}
