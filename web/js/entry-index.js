// Entry for index.html — first-paint modules only.
// Viewer libs and modules are loaded
// lazily by globals.js -> loadViewerLibs(), triggered after the inline shell renders
// the device list. Diff rendering stays deferred until an Edit is expanded.

import './state.js';
import './api.js';
import './components/skeleton.js';
import './globals.js';   // defines window.loadViewerLibs (does NOT download libs yet)
import './app.js';
import './scroll-indicator.js';

// Replay any clicks queued by the inline shell before app.js was ready.
if (Array.isArray(window.__navQueue)) {
  var q = window.__navQueue;
  window.__navQueue = null;
  for (var i = 0; i < q.length; i++) { try { q[i](); } catch (e) {} }
}

// Preheat viewer libs after 1.5s — yields IPC/main thread to navigation on Tauri.
if (window.__preheatViewer) setTimeout(window.loadViewerLibs, 1500);
