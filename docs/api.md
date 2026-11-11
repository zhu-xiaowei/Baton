# Baton API Specification

## General

**Base URL**: `https://{api-id}.execute-api.{region}.amazonaws.com/v1`

**Authentication**: API and WS endpoints require an API Key
- REST: `x-api-key` header
- WS: query string `?apiKey=xxx` on connection; `$connect` returns 401 unless it is the deployment key
- Exception: `POST /auth/exchange-token` and `GET /auth/install` are outside `/api/` and accept a
  short-lived token instead of the key

**accountId derivation**: `SHA256(apiKey)[:16]`, the partition for connection and device rows — the raw key is never stored

**Runtime identity**:
- `runtime`: `claude` or `codex`; omitted values default to `claude`
- Claude storage ID: native session ID unchanged
- Codex storage ID: `codex:<nativeSessionId>`

---

## REST API — Bridge → Server

### POST /api/bridge/upload-image

Bridge uploads a compressed image to S3.

**Request**
```json
{
  "key": "903158ab6d09b5657c3529f3e4c9e5f8.jpg",
  "data": "<base64 encoded JPEG>"
}
```

**Response** `200`
```json
{ "key": "903158ab6d09b5657c3529f3e4c9e5f8.jpg", "size": 45321 }
```

**S3 storage path**: `images/{key}` (e.g. `images/903158ab6d09b5657c3529f3e4c9e5f8.jpg`)

---

### POST /api/bridge/upload-file

Bridge uploads a project **text** file to S3, in response to a `project_files` `read`. Used to let the app view the actual source of a file referenced by a Read/Edit/Write tool node. (Image files reuse `POST /upload-image` instead.)

**Request**
```json
{
  "key": "5f3a9c1b2d4e6f80.ts",
  "data": "<base64 encoded file content>"
}
```

**Response** `200`
```json
{ "key": "5f3a9c1b2d4e6f80.ts", "size": 18342 }
```

**S3 storage path**: `files/{key}`

**Notes**:
- `key` = `sha256(absPath + "#" + mtimeMs + "#" + size)[:16]` + original file extension, where `mtimeMs` is the file's modification time in milliseconds and `size` is the **full** file size (not the post-truncation size). An edited file (changed mtime/size) produces a fresh key, so the app's per-key cache and the bridge's uploaded-set never serve stale content. `truncated` is a field of the read result, not part of the key.
- Content is base64-encoded (handles arbitrary bytes / UTF-8 uniformly), same as `upload-image`.

---

### POST /api/bridge/video-prepare

Videos are too large to base64 through Lambda (API Gateway's ~6 MB payload limit), so the bridge **streams them directly to S3** via a presigned PUT URL instead of using `upload-file`. This endpoint decides whether an upload is needed and, if so, hands out the presigned URL.

**Request**
```json
{ "key": "1a2b3c4d5e6f7a8b.mp4" }
```

**Logic**: `HEAD videos/{key}` in S3.
- **Exists** → `{ "exists": true, "key": "..." }` — bridge skips the upload (dedup by content-hash key survives bridge restarts, unlike the in-memory uploaded-set).
- **Missing** → generate a presigned **PUT** URL (`ExpiresIn=900`) signed with `ContentType`.

**Response** `200`
```json
{ "exists": false, "key": "1a2b3c4d5e6f7a8b.mp4", "url": "https://...s3...", "contentType": "video/mp4" }
```

**Notes**:
- `key` uses the same `sha256(absPath#mtimeMs#size)[:16] + ext` formula as `upload-file`.
- Bridge PUTs with `fs.createReadStream` + `fetch(url, { duplex: 'half', headers: { 'Content-Type', 'Content-Length' } })` → flat memory regardless of file size. The signed `ContentType` must match the header sent.
- Video extensions: `.mp4 .m4v .mov .webm .mkv .avi`. Cap: 5 GB (`error: "video too large"`).
- **S3 storage path**: `videos/{key}`.

---

## REST API — General

### GET /api/health

Connectivity check, called by app on startup.

**Query**: none

**Response** `200`
```json
{ "status": "ok", "version": "dev" }
```

---

### GET /api/version

Returns independently deployable app and Bridge versions. Bridge auto-update compares
`bridgeVersion` with its local package version.

```json
{ "version": "1.0.0-abcdef0", "bridgeVersion": "1.0.0-abcdef0" }
```

---

### POST /auth/exchange-token

Exchanges a setup token for the API key. This route is intentionally outside `/api/` and does not
require the API key header. Tokens stay valid until they expire (install.sh: 12h, Setup: 10 min),
so a Start URL and its QR code can sign in several devices; an expired token, or one issued for a
key that has since been rotated, returns 401.

```json
{ "token": "32-hex-token" }
```

Response: `{ "apiKey": "..." }`.

### POST /api/auth/start-token

Returns `{ "token": "…", "expiresIn": 600 }` for Setup's Start URL (`/?t=`), QR code and install
command. `GET /auth/install?t=<token>[&platform=windows][&name=…]` returns the same script as
`/api/install` (with `Cache-Control: no-store`), or 403 with a script that prints the error and exits.

### POST /api/bridge/delete-device

`{ "deviceName": "MyMac" }` → `{ "ok": true }`. Sends `{ "action": "device_removed" }` to the
device's Bridge sockets and closes them, then deletes its device row. The Bridge removes its
autostart entry and `config.json` and exits; session files on the device are kept. A Bridge that
was offline reappears when it next connects; a new install command also adds it back.

---

### GET /api/bridge/config

Returns server configuration for bridge/app auto-discovery of WS URL, etc.

**Query**: none

**Response** `200`
```json
{
  "wsUrl": "wss://xxx.execute-api.xxx.amazonaws.com/v1"
}
```

---

### GET /api/bridge/install

Generates a Bridge install script, used by the setup page. It configures launchd on macOS,
systemd user service on Linux, or Task Scheduler on native Windows.

**Query**:
| Param | Required | Description |
|-------|----------|-------------|
| `name` | No | Device name (if omitted, script asks interactively, defaults to hostname) |
| `platform` | No | Use `windows` for the PowerShell installer; otherwise returns the shell installer |

**Alias**: `GET /api/install` (same handler)

**Response** `200`: `text/plain` shell or PowerShell script

**Script logic**:
1. Download bridge.tar.gz (S3 presigned URL, valid 1h)
2. npm install
3. Write launchd plist / systemd service / Windows scheduled task configuration
4. Start service

---

## REST API — App → Server

### GET /api/bridge/devices

Device names and online state from the device rows in SystemTable, which the WS `$connect` handler
writes after a Bridge claims its device name (the control-socket URL carries `&name=<display>&os=<platform>`).
Everything else on the home page comes from each Bridge. `rpc` addresses the joined Bridges directly
(`docs/v2-step1-home-plan.md`).

```json
{ "protocol": 2,
  "devices": [{ "deviceName": "MacBook-Pro", "deviceDisplayName": "Office Mac", "os": "darwin", "online": true }],
  "rpc": { "endpoint": "<data API execute-api host>", "credentials": {}, "bridges": [{ "device": "MacBook-Pro", "dataId": "…" }] } }
```

---

### Direct channel (App ⇄ Bridge over the `app_data` / `bridge_data` sockets)

`request(device, method, params)`, `subscribe()` and `onPush()` in `web/js/v2/direct-transport.js`;
frames, chunking and compression are in `bridge/direct-rpc-protocol.mjs`; the Bridge side is
`bridge/direct-rpc.mjs`. Lists are answered from `bridge/session-index.mjs`
(`docs/v2-step2-lists-plan.md`); real time is `docs/v2-step3b-realtime-plan.md`.

A signed frame is `{action, method | event, target, body, date, token, authorization}`. The data
API routes `action` (`rpc` for requests and replies, `push` for Session events) to an HTTP
integration that posts `body` to the `target` connection, without Lambda; `method` / `event` only
make the operation readable. Bodies:

| `kind` | Fields | Direction |
|---|---|---|
| `rpc` | `method, requestId, params, replyTo, accept, ack?, missing?` | App → Bridge |
| `rpc_ack` | `requestId` (sent on arrival when the request has `ack`) | Bridge → App |
| `rpc_progress` | `requestId, progress?` (after 5 s, then every 15 s while the handler runs) | Bridge → App |
| `rpc_result` | `method, requestId, ok, chunk, enc, data` or `error` | Bridge → App |
| `push` | `event, sessionId, id, chunk, enc, data` | Bridge → subscribed Apps |

Replies and pushes above 1 KB are deflated and split into chunks reassembled by `requestId` / `id`;
a request whose params do not fit one frame is sent as `rpc` chunks (`chunk, enc, data` instead of
`params`) the same way.

| Method | Params | Answer |
|---|---|---|
| `home` | `revision?` | `{ revision, notModified?, device, sessions, recentProjects }` |
| `projects` | `limit?` (50, ≤100), `cursor?` | `{ projects, hasMore, nextCursor }` |
| `sessions` | `project`, `limit?`, `cursor?` | `{ sessions, hasMore, nextCursor }` |
| `history` | `sessionId, before?, after?, epoch?, limit?, subscribe?` | a page (`docs/v2-step3-session-plan.md`); `subscribe` also registers the caller before the file is read |
| `threads`, `tool_details` | see `docs/v2-step3-session-plan.md` | |
| `subscribe` | `sessionId, rootSessionId?, renew?, replaces?` | `{ epoch }`; the Session's waiting permission prompt is pushed again and a running turn replayed (`turn_replay`) |
| `unsubscribe` | `sessionId` | `{}` |
| `send_message` | the `send_message` payload below, without `device` | the `send_message_result` fields below; sent with `ack` |
| `interrupt` | `sessionId, turnId?, runtime?` | `{ ok }` |
| `permission_reply` | the `permission_reply` payload below | `{ ok }` |
| `list_commands` | `projectHash, runtime, knownRevision` | the catalog (`commands, skills, revision`) or `{ notModified, revision }` |
| `list_command_options` | `projectHash, runtime, sessionId, commandName` | `{ commandName, options, error? }` |
| `project_files`, `git_status` | the payloads below, without `action` / `device` / `requestId` | `{ frames }`: the frames the handler produced, in order |
| `delete_files` | `sessionIds` or `projectHashes` | `{ frames }`; the last frame is the outcome, earlier ones arrive as `rpc_progress` |
| `rename_session` | `sessionId, title, runtime?` | the `rename_session` result |
| `create_project` | `projectPath` | `{ ok, projectHash?, projectName?, error? }` |
| `ping` | — | `{ bridgeVersion, runtimes }` |

A long handler sends `rpc_progress`; the App's deadline is 60 s after the last ack or progress.
Machine-heavy reads (history, threads, tool details, file and Git reads) run at most 6 at once;
everything else runs at once. A request carrying `known` gets `fingerprint` (SHA-256 of the
result, 16 hex digits) in the reply, or only `{ notModified: true, fingerprint }` when it equals
`known`; the App sends it for `projects`, `sessions`, `threads`, file `list` / `browse` and Git
`status` / `refs` / `history`.

A subscription is a 150 s lease (renewed every 60 s, dropped by `unsubscribe` or when the page is
hidden). Only subscribers receive pushes: `stream_*`, `messages`, `permission_request`,
`permission_resolved`, `turn_replay {events}`, `session_title_changed`, and, for connections
subscribed with that `rootSessionId`, `session_threads_changed {deviceName, roots}`; payloads as
described under WebSocket API. `epoch` changes when the
Bridge restarts.

Project rows: `projectHash, projectName, projectPath, sessionCount, runningCount,
needsInputCount, lastActive`. Session rows: `sessionId, preview, lastActive, size, model, status,
agentCount` plus `isAgent, agentName` for daemon agents and `agentDetail` while one waits for input.
Both lists are newest first (`lastActive`, then id, descending); the cursor is opaque. `status` is
the effective root-plus-agents status. `api.js` calls them through `bridgeHome`, `bridgeDevices`,
`bridgeList` and `bridgeHistory`.

---

### GET /api/bridge/image-url/{key}

Get a one-hour signed S3 URL. The browser or Bridge downloads image bytes directly from S3.

**Path params**:
| Param | Description |
|-------|-------------|
| `key` | Image filename, e.g. `903158ab.jpg` |

**Query**: `attachment=true` selects account-scoped `attachments/{account}/{key}` storage;
otherwise the key refers to a previously uploaded image in `images/{key}`.

**Response** `200`: `{ "url": "https://..." }`, with `Cache-Control: no-store`.

**Notes**:
- The signed response overrides the image MIME type and uses inline disposition.
- Invalid keys return `400`; missing objects return `404` from S3 when downloaded.
- This replaces the removed `/image/{key}` Base64 download endpoint; clients must be updated together.

---

### GET /api/bridge/file/{key}

Get a synced project file's content (proxied from S3).

**Path params**:
| Param | Description |
|-------|-------------|
| `key` | File key as returned by a `project_files` `read`, e.g. `5f3a9c1b2d4e6f80.ts` |

**Logic**: Read from S3 `files/{key}` and return.

**Response** `200`: file content as `text/plain; charset=utf-8`

**Notes**:
- App fetches the file body via this endpoint (REST, gzip-compressed, outside the WebSocket ~31 KB frame budget), then renders it with highlight.js in the file viewer
- The viewer caches by `key`; since the key embeds mtime+size, an edited file is re-fetched automatically
- `404` if key not found

---

### GET /api/bridge/video-url/{key}

Return a short-lived presigned **GET** URL so the browser `<video>` element streams `videos/{key}` **directly from S3** (with HTTP Range/seek), bypassing the Lambda 6 MB limit. HEADs the object first; `404` if missing.

**Response** `200`: `{ "url": "https://...s3...?X-Amz-..." }` (`ExpiresIn=3600`)

**Notes**:
- Response carries **`Cache-Control: no-store`** — critical. CloudFront's default GET cache is 1 day, but the presigned URL expires in 1h; without `no-store` the CDN would serve a stale/expired signature (→ S3 `403 Request has expired`). Content-addressed endpoints (`/file`, `/image`) are safe to cache; only this signature-returning endpoint must not be.
- App caches the returned URL in memory (`state.videoUrlCache`) for ~50 min (10 min safety margin under the 1h expiry) so re-opening the same video skips the round-trip. This front-end cache is separate from and complementary to the CDN `no-store`.

---

### Office attachment previews (no server endpoint)

Word, PowerPoint and Excel attachments (`.docx/.pptx/.xlsx`, legacy `.doc/.ppt/.xls`, and the same files opened from the project tree) are rendered in the browser with [@silurus/ooxml](https://www.npmjs.com/package/@silurus/ooxml) 0.89.0 — Rust/WASM parsers and a canvas renderer — loaded on demand from jsDelivr like PDF.js and Mermaid, so nothing is added to the app package and the server never converts files. The viewer reads the same presigned `previewUrl` from `GET /file-url/{key}`; project files are first uploaded through the existing `download` operation. Word uses the progressive scroll viewer (the first page appears before the whole document is laid out), slide decks the scroll viewer, both with the app's two-finger zoom; Excel keeps the library's sheet tabs and zoom bar. Legacy `.doc/.ppt/.xls` go through the experimental [@silurus/ooxml-legacy-office](https://www.npmjs.com/package/@silurus/ooxml-legacy-office) readers (pinned to the same version) into the same viewers; content they cannot represent (including encrypted files) is rejected and shows the download note. OpenDocument and Keynote files show the download note. Workbooks above the library's 250,000-cell limit report "too large to preview".

Office files, images and PDFs that load in one request (≤ 8 MB) are kept in IndexedDB by attachment key, so reopening one makes no `file-url` request and no download; files uploaded from the device are cached at upload. The budget is 500 MB (oldest-opened evicted first, files over 100 MB skipped). Attachment keys never change content, so the cache needs no validation.

### Attachment content IDs (`POST /file-prepare`, `GET /file-url/{key}`)

The app and Bridge send `contentHash`: the SHA-256 of the whole file (64 hex). The key becomes its first 32 hex digits plus the extension. The server HEADs that object in the account's prefix with `ChecksumMode=ENABLED`: only when S3's stored `ChecksumSHA256` equals the hash and the size matches is the response `{ "key", "exists": true }` with no upload URL, and the client treats the file as uploaded. If the object is missing, both presigned PUT URLs are signed with `ChecksumSHA256` and `headers` carries `x-amz-checksum-sha256`; S3 rejects any other bytes with `400 BadDigest`, so a content key always holds its content (Bridge then reports the file as changed and does not retry the fallback). Any other object at that key keeps a random key and is never overwritten. Requests without `contentHash` keep random keys; clients send exactly the returned headers. `GET /file-url/{key}?name=` overrides the stored file name (used for the title and `Content-Disposition`), because identical content uploaded under another name shares one object.

---

## WebSocket API

**Connection URL**: `wss://{ws-api-id}.execute-api.{region}.amazonaws.com/v1?apiKey=xxx&role=app`

**Query params**:
| Param | Required | Description |
|-------|----------|-------------|
| `apiKey` | Yes | API Key |
| `role` | Yes | `app` (phone/web) or `bridge` |
| `device` | No | Device name (required for bridge, used for device routing) |

### Connection Management

**$connect**: Validate apiKey → store connectionId in DDB Connections table
```
DDB Connections:
  PK: connectionId
  Attributes: accountId, role (app|bridge), deviceName?, bridgeVersion?, connectedAt
  TTL: 24h
```

`deviceName` is only carried by bridge connections, used for online status and the `rpc.bridges`
list in `GET /devices`. After a Bridge claims its device name, `$connect` also writes its device row
in SystemTable from the `name` (display name) and `os` query parameters.

Bridge connections also send their immutable package version as the `version` query parameter.
The server stores it as `bridgeVersion` so deployments can verify the running fleet directly.

The server strips the `device` routing field before forwarding an app action to Bridge. Codex
uses `messages` for live rollout updates and supports existing-Session
send/streaming/interrupt and runtime-specific permission handling through its app-server adapter.

**$disconnect**: Delete connectionId + clean up related subscription records

---

Since v2 stage 2a the App opens no control socket: Session events, sends, interrupts,
permission replies, commands, files, Git, rename, create project and delete all travel on the
direct channel above. Their payloads are still described below.

### App → Server

#### heartbeat

Keep connection alive.

```json
{ "action": "heartbeat" }
```

**Server handling**: Update Connections table TTL, return `{ "action": "heartbeat", "ts": "..." }`

---

#### send_message

Send a message to an existing Claude Code or Codex Session, or create a Session for either
runtime from a Project.

**Existing session:**
```json
{ "action": "send_message", "sessionId": "a1ca0870-xxxx", "text": "help me fix this bug", "device": "MacBook-Pro" }
```

**New session (no sessionId, with projectHash):**
```json
{ "action": "send_message", "projectHash": "-Users-xxx-workspace-project", "runtime": "codex", "text": "hello", "device": "MacBook-Pro", "requestId": "req_abc123", "asAgent": false }
```

**Optional fields**:
| Field | Description |
|-------|-------------|
| `requestId` | Client-generated id echoed back in `send_message_result`. Used as the launch lock key and to match the result to the originating new-session request |
| `runtime` | Runtime selected by the user from the supported Claude/Codex options |
| `asAgent` | `true` → new Claude Session runs as a Claude Agents background session; ignored for Codex |

**Server handling**: Forward to matching bridge by `device`. Bridge handling:
1. Has sessionId → route by runtime: Claude uses the headless pool; Codex uses
   `thread/resume` + `turn/start` through the managed Unix-socket app-server when available,
   with an isolated stdio app-server fallback
2. No sessionId, has projectHash → route by selected runtime: Claude uses its existing headless
   creation path; Codex uses `thread/start` + `turn/start` on one cwd-scoped app-server client

**Return**: Bridge sends `send_message_result` (with `sessionId` + echoed `requestId`) → returned as the reply to the sender's request.

---

#### permission_reply

Reply to a permission confirmation or user choice.

```json
{
  "action": "permission_reply",
  "sessionId": "a1ca0870-xxxx",
  "requestId": "ctrl_123",
  "decision": "answer",
  "answerText": "Watermelon",
  "device": "MacBook-Pro"
}
```

For Claude ordinary tools, `decision` is `allow`/`deny`. AskUserQuestion and plan prompts use
`answer`/`deny`, with the selected or typed value in `answerText`.

Codex requests include a discriminating `permission_request.approvalType` and use the App Server
response shape for that request:

| `approvalType` | Frontend reply | App Server result |
| --- | --- | --- |
| `codex-command` | `decision` | `{ "decision": ... }` |
| `codex-file-change` | `decision` | `{ "decision": ... }` |
| `codex-permissions` | `approvalResponse.action` | `{ "permissions": ..., "scope": ..., "strictAutoReview"?: true }` |
| `codex-mcp-elicitation` | `approvalResponse` | `{ "action": ..., "content": ..., "_meta": ... }` |

Command decisions preserve the ordered value advertised by
`permission_request.input.codexApproval.availableDecisions`. Values can be strings such as
`accept`, `acceptForSession`, `decline`, or `cancel`, or structured values such as:

```json
{
  "acceptWithExecpolicyAmendment": {
    "execpolicy_amendment": ["git", "add"]
  }
}
```

The bridge validates command/file decisions against the pending request. Permission replies send
only a semantic action; the bridge copies the granted permission profile from the original trusted
App Server request. MCP form keys, required values, types, enum values, and persistence modes are
validated against the original schema and metadata. Invalid replies fail closed.

For example, a permission choice is sent as:

```json
{
  "action": "permission_reply",
  "sessionId": "codex:thread-id",
  "requestId": "codex:thread-id:42",
  "approvalResponse": {
    "action": "grantForTurnWithStrictAutoReview"
  }
}
```

These Codex fields are ignored by the Claude branch; Claude continues to use the existing
`decision` and `answerText` contract.

**Server handling**: Forward to matching bridge by `device`.

Bridge receives a runtime control request, emits `permission_request`, and applies the reply
through the same pending request ID. The frontend does not infer permission prompts from tool
output. Codex may send several approval requests before the first is answered. The bridge matches
the Codex TUI by keeping the first request active and stacking later requests; after the active
request is answered, the newest queued request is shown next. Replayed request IDs are
deduplicated, and only the active request ID can be answered. If another app-server client resolves
a request first, `serverRequest/resolved` removes it from the bridge queue and emits
`permission_resolved` for the visible prompt.

---

#### interrupt

Interrupt the currently running Claude Code (equivalent to Ctrl+C).

```json
{ "action": "interrupt", "sessionId": "a1ca0870-xxxx", "device": "MacBook-Pro" }
```

**Server handling**: Forward to matching bridge by `device`. Bridge SIGINTs the session's headless Claude Code process (`_pool.interrupt`).

---

#### delete_files

Optionally deletes local Session history after REST metadata deletion.

```json
{
  "action": "delete_files",
  "sessionIds": ["a1ca0870-xxxx"],
  "projectHashes": [],
  "requestId": "delete_123",
  "device": "MacBook-Pro"
}
```

Runtime adapters without `deleteHistory` are skipped; the Codex read adapter never deletes rollout files.

---

#### create_project

Create a new project directory and seed its Project metadata. The first `send_message` creates
the Session.

```json
{ "action": "create_project", "projectPath": "workspace/my-new-project", "device": "MacBook-Pro" }
```

**Fields**:
| Field | Required | Description |
|-------|----------|-------------|
| `projectPath` | Yes | Path relative to the Bridge user's home, a `~/` path, or an absolute path, including outside home |
| `device` | Yes | Target device |
| `asAgent` | No | Legacy compatibility field echoed for older clients; the current New Project UI does not send it |

**Server handling**: Forward to matching bridge by `device` (rejected with `400` if `projectPath` missing).

**Bridge handling**: create the path → derive `projectHash` → reply `create_project_result`. The
project appears in the list with its first Session; the directory stays selectable for new Sessions.
The hash uses the directory's real path so symbolic-link aliases resolve to the same project.

---

#### project_files: browse

List folders for the New Project picker without requiring an existing project.
The request uses the existing `project_files` RPC and is routed to `device`;
the response is delivered only to the requesting app connection.

```json
{ "action": "project_files", "operation": "browse", "requestId": "<UUID>", "device": "MacBook-Pro", "path": "" }
```

An empty `path` starts at the Bridge user's home. Relative paths and `~/` paths
resolve against that home; absolute paths are accepted. The response includes
`path` (listed directory), `targetPath` (resolved input), `parentPath`, `exists`,
directory-only `entries`, and an optional `nextCursor` for the next request.
For a new folder whose parent exists, `exists` is false and the parent is listed.
Browsing never creates a directory. Existing `list`, `read`, and `download`
operations still require `projectHash`.

---

#### list_commands

Ask the bridge for the slash-command catalog of the active runtime.

```json
{
  "action": "list_commands",
  "projectHash": "-Users-xiaoweii-workspace-rn-baton",
  "runtime": "codex",
  "device": "MacBook-Pro",
  "knownRevision": "a1b2c3d4",
  "requestId": "cmds_1717300000000"
}
```

**Fields**:
| Field | Required | Description |
|-------|----------|-------------|
| `projectHash` | No | Resolves project-level Claude commands or the cwd used by Codex `skills/list` |
| `runtime` | Yes | `claude` or `codex`; omitted values retain Claude compatibility |
| `device` | Yes | Target device (routing) |
| `knownRevision` | No | Revision already stored by the app; matching responses avoid a catalog upload and REST fetch |
| `requestId` | Yes | Client-generated id, matches the reply |

**Server handling**: Forward to matching bridge by `device` (via `_handle_send_to_bridge`).

The app keeps a five-minute cache by `device + runtime + projectHash`; while it is fresh, no request
is sent. Every actual `list_commands` request forces the Bridge to rescan that current project.
Concurrent refreshes share one promise, the Bridge retains the last good result for failure fallback,
and the revision changes only when the normalized command or Skill content changes. An unchanged
revision returns `notModified` without another catalog upload.

**Claude handling**:
1. Start a short-lived `claude -p` process with `--no-session-persistence`.
2. Send stream-json `control_request {subtype:"initialize"}`.
3. Use the returned runtime-filtered commands, descriptions, argument hints, aliases,
   models and provider/account state. No environment-specific command or model table is
   hardcoded in Baton.
4. Filter terminal-only, internal or unsafe commands. Order executable local commands
   alphabetically, then prompt/Skill commands alphabetically, matching the TUI groups.
5. `/model` options preserve `initialize.models` order and values. Enum pickers such as
   `/effort` and `/fast` use the current command's returned argument hint.
6. If `initialize` is unsupported or fails, scan user/project/plugin Markdown commands
   and Skills only. The fallback parses descriptions, argument hints, nested namespaces
   and `user-invocable:false`; it does not append a static built-in list.

**Codex handling**:

1. Start from the complete 44-command popup observed by scrolling the local Codex 0.147 TUI.
2. Preserve TUI presentation order and return 33 phone-capable built-ins on macOS. Linux returns
   32 because `/app` is available only when the Bridge host is macOS or Windows.
3. Filter exactly these commands from the 44-command baseline:
   `ide`, `keymap`, `vim`, `approve`, `side`, `raw`, `title`, `statusline`, `theme`, `pets`,
   and `plugins`. They depend on IDE/TUI-only state or an unsupported end-to-end plugin auth flow.
4. Picker commands carry ordered `options`. Dynamic options come from app-server model, feature,
   hook, Skill, and descendant-thread APIs. Hook options execute the same enable/disable/trust
   config writes used by the TUI.
5. Scan immediate Markdown files in `$CODEX_HOME/prompts`, parse `description` and
   `argument-hint`, and append `/prompts:<name>` entries sorted by name.
6. Call app-server `skills/list` with the project cwd and `forceReload: true`. Skills are returned
   separately and retain Codex's resolved scope, enablement, and order.
7. The app preserves Bridge command order. It never alphabetically resorts the Codex catalog.

---

### Bridge → Server

#### messages

Bridge pushes new message rows to subscribed apps.

```json
{
  "action": "messages",
  "sessionId": "a1ca0870-xxxx",
  "messages": [
    {
      "uuid": "msg_new789",
      "type": "assistant",
      "content": [{ "type": "text", "text": "Here's the fix..." }],
      "timestamp": "2026-03-27T10:31:00.000Z"
    }
  ]
}
```

Pushed by the Bridge to the Session's subscribers on the direct channel; nothing is sent to the
server. With no subscriber the rows are dropped.

**Notes**:
- `content` is a JSON array; content block types: `text`, `image`, `document`, `thinking`, `tool_use`, `tool_result`
- `type` includes `user`, `assistant`, `summary`, `system_event`, `interrupt`, and Claude metadata types
- `document` block: `{ type: "document", source: { type: "text", media_type: "text/plain", data: "..." }, title: "filename.txt" }`

---

#### permission_request

Bridge detects a permission confirmation need, pushes to all apps subscribed to the session.

```json
{
  "action": "permission_request",
  "sessionId": "a1ca0870-xxxx",
  "kind": "ask",
  "requestId": "ctrl_123",
  "toolName": "AskUserQuestion",
  "questions": [
    {
      "question": "Which fruit do you like best?",
      "header": "Fruit",
      "options": [{ "label": "Watermelon", "description": "Very juicy" }],
      "multiSelect": false
    }
  ],
  "input": {}
}
```

Pushed by the Bridge to the Session's subscribers on the direct channel.

---

#### permission_resolved

Bridge tells subscribed apps that the visible permission prompt is no longer pending. Apps only
dismiss the prompt when `requestId` matches, so a late completion cannot close a newer prompt.

```json
{
  "action": "permission_resolved",
  "sessionId": "a1ca0870-xxxx",
  "requestId": "ctrl_123"
}
```

---

#### send_message_result

Bridge returns the result after processing send_message.

```json
{ "action": "send_message_result", "ok": true, "sessionId": "new-session-id", "requestId": "req_abc123", "turnId": "sent_123" }
```

Synchronous local commands may also return:

```json
{
  "action": "send_message_result",
  "ok": true,
  "sessionId": "session-id",
  "turnId": "sent_123",
  "commandOutput": "Copyable plain-text result",
  "commandName": "usage",
  "commandPanel": {
    "type": "claude-usage",
    "initialTab": "usage",
    "status": {},
    "config": {},
    "usage": {},
    "stats": {}
  }
}
```

`commandPanel` is ephemeral UI state. The Bridge returns it verbatim but does not write it to
the Claude transcript. The frontend stores `commandOutput` as the panel's copyable text fallback.

**Fields**: `ok`, optional `sessionId` (new sessions only), `error` (when `ok=false`),
`requestId`, and `turnId`. Immediate Codex commands may also return
`commandOutput`; the app atomically promotes the optimistic command bubble and renders that
ephemeral local result without writing it to rollout history.

Returned as the reply to the sender's `send_message` request.

---

#### create_project_result

Bridge returns the result after processing `create_project`.

```json
{ "action": "create_project_result", "ok": true, "projectHash": "-Users-user-workspace-my-new-project", "projectName": "my-new-project", "projectPath": "workspace/my-new-project" }
```

**Fields**: `ok`, `projectPath` (echoed, used by the app to match the pending create), optional `sessionId`, and `error` (when `ok=false`).

Returned as the reply to the `create_project` request.

---

#### delete_files_result

Bridge reports completion of optional local history deletion.

```json
{ "action": "delete_files_result", "requestId": "delete_123", "ok": true, "skippedReadOnly": 1 }
```

The result is the last frame of the `delete_files` reply.

---

#### heartbeat

```json
{ "action": "heartbeat" }
```

Bridge sends this every four minutes. The server updates the connection TTL and replies:

```json
{ "action": "heartbeat", "ts": 1789900000, "bridgeVersion": "1.0.0-abcdef0" }
```

Bridge checks for an update only when `bridgeVersion` differs from its installed version.
Unchanged heartbeats do not trigger additional REST requests.

---

#### list_command_options / command_options

Session-scoped picker options are not stored in the project catalog. Selecting a command marked
`optionsRemote` requests its current options:

```json
{
  "action": "list_command_options",
  "requestId": "cmdopts_1717300000000",
  "runtime": "codex",
  "projectHash": "-Users-xiaoweii-workspace-rn-baton",
  "sessionId": "codex:0198...",
  "commandName": "agent",
  "device": "MacBook-Pro"
}
```

The Bridge replies with `command_options`, echoing the request context and returning only the
selected command's options. This currently keeps Codex experimental features and agent/subagent
thread choices out of the project-level cache.

---

#### streaming actions

Claude headless preview actions are pushed to subscribed apps:

```text
stream_turn_start
stream_block_start
stream_delta
stream_tool_input
stream_block_stop
messages
permission_request
permission_resolved
stream_end
```

Every shared event from `stream_turn_start` through `stream_end` carries `sessionId`, `turnId`,
and one contiguous turn-local `seq`. This includes authoritative `messages` and turn-scoped
permission events. The app buffers by `turnId + seq`; no event type may cross a missing sequence.
`stream_block_start.seq` is the live node identity, and `stream_end` is terminal.

For Web-managed turns, Claude headless and Codex app-server are the only realtime authorities.
Their user, assistant, tool-use, and tool-result messages all travel through the sequence above.
The watcher does not push the later JSONL copies again. JSONL messages created by an external
TUI/IDE have no runtime ownership, so they are pushed as complete unsequenced `messages` and are
merged with Bridge history by UUID/native ID.

`send_message_result` does not consume turn sequence numbers.

---

## Error Responses

All endpoints use a unified error format:

```json
{
  "error": "error_code",
  "message": "Human readable description"
}
```

| HTTP Status | error_code | Scenario |
|-------------|------------|----------|
| 401 | `unauthorized` | Missing or invalid API Key |
| 400 | `bad_request` | Missing required parameters |
| 404 | `not_found` | Resource does not exist |
| 500 | `internal_error` | Server-side exception |

---

## DynamoDB Tables

The server keeps no Session data. `Connections` (PK `connectionId`, GSI `accountId-role-index`,
24h TTL) holds WS connection records with role/device routing. `SystemTable` (`pk`/`sk`, TTL) holds
token, push-device and notification rows, and one device row per Bridge: `pk DEVICE#<accountId>`,
`sk <deviceName>`, with `deviceDisplayName`, `os`, `lastConnected` (`server/src/devices.py`).

---

## Known Limitations & Design Notes

### Connection routing indexes

Bridge routing queries `Connections.accountId-role-index`.

### Codex

Codex participates in Session lists, history reads, and live `messages` updates from the rollout
watcher. Existing-Session `send_message`,
streaming, interrupt, and permission requests use the app-server adapter. The adapter reuses a
managed Unix WebSocket daemon when present and falls back to `app-server --stdio` otherwise.
The standalone writer termination flow remains only as the explicit fallback for a subsequent
message send that cannot share a daemon. New-Session creation is supported; local history deletion
remains disabled by Codex runtime capabilities. Project directory creation is runtime-neutral.
See [codex.md](codex.md) for validation.

### Image & file endpoints have no account isolation

Legacy `GET /api/bridge/image-url/{key}` (without `attachment=true`), `GET /api/bridge/file/{key}`,
and `GET /api/bridge/video-url/{key}` do not verify object ownership. They rely on unguessable
hash keys. `POST /upload-image`, `POST /upload-file`, and `POST /video-prepare` likewise use
legacy storage. New project image uploads and `image-url?attachment=true` use account-scoped attachments.
