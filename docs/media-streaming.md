# Sealed media and large files

Every file in the transfer area is sealed (`bridge/transfer-store.mjs`: 64 KiB records, nonce ‖ AES-GCM ‖ tag,
AAD `key|index|last`). All but images and Office files up to 256 MB are read by range and decrypted in the page.

- **Responses** (`web/js/media/source.js`): no `Range` → 200 with the whole length; `a-`, `a-b`, `-n` → 206 with
  the whole range (never shortened: WebKitGTK takes the size from `Content-Length`); a dropped connection stops
  the read. `.mov` is served as `video/mp4`; players use `preload="metadata"` (Linux GStreamer otherwise caches
  the whole decrypted file in `/var/tmp`).
- **Reads**: Chromium ≥ 126 pauses a fetch the page stops reading, so it opens one GET per player request
  (1–5 GETs per GB played). WebKit (Safari, WKWebView, WebKitGTK) and Android WebView < 126 download a whole
  response into memory regardless, so playback reads closed ranges (`cache: 'no-store'`): after an open or a
  seek 1, 4, 4 and 8 MiB at once, then 16 MiB blocks with two ahead (≈ 64 GETs per GB, like Proton/MEGA's
  parallel 4–16 MiB reads). Each record is fetched once per file whichever player request wants it. The first
  and last 16 records stay in memory (probes, `moov`) plus an LRU of 128 MB (96 MB on iOS); whole decrypted
  16 MiB blocks go to the attachment cache (IndexedDB, `media:` entries, up to min(2 GB, quota / 4)), so
  seeking back and reopening send no request. Downloads go the same way; their state is dropped a minute
  after the last request. GETs of a request that ends stop after a second unless another request claims
  them, or at once when a seek leaves them behind. A short read resumes where it stopped (R2 resets a
  stalled GET after ~120 s, S3 after ~300 s); an expired stored copy is uploaded again by the Bridge.
- **Uploads** (`web/js/components/attachment.js`): up to 32 MB one PUT; larger 16 MiB multipart parts. All
  uploads share three slots (two on phones; files up to 8 MB take none), so several large files at once still
  keep that many parts in flight and in memory. A failed part is retried after 1/2/5/10/20 s with a fresh URL;
  a failed upload is aborted (≈ 66 writes per GB); the progress shown never goes back. A stack whose CORS
  predates multipart gets one PUT.
- **Channels** (`web/js/media/serve.js`): Tauri shells answer `http://127.0.0.1|localhost:<port>/m/<token>` on a
  `preview_proxy` listener (Host-checked, unguessable token); the page parses the request and writes the
  response with the raw `media_write` invoke (256 KiB, 3 in flight, reordered by `x-seq` in Rust). Android's
  invoke body is a JSON number array, so it POSTs to the `media_sink` loopback listener instead. Browsers use
  `web/public/media-sw.js` (`./__media/<token>`), claiming an uncontrolled page first. Without either, files up
  to 256 MB open as a Blob.
- **Recovery**: an object gone from storage (404, or 403 on S3) makes the page ask the Bridge again — a project
  file is uploaded again; an attachment's Bridge copy (`~/.baton-bridge/attachments/…`) is uploaded as a project
  download.
- Verified 2026-11-27 on Chromium/Firefox/Safari, macOS 15/26, iOS 26 (simulator + iPhone 17), Windows WebView2,
  Android (emulator, Pixel 9, Galaxy S24) and Ubuntu WebKitGTK. Not covered: HarmonyOS (Blob fallback),
  `MAX_STREAMS` under many player connections, Android DownloadManager over loopback, Safari SW downloads.
