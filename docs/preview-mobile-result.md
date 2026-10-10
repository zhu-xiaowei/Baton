# Remote preview mobile validation

The remote test service runs Vite on the EC2 host at `127.0.0.1:5173`.
It serves `preview-target.html`, which fetches `/js/ws.js` (546,477
bytes) and displays a completion message only after the whole file arrives.
The test Bridge uses a separate, temporary API key and advertises itself
as `test-ec2-preview`.

## Android

AWS Device Farm Appium run
`arn:aws:devicefarm:us-west-2:949580910056:run:235b7700-e8db-43f3-b086-8a834566ba9f/d80de58f-fad6-4e1a-81e1-70d2a340b99f`
passed on a Google Pixel 8a. Appium required the completion message in
the Chrome Custom Tab's rendered page before reporting success. Its
screenshot is in
`.test-runs/preview-mobile/artifacts-android-r6/remote-preview-pass.png`.

An earlier run opened the Custom Tab but displayed a blank page. The
native TCP listener accepted Chrome's connection, while the frontend
discarded its `preview-socket-open` event because the frontend UUID
pattern omitted one field. The corrected pattern and a regression test
now accept the full stream ID. A later test that accepted the first 64
KiB of traffic was replaced with the rendered page check above.

## iOS

Draft PR #21 uses GitHub Actions on `macos-26` to build and upload an
unsigned test IPA. AWS Device Farm accepted and installed that IPA on an
iPhone 16. The temporary test account was injected during the PR build;
the GitHub Actions secrets are temporary.

Initial iOS runs opened the local proxy but received zero response bytes.
Diagnostic frames showed that the browser sent an HTTP request through
the tunnel to the EC2 Bridge. The Bridge wrote it to Vite and queued
ACK and response frames. The iPhone's local TCP socket closed before
the response reached the browser.

The native listener is nonblocking. BSD systems can pass `O_NONBLOCK`
to accepted sockets, while Linux need not. The proxy now explicitly
sets each accepted browser socket to blocking mode before reading it.
With this fix, Device Farm Appium run
`arn:aws:devicefarm:us-west-2:949580910056:run:235b7700-e8db-43f3-b086-8a834566ba9f/00e41a8e-5f9a-4856-8249-796a10a38839`
printed `BATON_REMOTE_PREVIEW_PASS` on the iPhone 16. The test
required the remote page's large JavaScript completion message to
appear in the rendered view. The iOS test kept the App WebView in the
foreground and displayed the remote page in an iframe. The production
iOS preview entry now uses the same approach.

## Browser scope

The native App starts a TCP listener on the phone or desktop and opens
`http://127.0.0.1:<dynamic port>/` in a browser view. A standalone
Baton tab in mobile Safari or Chrome cannot start that TCP listener,
so this native path is unavailable there. A standalone web version
would need an authenticated HTTPS and WebSocket gateway with a separate
origin for the remote site.
