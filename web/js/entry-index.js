// Entry for index.html — main viewer page
// Imports CSS, vendors CDN libs to window globals, then loads the legacy IIFE app modules in order.

// CSS (vite bundles into the HTML)
import 'highlight.js/styles/vs2015.css';
import 'diff2html/bundles/css/diff2html.min.css';
import '../css/style.css';

// Globals MUST be imported and fully executed before any IIFE module runs.
// (A separate module ensures its window.X = ... assignments complete before markdown.js et al.)
import './globals.js';

// App modules — order matters (api defines KEY/SERVER/WS_URL first; ws/app reference them)
import './api.js';
import './components/skeleton.js';
import './components/markdown.js';
import './components/tool.js';
import './components/message.js';
import './components/permission.js';
import './components/typing-status.js';
import './components/image.js';
import './render.js';
import './ws.js';
import './app.js';
import './scroll-indicator.js';
