# Internal browser

`openBrowserPage()` renders a full-page browser surface with one toolbar:
back, forward, reload, an editable address, external browser, and close.
The toolbar reuses the shared `path-breadcrumb` header and `workspace-switch`
buttons used by the project file and Git pages, including native safe areas.

The caller owns connections and supplies `resolveAddress`, `onExternal`, and
`onClose` when needed. Closing this surface does not stop a preview tunnel.
`setUrl()` loads a resolved URL; `setError()` displays a navigation failure.

The frame bridge reports real document navigation, hash changes and History
API changes. Tauri injects it in child frames without exposing native commands.
The parent checks the frame, navigation token and message origin. Same-origin
web previews install the same bridge after loading; arbitrary cross-origin
web previews require the native injection for complete history tracking.

For a local visual check, open the existing `/landing.html?browser=<URL>` page
while Vite is running. This development-only entry renders the actual site,
not a separate demonstration page.
