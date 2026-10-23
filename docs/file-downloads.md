# File downloads and sharing

The file viewer has one Download action and no separate Share button. It works for uploaded attachments and project files, including files whose contents cannot be previewed, and downloads the original bytes rather than the truncated text preview. While preparing or downloading, the download controls show a circular spinner and reject duplicate clicks; completion, cancellation, or errors restore the controls. The existing account-scoped `file-prepare` / `file-url` endpoints are reused; only project files need the new `project_files` operation `download` to stream the original from Bridge to S3. File contents never pass through Lambda or WebSocket. The limit is 512 MiB per file.

## Platform behavior

- Browser: a signed S3 GET with `Content-Disposition: attachment` goes to the browser's download manager. The browser controls the download directory and whether to ask for a location; a website cannot override those preferences.
- macOS / Windows app: the native plugin streams to the OS Downloads directory. Filenames are sanitized; an existing file is never overwritten, and failed downloads are removed.
- Android app: Android DownloadManager saves to public Downloads and shows a completion notification. The native plugin returns a saved-file receipt without automatically opening a share chooser. The Downloads queue UI, when included, can open the saved file or system Downloads. If the activity is destroyed, system downloads may continue. Android 7–9 requests legacy storage permission; Android 10+ does not need it. Saved names include a timestamp to avoid collisions.
- iOS app: URLSession downloads to a temporary file, then the system share sheet offers compatible apps and Save to Files; supported images/videos can offer Save Image/Video. The user chooses the action. Temporary files are removed after the sheet completes or is cancelled.
- Mobile browsers exposing Web Share file support prepare the file from the Download action and attempt to open the system share sheet automatically. If user activation expires while downloading, the status asks the user to tap the same Download button again; the prepared file is reused. Browser sharing is limited to 50 MiB to avoid buffering large files in mobile memory. Larger files, unsupported types, desktop browsers, and browsers without file sharing use the normal download manager. Available share destinations depend on the OS and file type.

The web/server/Bridge changes require their respective deployment/update. The native download plugin requires rebuilding and updating each app binary; a server-only deployment cannot add a native plugin to an installed app.

## S3 upload acceleration

`server/install.sh` already enables acceleration on the deployment bucket by default and passes `FileUploadAcceleration=true` to the stack, which sets `S3_UPLOAD_ACCELERATE=true` in Lambda. Setting `S3_UPLOAD_ACCELERATE=false` when running the installer opts out. Signed uploads retain a standard regional URL fallback if acceleration is unavailable. Acceleration may incur additional transfer charges and may take time to become available after enabling it.

Bucket acceleration being Enabled is necessary but not sufficient: the deployed API must also contain the attachment endpoints and use the acceleration environment variable. Check both before claiming the application is using accelerated URLs. Downloads deliberately reuse standard signed GET URLs; this switch controls uploads.

## Validation

```sh
node --test test/frontend/attachments.test.mjs test/frontend/file-download.test.mjs test/bridge/project-files.test.mjs
python3 -m pytest test/server/test_project_files_ws.py
node test/browser/attachments-chrome.mjs
rustc --edition=2021 --test test/native/file-download.rs -o /tmp/baton-file-download-tests && /tmp/baton-file-download-tests
cargo check --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-apple-ios-sim
cargo check --manifest-path src-tauri/Cargo.toml -p tauri-plugin-file-download --target x86_64-pc-windows-msvc
```

The Chrome check uses a local mock S3 endpoint: it verifies an 8 MiB PPT upload/download, fallback, original bytes, Chinese filename and duplicate-download behavior. Native compile checks and filename tests are not substitutes for device acceptance: verify Android's notification/Downloads entry and iOS Save to Files/Photos and third-party share destinations on devices before release.

## Shared native saving core

Image saving, Mermaid export and the download queue use the same plugin implementation, request IDs, cancellation, progress and receipts. Native image decoding still accepts only supported base64 image types with 1 byte–32 MiB of content. Cancellation during local image writes waits for cleanup; a completed save survives a late cancel. Desktop receipts are scoped to their originating WebView. This shared implementation does not by itself add the separate image, Mermaid or queue UI.

The current image, diagram, queue and Android Back contributions have also been tested together: real browser downloads preserve image bytes and export complete PNG/SVG diagrams, while simulated native IPC exercises the queue and Back closes its panel before navigating. Mac/iOS native compilation and device acceptance remain separate requirements.
