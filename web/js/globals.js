// Pin npm-installed libs onto window so legacy IIFE modules can read them as bare globals.
// Imported FIRST in entry-index.js so it fully executes before any IIFE module runs.
import { marked } from 'marked';
import hljs from 'highlight.js';
import * as Diff from 'diff';
import { Diff2HtmlUI } from 'diff2html/lib-esm/ui/js/diff2html-ui';

window.marked = marked;
window.hljs = hljs;
window.Diff = Diff;
window.Diff2HtmlUI = Diff2HtmlUI;
