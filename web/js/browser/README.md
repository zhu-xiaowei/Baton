# Internal browser

`openBrowserPage()` renders a full-page browser surface with one toolbar:
back and forward on the left, an editable address in the middle, and external
browser and close on the right. The address contains a reload button that
switches to stop while loading. Stop cancels navigation without closing the
preview or disconnecting a port; bridged frames retain partially loaded content.
Before a cross-origin frame has a bridge, stopping may clear that frame.
The toolbar reuses the shared `path-breadcrumb` header and `workspace-switch`
buttons used by the project file and Git pages, including native safe areas.
Mobile toolbar sizing follows touch interaction capabilities rather than
viewport width, so narrow desktop windows keep their compact controls.
Its address-bar loading line moves forward once, reaches the end when the
document is ready, and fades out. Native frames report `DOMContentLoaded`
and `pageshow`; inaccessible web frames fall back to the iframe `load` event.
The line is an estimated loading indicator, not a byte-transfer percentage.
Callers can provide `initialAddress` to fill the address before resolving a
connection. A new document following a redirect restarts the loading line.

The caller owns connections and supplies `resolveAddress`, `onExternal`,
`onStop`, and `onClose` when needed. `onStop` cancels caller-owned pending
navigation without cancelling the connection. Closing this surface does not
stop a preview tunnel.
Local previews keep at most one suspended page in memory. Reopening the same
loaded target resumes it without reloading; another target, deleting its
connection, signing out, or closing the app destroys it. This does not expire
or clear the remote site's browser storage. The generic component exposes
`keepAlive` and `resume()` for this lifecycle.
The retained document stays live while hidden; the reload button explicitly
requests fresh content.
Native session pages prewarm at most one visible loopback link after a short
idle delay. This establishes the validated tunnel but does not load the site
or save a new port entry. Clicking adopts the same connection; leaving the
session or closing the app releases an unused prewarm. Scrolling within the
same session keeps it, and adopted connections retain the normal explicit
delete lifecycle. There is no time-based prewarm expiration.
The device capsule in the connection manager refreshes saved port connections:
live tunnels recheck their remote port, and disconnected records reuse the
normal connection flow. Opening the manager still renders current state
immediately rather than scanning for additional remote ports.
`setUrl()` loads a resolved URL; `setError()` displays a navigation failure.
Bare domains such as `baidu.com` are normalized to HTTPS; explicit HTTP/HTTPS
URLs and relative paths are also supported. External sites navigate directly
and do not create a remote port-forwarding connection.

The frame bridge reports real document navigation, hash changes and History
API changes. Tauri injects it in child frames without exposing native commands.
The parent checks the frame, navigation token and message origin. Same-origin
web previews install the same bridge after loading; arbitrary cross-origin
web previews require the native injection for complete history tracking.

Local development uses the same device-level Remote preview entry and
session links as the production app; there is no separate self-test page.
