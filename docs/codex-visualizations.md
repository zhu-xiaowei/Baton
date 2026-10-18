# Codex inline HTML previews

Codex messages can contain a local artifact reference rather than HTML:

```text
visualize{"path":"/absolute/codex-home/visualizations/YYYY/MM/DD/THREAD_ID/example.html"}
```

The Markdown tokenizer recognizes complete references outside code spans/fences.
History and streaming messages display the HTML directly, without a filename
header, Source or Reload controls. A small corner button opens a full-screen
dialog. Closing it or pressing Escape returns to the inline preview.
On mouse-only devices the expand button appears on preview hover or keyboard
focus. Touch and hybrid devices keep it visible, with a 44-pixel touch target
around the 32-pixel visual button. The full-screen close button stays visible.
The same iframe stays mounted, so interactive
state survives fullscreen transitions. Streaming also preserves standalone
preview cards while following text arrives. Invalid or incomplete markers
stay visible as text.

The client reuses the deployed `project_files` / `read` operation with the
original device, the string `state.appState.project.hash`, and the absolute
artifact path. It requires no new server operation or Bridge restart. The
existing account/connection-scoped WebSocket relay returns ordered text frames.
Larger files follow the existing file viewer's upload/download path. No
`file://` URL is loaded on the viewing device.

Before requesting a file, the frontend accepts an absolute HTML path either in
the current project or in a dated `visualizations/YYYY/MM/DD/THREAD_ID/`
directory matching the active thread, without traversal components. Project
artifacts such as `output/design-preview/preview.html` are supported
without moving or rewriting the original file or conversation. An ancestor's
encoded project hash identifies the relative suffix; project-local requests
send only that suffix to the Bridge, whose existing relative-file reader checks
the real project root and rejects symlink escapes. Hash collisions cannot grant
access to files outside the Bridge's resolved project root.

It rejects truncated, binary, non-text and over-1-MiB responses. The session
directory reference check is not a filesystem security boundary: those absolute
reads retain the existing file viewer's permissions and symlink behavior.
The old extra `visualize` operation was removed because
deployed servers rejected it without a correlated reply, causing a timeout.

Content runs in a separate `iframe srcdoc` with `sandbox="allow-scripts"` and no
same-origin permission, top navigation, popups, forms, downloads or native IPC
permissions. A restrictive CSP blocks external scripts, styles, images and
fetches. Inline CSS/JavaScript and embedded images work without changing the
host document. Resize messages require the iframe's window and a per-preview
channel, and height is bounded. The artifact is never inserted as host HTML.

Lucide is pinned as a local application dependency, not loaded from a CDN. Its
runtime chunk is requested only when an artifact uses `data-lucide` or the
`lucide` global, then embedded inside the isolated iframe before artifact
scripts run. Static placeholders initialize automatically; dynamic content can
call `lucide.createIcons()`. Icons default to 16 pixels and `currentColor`, while
explicit sizes, colors, classes and accessibility attributes remain intact.

The iframe inherits the application's selected color scheme, so adaptive
previews follow the application theme even when the browser prefers another
scheme. Native `color-scheme` declarations and `prefers-color-scheme` media
queries remain in control. For fragments using CSS `light-dark()` or unresolved
supported host color variables, a low-priority dual-scheme default supplies the
missing capability. Only CSS declarations are inspected; text, scripts, comments
and string literals do not opt a document into theme adaptation. Inspection
uses detached stylesheets without loading imports; if unavailable, native
rendering is retained.

Fixed-color and unknown documents are not opted into a dark palette. No body
background, text color, SVG fill/stroke or image filter is injected. Original
`html`/`body` attributes, inline styles, classes, color-scheme metadata and
viewport metadata are retained. Compatibility variables are supplied only when
referenced without a fallback and not defined by the artifact. All defaults sit
in the first cascade layer, below authored styles, including authored layers.
The preview shell and fullscreen controls follow the application theme without
reloading the iframe or changing the artifact's interactive state.

This is artifact-format compatibility, not an implementation of the entire
Codex visualization runtime. Host-provided libraries such as `Tweak`, remote
dependencies and relative asset files are not provided.
References outside both the current project and the dated thread directory
are deliberately unsupported.
Missing files/offline devices show an error. Failed previews retry when network
connectivity returns or the page becomes visible again. The original device
must be online for the first load; a small memory cache is scoped to
device/project/thread/path.
