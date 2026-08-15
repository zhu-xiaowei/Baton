# AgentPeek API Specification

## General

**Base URL**: `https://{api-id}.execute-api.{region}.amazonaws.com/v1`

**Authentication**: API and WS endpoints require an API Key
- REST: `x-api-key` header
- WS: query string `?apiKey=xxx` on connection
- Exception: `POST /auth/exchange-token` is outside `/api/` and exchanges a short-lived token for the API key

**accountId derivation**: `SHA256(apiKey)[:16]`, used for DDB queries — the raw key is never stored

**Runtime identity**:
- `runtime`: `claude` or `codex`; omitted values default to `claude`
- Claude storage ID: native session ID unchanged
- Codex storage ID: `codex:<nativeSessionId>`

---

## REST API — Bridge → Server

### POST /api/bridge/sync-sessions

Bridge uploads session metadata to DDB.

**Request**
```json
{
  "deviceName": "MacBook-Pro",
  "os": "darwin",
  "sessions": [
    {
      "id": "a1ca0870-xxxx-xxxx-xxxx",
      "nativeSessionId": "a1ca0870-xxxx-xxxx-xxxx",
      "runtime": "claude",
      "project": "-Users-xiaoweii-workspace-rn-agentpeek",
      "projectName": "agentpeek",
      "lastActive": "2026-03-27T10:30:00.000Z",
      "size": 102400,
      "preview": "Help me implement Phase 2 APIs",
      "model": "claude-sonnet-4-5-20250514",
      "modelProvider": "",
      "clientSource": "",
      "cliVersion": "2.1.220",
      "status": "running"
    }
  ],
  "device": {
    "sessionCount": 1,
    "projectCount": 1,
    "runningCount": 1,
    "idleCount": 0,
    "lastActive": "2026-03-27T10:30:00.000Z",
    "runtimeCapabilities": {
      "claude": {
        "installed": true,
        "historyAvailable": true,
        "canRead": true,
        "canCreate": true,
        "canSend": true,
        "version": "2.1.220"
      }
    }
  },
  "projects": []
}
```

`device` and `projects` are included on an authoritative full catalog sync. Incremental status
updates use `statusDelta` or `statusDeltas`. Valid status values are `running`,
`needs_input`, and `completed`.

**Response** `200`
```json
{ "synced": 1 }
```

**DDB write**: BridgeSessions table
- PK: `accountId`
- Session SK: `SESS#{deviceName}#{project}#{storageSessionId}`
- Device SK: `DEV#{deviceName}` (one row per device; `runtimeCapabilities` is a nested map)
- Project SK: `PROJ#{deviceName}#{projectHash}`

---

### POST /api/bridge/reconcile

Recounts a device's DEV/PROJ aggregates from its SESS rows and prunes orphan project rows.

```json
{ "deviceName": "MacBook-Pro", "os": "darwin" }
```

Response: `{ "sessionCount": 522, "projectCount": 12 }`.

### POST /api/bridge/create-project

Creates an idempotent empty project row before its first Session exists.

```json
{
  "deviceName": "MacBook-Pro",
  "projectHash": "-Users-user-workspace-new-project",
  "projectName": "new-project",
  "os": "darwin"
}
```

### POST /api/bridge/delete

Deletes Session/Project metadata rows and reconciles device counts. Message rows remain until TTL
expiry. Optional local JSONL deletion is a separate WS `delete_files` action.

```json
{
  "deviceName": "MacBook-Pro",
  "sessionIds": ["a1ca0870-xxxx"],
  "projectHashes": []
}
```

---

### POST /api/bridge/sync-messages

Bridge batch-uploads messages to DDB. Used for startup history, HTTP fallback, oversized authoritative
copies, and on-demand old Session sync. Real-time Claude messages normally use WS.

**Request**
```json
{
  "sessionId": "a1ca0870-xxxx-xxxx-xxxx",
  "runtime": "claude",
  "nativeSessionId": "a1ca0870-xxxx-xxxx-xxxx",
  "messages": [
    {
      "uuid": "msg_abc123",
      "type": "user",
      "content": [{ "type": "text", "text": "hello" }],
      "timestamp": "2026-03-27T10:30:00.000Z"
    },
    {
      "uuid": "msg_def456",
      "type": "assistant",
      "content": [{ "type": "text", "text": "Hi! How can I help?" }],
      "timestamp": "2026-03-27T10:30:01.000Z"
    }
  ]
}
```

**Response** `200`
```json
{ "written": 2 }
```

**DDB write**: BridgeMessages table
- PK: `sessionId`
- SK: `{timestamp}#{uuid}`
- content stored as JSON string
- deterministic `timestamp#uuid` writes are idempotent
- every write refreshes the message TTL to 90 days

---

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

Bridge uploads a project **text** file to S3, in response to an app `request_file` (see WS section). Used to let the app view the actual source of a file referenced by a Read/Edit/Write tool node. (Image files take a separate branch and reuse `POST /upload-image` instead — see `request_file`.)

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
- `key` = `sha256(absPath + "#" + mtimeMs + "#" + size)[:16]` + original file extension, where `mtimeMs` is the file's modification time in milliseconds and `size` is the **full** file size (not the post-truncation size). An edited file (changed mtime/size) produces a fresh key, so the app's per-key cache and the bridge's uploaded-set never serve stale content. `truncated` is a `file_ready` field, not part of the key.
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
{ "version": "0.2.0-abcdef0", "bridgeVersion": "0.2.0-abcdef0" }
```

---

### POST /auth/exchange-token

Exchanges a short-lived setup token for the API key. This route is intentionally outside `/api/`
and does not require the API key header.

```json
{ "token": "one-time-token" }
```

Response: `{ "apiKey": "..." }`.

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

### GET /api/bridge/active-sessions

Returns all `running`/`needs_input` Sessions plus the 20 most recently completed Sessions across
devices and runtimes.

```json
{
  "sessions": [
    {
      "sessionId": "codex:019e...",
      "nativeSessionId": "019e...",
      "runtime": "codex",
      "status": "running",
      "deviceName": "MacBook-Pro",
      "projectHash": "-Users-user-project",
      "projectName": "project",
      "preview": "Inspect the current changes",
      "lastActive": "2026-08-09T08:00:00.000Z"
    }
  ],
  "recentSessions": []
}
```

---

### GET /api/bridge/devices

Get all devices under the current account.

**Query**: none

**Logic**: Scan BridgeSessions table (PK=accountId), aggregate by `deviceName`

**Response** `200`
```json
{
  "devices": [
    {
      "deviceName": "MacBook-Pro",
      "os": "darwin",
      "projectCount": 12,
      "sessionCount": 522,
      "runningCount": 2,
      "needsInputCount": 1,
      "lastActive": "2026-03-27T10:30:00.000Z",
      "online": true,
      "runtimeCapabilities": {
        "claude": { "installed": true, "historyAvailable": true, "canRead": true, "canCreate": true, "canSend": true, "version": "2.1.220" },
        "codex": { "installed": true, "historyAvailable": true, "canRead": true, "canCreate": true, "canSend": true, "version": "0.147.0" }
      }
    },
    {
      "deviceName": "Ubuntu-Server",
      "os": "linux",
      "projectCount": 3,
      "sessionCount": 38,
      "runningCount": 0,
      "needsInputCount": 0,
      "lastActive": "2026-03-26T08:00:00.000Z",
      "online": false
    }
  ]
}
```

**Notes**:
- `projectCount`: number of projects on this device (deduplicated by `projectHash`)
- `sessionCount`: total sessions on this device
- `runningCount`: sessions with `status="running"`
- `needsInputCount`: sessions with `status="needs_input"`
- `lastActive`: most recent session's lastActive on this device
- `online`: whether bridge WS is connected (checks Connections table for role=bridge with matching deviceName)
- `runtimeCapabilities`: installed/history/read/create/send capability for each runtime; old devices default to Claude capability
- Sorted by `lastActive` descending

---

### GET /api/bridge/projects

Get projects under a specific device.

**Query**:
| Param | Required | Description |
|-------|----------|-------------|
| `device` | Yes | Device name |
| `limit` | No | Page size (`1-100`). Omit for the legacy full response |
| `cursor` | No | Opaque `nextCursor` from the previous page; requires `limit` |

**Example**: `GET /api/bridge/projects?device=MacBook-Pro&limit=50`

**Logic**: Paginated requests query `listPk-listSk-index` in reverse `lastActive`
order. Requests without `limit` retain the legacy base-table query for older clients.

**Response** `200`
```json
{
  "projects": [
    {
      "projectHash": "-Users-xiaoweii-workspace-rn-agentpeek",
      "projectName": "agentpeek",
      "projectPath": "workspace/rn/agentpeek",
      "sessionCount": 15,
      "runningCount": 1,
      "needsInputCount": 1,
      "lastActive": "2026-03-27T10:30:00.000Z"
    }
  ],
  "hasMore": true,
  "nextCursor": "eyJhY2NvdW50SWQiOi..."
}
```

**Notes**:
- `projectName`: last path segment (directory name), used as UI title
- `projectPath`: full path relative to home, used as UI subtitle
- `projectHash`: passed back when calling the sessions endpoint
- `runningCount`: sessions with `status="running"`
- `needsInputCount`: sessions with `status="needs_input"`
- Sorted by `lastActive` descending
- `hasMore` and `nextCursor` are returned only when `limit` is provided

---

### GET /api/bridge/sessions

Get sessions under a specific device + project.

**Query**:
| Param | Required | Description |
|-------|----------|-------------|
| `device` | Yes | Device name |
| `project` | Yes | projectHash |
| `limit` | No | Page size (`1-100`). Omit for the legacy full response |
| `cursor` | No | Opaque `nextCursor` from the previous page; requires `limit` |

**Example**: `GET /api/bridge/sessions?device=MacBook-Pro&project=-Users-xiaoweii-workspace-rn-agentpeek&limit=50`

**Logic**: Paginated requests query `listPk-listSk-index` in reverse `lastActive`
order. Requests without `limit` retain the legacy base-table query for older clients.

**Response** `200`
```json
{
  "sessions": [
    {
      "sessionId": "codex:019e86c2-fd17-7031-b8cb-63c1f56d3609",
      "nativeSessionId": "019e86c2-fd17-7031-b8cb-63c1f56d3609",
      "runtime": "codex",
      "preview": "Review the current changes",
      "lastActive": "2026-03-27T10:30:00.000Z",
      "size": 102400,
      "model": "gpt-5",
      "modelProvider": "openai",
      "clientSource": "codex-tui",
      "cliVersion": "0.147.0",
      "status": "completed"
    },
    {
      "sessionId": "b880a5db-xxxx-xxxx-xxxx",
      "preview": "Fix the login bug",
      "lastActive": "2026-03-26T15:00:00.000Z",
      "size": 8192,
      "model": "claude-opus-4-6-20250610",
      "nativeSessionId": "b880a5db-xxxx-xxxx-xxxx",
      "runtime": "claude",
      "status": "completed"
    }
  ],
  "hasMore": true,
  "nextCursor": "eyJhY2NvdW50SWQiOi..."
}
```

`hasMore` and `nextCursor` are returned only when `limit` is provided.

Existing rows gain the sparse list-index fields during the Bridge's full catalog sync
after an upgrade. Before enabling paginated clients on an existing stack, run the
idempotent backfill once to include rows belonging to offline devices:

```bash
python3 server/backfill-list-index.py \
  --table AgentPeekTest-bridge-sessions \
  --region ap-northeast-1 \
  --dry-run
```

Remove `--dry-run` after checking the counts. The GSI must be active before applying
the backfill. Concurrent Bridge writes are skipped and reported as `conflicts`; rerun
the command until that count reaches zero.

**Notes**:
- Sorted by `lastActive` descending
- `status`: `running`, `needs_input`, or `completed`
- `modelProvider`, `clientSource`, and `cliVersion` are sparse optional fields

---

### GET /api/bridge/messages

Get messages for a specific session, supports incremental loading.

**Query**:
| Param | Required | Description |
|-------|----------|-------------|
| `session` | Yes | sessionId |
| `after` | No | ISO 8601 timestamp, returns messages after this time |
| `before` | No | Opaque `oldestTimestamp` cursor returned by the previous page |
| `limit` | No | Page size; default 100, maximum 500 |
| `device` | No | Target device for routing a `needSync` request to the matching Bridge |

**Examples**:
- Full load: `GET /api/bridge/messages?session=a1ca0870-xxxx`
- Incremental: `GET /api/bridge/messages?session=a1ca0870-xxxx&after=2026-03-27T10:30:01.000Z`

**Logic**:
- Default: consistently read the newest page, then return it in ascending order
- With `before`: fetch the preceding page
- With `after`: fetch all rows after the timestamp, used for reconnect recovery
- DDB empty: return `needSync: true`, simultaneously notify bridge via WS to sync this session

**Response** `200` — has messages:
```json
{
  "messages": [...],
  "hasMore": true,
  "oldestTimestamp": "2026-03-27T10:30:00.000Z#msg_abc123",
  "needSync": false
}
```

**Response** `200` — DDB has no cache (needs bridge sync):
```json
{
  "messages": [],
  "needSync": true
}
```

**needSync triggered flow**:
```
1. Server returns needSync: true, simultaneously notifies bridge via WS:
   → { action: "sync_session", sessionId: "codex:abc", runtime: "codex", nativeSessionId: "abc" }
2. Bridge selects the runtime adapter, reads JSONL → POST /sync-messages to write DDB
3. Bridge completes, notifies server via WS:
   → { action: "sync_complete", sessionId: "abc" }
4. Server broadcasts to all app connections under the account:
   → { action: "sync_complete", sessionId: "abc" }
5. App receives it, re-fetches GET /messages → has data now → render
```

**Notes**:
- `content` is a JSON array (deserialized from JSON string in DDB)
- `type` includes `user`, `assistant`, `summary`, `system_event`, `interrupt`, and Claude metadata types
- Content block types: `text`, `image`, `document`, `thinking`, `tool_use`, `tool_result`
- `document` block: `{ type: "document", source: { type: "text", media_type: "text/plain", data: "..." }, title: "filename.txt" }`
- Sorted by `timestamp` ascending (conversation order)

`stopReason` and `toolUseResult` are persisted when present. `parentUuid` and transient streaming
fields are not persisted.

---

### GET /api/bridge/image/{key}

Get image (proxied from S3).

**Path params**:
| Param | Description |
|-------|-------------|
| `key` | Image filename, e.g. `903158ab.jpg` |

**Logic**: Read from S3 `images/{key}` and return

**Response** `200`: **base64-encoded JPEG as `text/plain`** (NOT raw binary)

**Notes**:
- App loads images via this endpoint to avoid exposing S3 directly
- Returns base64 text rather than binary to avoid API Gateway binary-encoding pitfalls and stay compatible with GZip middleware. Frontend (`loadOneImage`) reads `res.text()` and assembles a `data:image/jpeg;base64,...` URL
- `404` if key not found

---

### GET /api/bridge/file/{key}

Get a synced project file's content (proxied from S3).

**Path params**:
| Param | Description |
|-------|-------------|
| `key` | File key as returned by `request_file` → `file_ready`, e.g. `5f3a9c1b2d4e6f80.ts` |

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

`deviceName` is only carried by bridge connections, used for:
- Device routing for `send_message` / `permission_reply` / `interrupt` (only forwarded to matching bridge)
- Online status in `GET /devices`

Bridge connections also send their immutable package version as the `version` query parameter.
The server stores it as `bridgeVersion` so deployments can verify the running fleet directly.

The server strips the `device` routing field before forwarding an app action to Bridge. Codex
uses `messages`/`messages_ack` for live rollout updates and supports existing-Session
send/streaming/interrupt and runtime-specific permission handling through its app-server adapter.

**$disconnect**: Delete connectionId + clean up related subscription records

---

### App → Server

#### subscribe

Subscribe to real-time messages for a session.

```json
{ "action": "subscribe", "sessionId": "a1ca0870-xxxx" }
```

**Server handling**:
1. Record subscription in DDB Subscriptions table

**Subscriptions table**:
```
PK: sessionId
SK: connectionId
Attributes: accountId, subscribedAt
TTL: 24h
```

---

#### unsubscribe

Cancel subscription.

```json
{ "action": "unsubscribe", "sessionId": "a1ca0870-xxxx" }
```

**Server handling**: Delete corresponding record in Subscriptions table

---

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
| `runtime` | Runtime selected from the target device's `canCreate` capabilities; defaults to `claude` for old clients |
| `asAgent` | `true` → new Claude Session runs as a Claude Agents background session; ignored for Codex |

**Server handling**: Forward to matching bridge by `device`. Bridge handling:
1. Has sessionId → route by runtime: Claude uses the headless pool; Codex uses
   `thread/resume` + `turn/start` through the managed Unix-socket app-server when available,
   with an isolated stdio app-server fallback
2. No sessionId, has projectHash → route by selected runtime: Claude uses its existing headless
   creation path; Codex uses `thread/start` + `turn/start` on one cwd-scoped app-server client

**Return**: Bridge sends `send_message_result` (with `sessionId` + echoed `requestId`) → Server broadcasts to all app connections.

---

#### permission_reply

Reply to a permission confirmation or user choice.

```json
{
  "action": "permission_reply",
  "sessionId": "a1ca0870-xxxx",
  "requestId": "ctrl_123",
  "decision": "answer",
  "answerText": "西瓜",
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
deduplicated, and only the active request ID can be answered. Opening a Codex session also
passively resumes an already-loaded managed-daemon thread. This subscribes to its existing turn
and replays TUI-owned pending requests without starting a turn or invoking writer takeover.
If another app-server client resolves a request first, `serverRequest/resolved` removes it from
the bridge queue and emits `permission_resolved` for the visible prompt.

---

#### interrupt

Interrupt the currently running Claude Code (equivalent to Ctrl+C).

```json
{ "action": "interrupt", "sessionId": "a1ca0870-xxxx", "device": "MacBook-Pro" }
```

**Server handling**: Forward to matching bridge by `device`. Bridge SIGINTs the session's headless Claude Code process (`_pool.interrupt`).

---

#### reveal_agent

Requests Bridge to resend a still-pending Claude control request after refresh or reconnect.

```json
{ "action": "reveal_agent", "sessionId": "a1ca0870-xxxx", "device": "MacBook-Pro" }
```

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
| `projectPath` | Yes | Path relative to `$HOME` (absolute paths under `$HOME` also accepted) |
| `device` | Yes | Target device |
| `asAgent` | No | Legacy compatibility field echoed for older clients; the current New Project UI does not send it |

**Server handling**: Forward to matching bridge by `device` (rejected with `400` if `projectPath` missing).

**Bridge handling**: create the path → derive `projectHash` → call REST `create-project` → reply
`create_project_result`.

---

#### request_file

Ask the bridge to read a project file from the device's local disk and upload it to S3, so the app can view its actual content (highlighted) when the user clicks a file reference in a Read/Edit/Write tool node or an inline file link.

```json
{
  "action": "request_file",
  "path": "bridge/ws.mjs",
  "sessionId": "a1ca0870-xxxx",
  "projectHash": "-Users-xiaoweii-workspace-rn-agentpeek",
  "device": "MacBook-Pro",
  "requestId": "file_xyz789"
}
```

**Fields**:
| Field | Required | Description |
|-------|----------|-------------|
| `path` | Yes | File path. Absolute, or relative to the session's project directory |
| `projectHash` | No | Used to resolve relative `path` against the project's real directory (`projectHashToPath`) |
| `sessionId` | Yes | Used to scope the `file_ready` reply to subscribers of this session |
| `device` | Yes | Target device (routing) |
| `requestId` | Yes | Client-generated id, echoed back in `file_ready` to match the open viewer |

**Server handling**: Forward to matching bridge by `device` (via `_handle_send_to_bridge`).

**Bridge handling**:
1. Resolve `path` (relative → join with `projectHashToPath(projectHash)`)
2. `stat` the file (mtime + size only — **no read yet**); reject directories
3. Decide type by extension: video (`.mp4 .m4v .mov .webm .mkv .avi`), image (`.png .jpg .jpeg .gif .webp .bmp .svg .ico .avif`), else text
4. Compute `key` from the stat (see key formula under `POST /upload-file`)
5. **Dedup**: if `key` is already in the bridge's in-memory uploaded-set → skip read + upload, reply `file_ready` immediately (videos dedup via S3 HEAD in `video-prepare` instead)
6. Read + upload:
   - **Video**: reject if larger than **5 GB** (`error: "video too large"`). Send an immediate `file_progress` ack (see below), then `POST /api/bridge/video-prepare` → stream the file to the presigned PUT URL (or skip if it already exists). Reply `file_ready` with `video: true`
   - **Text**: read up to **5 MB** (larger → read first 5 MB, drop the partial last line, set `truncated: true`); reject if a NUL byte appears in the first 8 KB (`error: "binary file"`); `POST /api/bridge/upload-file`
   - **Image**: reject if larger than **10 MB** (`error: "image too large"` — never truncate image bytes); otherwise read the **whole** file and `POST /api/bridge/upload-image` (reuses the image endpoint + `GET /image/{key}` retrieval)
7. Add `key` to the uploaded-set (text/image), reply `file_ready` via WS (no path restriction beyond OS permissions — matches Claude Code's own Read scope)

**Caching & dedup** (no separate mtime tracking needed — the key *is* the version):
- Because `key` embeds `mtime + size`, an unchanged file always hashes to the same key and an edited file always hashes to a new one. "Already synced and unchanged" ≡ "this key is already known".
- **Bridge** keeps a bounded **LRU set of uploaded keys** (cap 1000 keys ≈ ~25 KB; evict oldest on overflow). A hit skips both the disk read and the S3 upload. Memory stays capped; an evicted key just causes one harmless re-upload on next click (S3 PUT is idempotent — same key overwrites identical bytes). The set is in-memory only, so a bridge restart may re-upload each file at most once.
- **App** keeps a `fileCache` keyed by `key`; a hit skips the `GET /file/{key}`. Since the key changes when the file changes, the cache never serves stale content. Images reuse the shared in-memory `imageCache` (data URLs, cap 200) across inline thumbnails and the preview overlay; videos cache their presigned URL in `state.videoUrlCache` (~50 min). All three are in-memory only — cleared on page refresh.

#### list_commands

Ask the bridge for the slash-command catalog of the active runtime.

```json
{
  "action": "list_commands",
  "projectHash": "-Users-xiaoweii-workspace-rn-agentpeek",
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
| `knownRevision` | No | Revision already stored by the app; matching responses omit `commands` and `skills` |
| `requestId` | Yes | Client-generated id, echoed back in `commands_list` |

**Server handling**: Forward to matching bridge by `device` (via `_handle_send_to_bridge`).

The Bridge caches the normalized project catalog by `runtime + project path` for five minutes.
Fresh cache hits do not start Claude or query Codex app-server again. Expired entries are refreshed
on demand, concurrent refreshes share one promise, and the revision changes only when normalized
command or Skill content changes.

**Claude handling**:
1. Start a short-lived `claude -p` process with `--no-session-persistence`.
2. Send stream-json `control_request {subtype:"initialize"}`.
3. Use the returned runtime-filtered commands, descriptions, argument hints, aliases,
   models and provider/account state. No environment-specific command or model table is
   hardcoded in AgentPeek.
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

Bridge pushes new messages to Server.

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

**Server (Lambda) handling**:
1. Query Subscriptions table (PK=sessionId) → get all subscribed app connectionIds
2. **Has subscribers** → `post_to_connection` push to all apps first (latency-sensitive)
3. **Write DDB** → BridgeMessages table; acknowledge only after persistence succeeds

Message format pushed to app:
```json
{
  "action": "messages",
  "sessionId": "a1ca0870-xxxx",
  "messages": [...]
}
```

**Notes**:
- Normal real-time messages use WS and are cached by Lambda
- `noCache:true` means the WS copy is only a size-limited preview; Bridge writes the authoritative copy through REST
- Startup, retry, and on-demand history use REST `sync-messages`
- When no app is subscribed, only writes DDB (no wasted forwarding)

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
      "question": "你最喜欢哪种水果？",
      "header": "水果",
      "options": [{ "label": "西瓜", "description": "水分充足" }],
      "multiSelect": false
    }
  ],
  "input": {}
}
```

**Server handling**: `_handle_bridge_relay` — query Subscriptions table by sessionId, forward to all subscribed app connections (excluding bridge itself).

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
{ "action": "send_message_result", "ok": true, "sessionId": "new-session-id", "requestId": "req_abc123", "clientId": "client_123", "streamId": "stream_123" }
```

Synchronous local commands may also return:

```json
{
  "action": "send_message_result",
  "ok": true,
  "sessionId": "session-id",
  "clientId": "client_123",
  "streamId": "stream_123",
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

`commandPanel` is ephemeral UI state. The server broadcasts it verbatim but does not write it to
the Claude transcript. The frontend stores `commandOutput` as the panel's copyable text fallback.

**Fields**: `ok`, optional `sessionId` (new sessions only), `error` (when `ok=false`),
`requestId`, `clientId`, and `streamId`. Immediate Codex commands may also return
`commandOutput`; the app atomically promotes the optimistic command bubble and renders that
ephemeral local result without writing it to rollout history.

**Server handling**: `_handle_bridge_broadcast` — broadcast to **all** app connections under this accountId (not limited to subscribers).

---

#### create_project_result

Bridge returns the result after processing `create_project`.

```json
{ "action": "create_project_result", "ok": true, "projectHash": "-Users-user-workspace-my-new-project", "projectName": "my-new-project", "projectPath": "workspace/my-new-project" }
```

**Fields**: `ok`, `projectPath` (echoed, used by the app to match the pending create), optional `sessionId`, and `error` (when `ok=false`).

**Server handling**: `_handle_bridge_broadcast` — broadcast to **all** app connections under this accountId.

---

#### delete_files_result

Bridge reports completion of optional local history deletion.

```json
{ "action": "delete_files_result", "requestId": "delete_123", "ok": true, "skippedReadOnly": 1 }
```

The result is broadcast to all app connections under the account.

---

#### heartbeat

```json
{ "action": "heartbeat" }
```

Same as App heartbeat.

---

#### sync_complete

Bridge notifies server after completing an on-demand sync.

```json
{ "action": "sync_complete", "sessionId": "a1ca0870-xxxx", "status": "ok", "count": 42 }
```

**Server handling**: Broadcast to all app connections under the account. This avoids losing a
fast completion before the app's subscription write becomes visible.

---

#### file_ready

Bridge has uploaded a requested file to S3 and notifies the app. Sent in response to `request_file`.

```json
{
  "action": "file_ready",
  "requestId": "file_xyz789",
  "sessionId": "a1ca0870-xxxx",
  "key": "5f3a9c1b2d4e6f80.ts",
  "path": "/Users/xiaoweii/workspace/rn/agentpeek/bridge/ws.mjs",
  "size": 18342,
  "truncated": false,
  "image": false
}
```

**Fields**:
| Field | Description |
|-------|-------------|
| `requestId` | Echoed from `request_file`, matches the open viewer |
| `sessionId` | Used by the server to scope forwarding to this session's subscribers |
| `key` | S3 key. Fetch text via `GET /api/bridge/file/{key}`, images via `GET /api/bridge/image/{key}` |
| `path` | Resolved absolute path (shown in the viewer header) |
| `size` | Full byte size of the file (not the post-truncation size) |
| `truncated` | Text only: `true` if the file exceeded 5 MB (first 5 MB synced, partial last line dropped). Always `false` for images |
| `image` | `true` if the file is an image — the app fetches `GET /image/{key}` and opens the image viewer instead of the highlighted text viewer |
| `video` | `true` if the file is a video — the app fetches `GET /video-url/{key}` and plays it in a `<video>` element streaming directly from S3 |
| `error` | Present (instead of `key`) when the read failed — `not found`, `is a directory`, `binary file`, `image too large`, `video too large`, `upload failed` |

**Note on syntax highlighting**: the bridge does *not* send a language hint. The app derives the highlight.js language from the file extension (`detectLang(path)`), falling back to `highlightAuto` for unknown extensions and to plain text for files larger than 256 KB (to avoid blocking the UI). Images skip highlighting entirely and reuse the image overlay (`viewImage`), with the `data:` MIME type derived from the key's extension.

#### file_progress

Sent by the bridge **before** a video's (potentially long) S3 upload finishes, so the app stops its `request_file` timeout/retry and shows "Uploading video…" instead of falsely timing out or re-triggering the upload. Forwarded to the session's subscribers like `file_ready`.

```json
{ "action": "file_progress", "requestId": "file_xyz789", "sessionId": "a1ca0870-xxxx", "video": true }
```

The app matches by `requestId`, clears the pending timer (keeping `_pendingFileReq` alive so the eventual `file_ready` still matches), and updates the loading label. Only used for videos.

**Server handling**: `_handle_bridge_relay` — forward to all app connections subscribed to `sessionId` (excluding the bridge).

---

#### commands_list

Bridge replies with the scanned slash-command list (response to `list_commands`).

```json
{
  "action": "commands_list",
  "requestId": "cmds_1717300000000",
  "runtime": "codex",
  "device": "MacBook-Pro",
  "projectHash": "-Users-xiaoweii-workspace-rn-agentpeek",
  "revision": "a1b2c3d4",
  "notModified": false,
  "commands": [
    { "name": "skills", "source": "builtin", "behavior": "picker" },
    { "name": "review", "source": "builtin", "behavior": "send" }
  ],
  "skills": [
    { "name": "reviewer", "description": "Review changes", "scope": "user" }
  ]
}
```

**Fields**:
| Field | Description |
|-------|-------------|
| `requestId` | Echoed from `list_commands`; stale replies are ignored |
| `runtime`, `device`, `projectHash` | Echoed project context used to ignore account-wide broadcasts for another view |
| `revision` | Stable hash of the normalized project catalog |
| `notModified` | `true` when `knownRevision` matches; `commands` and `skills` are omitted |
| `stale` | The Bridge returned its last known catalog because a refresh failed |
| `error` | Refresh error detail; empty on a normal response |
| `commands` | Ordered command descriptors; Codex descriptors include behavior, description, and optional argument hint |
| `skills` | Enabled Codex Skills from app-server; empty for Claude |

**Server handling**: `_handle_bridge_broadcast` — broadcast to **all** app connections for the account (not scoped by session). This is deliberate: the new-session view has no `sessionId` subscription, so a session-scoped relay (like `file_ready`) wouldn't reach it. Same pattern as `create_project_result`.

When `notModified` is true, the response is only a small acknowledgement:

```json
{
  "action": "commands_list",
  "requestId": "cmds_1717300000000",
  "revision": "a1b2c3d4",
  "notModified": true,
  "stale": false
}
```

#### list_command_options / command_options

Session-scoped picker options are not stored in the project catalog. Selecting a command marked
`optionsRemote` requests its current options:

```json
{
  "action": "list_command_options",
  "requestId": "cmdopts_1717300000000",
  "runtime": "codex",
  "projectHash": "-Users-xiaoweii-workspace-rn-agentpeek",
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

Claude headless preview actions are relayed to subscribed apps and never written to DDB:

```text
stream_block_start
stream_delta
stream_tool_input
stream_block_stop
stream_end
```

Every frame carries `sessionId`, `streamId`, and monotonic `seq`; block actions also carry
`blockId`. `stream_end.finalSeq` lets the app finish its reorder buffer. Authoritative
`messages` rows replace previews by identity.

---

### Server → Bridge (Push)

#### messages_ack

Server acknowledges receipt and successful DDB persistence of bridge messages, allowing bridge to
advance its synced pointer. If persistence fails after retry, the server withholds the ack so the
bridge uses its HTTP fallback before advancing.

```json
{ "action": "messages_ack", "sessionId": "a1ca0870-xxxx" }
```

**Bridge handling**: `wsSendWithAck` waits for this message (5s timeout). Received → resolve(true), bridge advances line number. Timeout → resolve(false), bridge falls back to HTTP POST to DDB.

---

#### sync_session

Server notifies bridge to sync a specific session's messages to DDB (triggered by GET /messages returning needSync).

```json
{
  "action": "sync_session",
  "sessionId": "codex:019e...",
  "runtime": "codex",
  "nativeSessionId": "019e..."
}
```

**Bridge handling**:
1. Select runtime adapter and find the corresponding JSONL by native ID
2. Read and extract messages → POST /sync-messages to write DDB
3. On completion, send `sync_complete` via WS

All App → Server operational actions are also forwarded to the matching Bridge after `device`
is removed: `send_message`, `permission_reply`, `interrupt`, `reveal_agent`, `request_file`,
`delete_files`, `list_commands`, and `create_project`.

---

### Server → App (Push)

#### messages

Server forwards bridge messages to app (only pushed to app connections subscribed to this sessionId).

```json
{
  "action": "messages",
  "sessionId": "a1ca0870-xxxx",
  "messages": [...]
}
```

---

#### permission_request

Server forwards bridge permission confirmation request (only pushed to app connections subscribed to this sessionId).

```json
{
  "action": "permission_request",
  "sessionId": "a1ca0870-xxxx",
  "kind": "tool",
  "requestId": "ctrl_123",
  "toolName": "Bash",
  "input": { "command": "npm test" }
}
```

---

#### send_message_result

Server forwards bridge send result (broadcast to **all** app connections under this account).

```json
{ "action": "send_message_result", "ok": true, "sessionId": "new-session-id", "requestId": "req_abc123", "clientId": "client_123", "streamId": "stream_123" }
```

---

#### create_project_result

Server forwards bridge create-project result (broadcast to **all** app connections under this account).

```json
{ "action": "create_project_result", "ok": true, "projectHash": "-Users-user-workspace-my-new-project", "projectName": "my-new-project", "projectPath": "workspace/my-new-project" }
```

---

#### sync_complete

Notifies app that a session's historical messages have been synced to DDB, app can re-fetch GET /messages.

```json
{ "action": "sync_complete", "sessionId": "a1ca0870-xxxx", "status": "ok", "count": 42 }
```

---

#### streaming and operation results

The server forwards `stream_block_start`, `stream_delta`, `stream_tool_input`,
`stream_block_stop`, `stream_end`, `file_progress`, and `delete_files_result` using the same
payloads documented above. Streaming/file progress is subscription-scoped; deletion results are
account-wide.

---

#### file_ready

Server forwards bridge's file-ready notification (only pushed to app connections subscribed to this sessionId). Same payload as the Bridge → Server `file_ready` above. The app matches it by `requestId`, then fetches the content (`GET /file/{key}` for text → highlight.js, `GET /image/{key}` for images → image viewer, or `GET /video-url/{key}` for videos → `<video>` streaming from S3).

```json
{
  "action": "file_ready",
  "requestId": "file_xyz789",
  "sessionId": "a1ca0870-xxxx",
  "key": "5f3a9c1b2d4e6f80.ts",
  "path": "/Users/xiaoweii/workspace/rn/agentpeek/bridge/ws.mjs",
  "size": 18342,
  "truncated": false,
  "image": false
}
```

---

#### commands_list

Server broadcasts the bridge's slash-command list to all app connections under the account. The
app accepts only the reply matching its latest request and current device/runtime/project/session,
then caches the ordered `{commands, skills}` payload under
`apeek_cmds:v5:<device>:<runtime>:<projectHash>`.

```json
{
  "action": "commands_list",
  "requestId": "cmds_1717300000000",
  "commands": [{ "name": "commit", "source": "user" }]
}
```

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

## DynamoDB Table Overview

| Table | PK | SK | Purpose | TTL |
|-------|----|----|---------|-----|
| BridgeSessions | accountId | `DEV#...` / `PROJ#...` / `SESS#...` | Device, Project, and Session metadata | No TTL value written |
| BridgeMessages | sessionId | timestamp#uuid | Message cache | 90 days |
| Connections | connectionId | — | WS connection records with role/device routing | 24h |
| Subscriptions | sessionId | connectionId | WS subscription relationships | 24h |

---

## Known Limitations & Design Notes

### DDB message fields

DDB stores `uuid`, `type`, `content`, `timestamp`, plus optional `stopReason` and
`toolUseResult`. `parentUuid`, stream IDs, sequence numbers, and preview-only fields are not
persisted.

### Connection routing indexes

Bridge routing queries `Connections.accountId-role-index`. Disconnect cleanup queries
`Subscriptions.connectionId-index`.

### send_message_result broadcast scope

`send_message_result` uses `_handle_bridge_broadcast` to broadcast to **all** app connections under the account, not just the requester. When multiple devices/tabs are open, all apps receive the new session's `sessionId`. Frontend handles this via `appState.session === '__new__'` check — no functional impact.

### device routing strips `device` before forwarding

`_handle_send_to_bridge` rebuilds the payload without `device`, then forwards only to bridge
connections whose `deviceName` matches. Applies to `send_message`, `permission_reply`,
`interrupt`, `reveal_agent`, `create_project`, `request_file`, `delete_files`, and
`list_commands`.

### Codex

Codex participates in Session metadata, history reads, `sync_session`, `sync_complete`, and live
`messages`/`messages_ack` updates from the rollout watcher. Existing-Session `send_message`,
streaming, interrupt, and permission requests use the app-server adapter. The adapter reuses a
managed Unix WebSocket daemon when present, including active-turn and pending-approval recovery,
and falls back to `app-server --stdio` otherwise. Revealing an existing session uses a
managed-daemon-only passive subscription: it never starts a turn and never terminates a writer.
The standalone writer termination flow remains only as the explicit fallback for a subsequent
message send that cannot share a daemon. New-Session creation is supported; local history
deletion remains disabled by Codex runtime capabilities. Project directory creation is
runtime-neutral. See [codex.md](codex.md) for validation.

### Image & file endpoints have no account isolation

`GET /api/bridge/image/{key}`, `GET /api/bridge/file/{key}`, and `GET /api/bridge/video-url/{key}` do not verify accountId — any valid API key can access any image/file/video. Relies on the key being a hash value that is not guessable. `POST /upload-image` / `POST /upload-file` / `POST /video-prepare` similarly do not associate with an account.
