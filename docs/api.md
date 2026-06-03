# AgentPeek API Specification

## General

**Base URL**: `https://{api-id}.execute-api.{region}.amazonaws.com/v1`

**Authentication**: All endpoints (REST + WS) require an API Key
- REST: `x-api-key` header
- WS: query string `?apiKey=xxx` on connection

**accountId derivation**: `SHA256(apiKey)[:16]`, used for DDB queries — the raw key is never stored

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
      "project": "-Users-xiaoweii-workspace-rn-agentpeek",
      "projectName": "agentpeek",
      "lastActive": "2026-03-27T10:30:00.000Z",
      "size": 102400,
      "preview": "Help me implement Phase 2 APIs",
      "model": "claude-sonnet-4-5-20250514",
      "status": "running"
    }
  ]
}
```

**Response** `200`
```json
{ "synced": 1 }
```

**DDB write**: BridgeSessions table
- PK: `accountId`
- SK: `{deviceName}#{project}#{id}`

---

### POST /api/bridge/sync-messages

Bridge batch-uploads messages to DDB. Used for initial sync on startup (top 2 sessions per project). Real-time messages during runtime are pushed via WS, with Lambda writing to DDB.

**Request**
```json
{
  "sessionId": "a1ca0870-xxxx-xxxx-xxxx",
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

## REST API — General

### GET /api/health

Connectivity check, called by app on startup.

**Query**: none

**Response** `200`
```json
{ "status": "ok", "version": "dev" }
```

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

Generates a bridge install script (shell), used by the setup page. Automatically configures launchd (macOS) or systemd (Linux) auto-start service.

**Query**:
| Param | Required | Description |
|-------|----------|-------------|
| `name` | No | Device name (if omitted, script asks interactively, defaults to hostname) |

**Alias**: `GET /api/install` (same handler)

**Response** `200`: `text/plain` shell script

**Script logic**:
1. Download bridge.tar.gz (S3 presigned URL, valid 1h)
2. npm install
3. Write launchd plist / systemd service (contains server URL + API key + device name)
4. Start service

---

## REST API — App → Server

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
      "idleCount": 1,
      "lastActive": "2026-03-27T10:30:00.000Z",
      "online": true
    },
    {
      "deviceName": "Ubuntu-Server",
      "os": "linux",
      "projectCount": 3,
      "sessionCount": 38,
      "runningCount": 0,
      "idleCount": 0,
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
- `idleCount`: sessions with `status="idle"`
- `lastActive`: most recent session's lastActive on this device
- `online`: whether bridge WS is connected (checks Connections table for role=bridge with matching deviceName)
- Sorted by `lastActive` descending

---

### GET /api/bridge/projects

Get projects under a specific device.

**Query**:
| Param | Required | Description |
|-------|----------|-------------|
| `device` | Yes | Device name |

**Example**: `GET /api/bridge/projects?device=MacBook-Pro`

**Logic**: Scan BridgeSessions (PK=accountId, SK begins_with `{device}#`), aggregate by `projectHash`

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
      "idleCount": 1,
      "lastActive": "2026-03-27T10:30:00.000Z"
    }
  ]
}
```

**Notes**:
- `projectName`: last path segment (directory name), used as UI title
- `projectPath`: full path relative to home, used as UI subtitle
- `projectHash`: passed back when calling the sessions endpoint
- `runningCount`: sessions with `status="running"`
- `idleCount`: sessions with `status="idle"`
- Sorted by `lastActive` descending

---

### GET /api/bridge/sessions

Get sessions under a specific device + project.

**Query**:
| Param | Required | Description |
|-------|----------|-------------|
| `device` | Yes | Device name |
| `project` | Yes | projectHash |

**Example**: `GET /api/bridge/sessions?device=MacBook-Pro&project=-Users-xiaoweii-workspace-rn-agentpeek`

**Logic**: Query BridgeSessions (PK=accountId, SK begins_with `{device}#{project}#`)

**Response** `200`
```json
{
  "sessions": [
    {
      "sessionId": "a1ca0870-xxxx-xxxx-xxxx",
      "preview": "Help me implement Phase 2 APIs",
      "lastActive": "2026-03-27T10:30:00.000Z",
      "size": 102400,
      "model": "claude-sonnet-4-5-20250514",
      "status": "running"
    },
    {
      "sessionId": "b880a5db-xxxx-xxxx-xxxx",
      "preview": "Fix the login bug",
      "lastActive": "2026-03-26T15:00:00.000Z",
      "size": 8192,
      "model": "claude-opus-4-6-20250610",
      "status": "stopped"
    }
  ]
}
```

**Notes**:
- Sorted by `lastActive` descending
- `status`: session state (`running`/`idle`/`stopped`)

---

### GET /api/bridge/messages

Get messages for a specific session, supports incremental loading.

**Query**:
| Param | Required | Description |
|-------|----------|-------------|
| `session` | Yes | sessionId |
| `after` | No | ISO 8601 timestamp, returns messages after this time |

**Examples**:
- Full load: `GET /api/bridge/messages?session=a1ca0870-xxxx`
- Incremental: `GET /api/bridge/messages?session=a1ca0870-xxxx&after=2026-03-27T10:30:01.000Z`

**Logic**:
- No `after`: query BridgeMessages (PK=sessionId), return all
- With `after`: query BridgeMessages (PK=sessionId, SK > after#\xff), single query
- DDB empty: return `needSync: true`, simultaneously notify bridge via WS to sync this session

**Response** `200` — has messages:
```json
{
  "messages": [...],
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
   → { action: "sync_session", sessionId: "abc" }
2. Bridge receives it, reads .jsonl → POST /sync-messages to write DDB
3. Bridge completes, notifies server via WS:
   → { action: "sync_complete", sessionId: "abc" }
4. Server forwards to all apps subscribed to this session:
   → { action: "sync_complete", sessionId: "abc" }
5. App receives it, re-fetches GET /messages → has data now → render
```

**Notes**:
- `content` is a JSON array (deserialized from JSON string in DDB)
- `type`: `user` | `assistant` | `system` | `summary` | `ai-title`
- Content block types: `text`, `image`, `document`, `thinking`, `tool_use`, `tool_result`
- `document` block: `{ type: "document", source: { type: "text", media_type: "text/plain", data: "..." }, title: "filename.txt" }`
- Sorted by `timestamp` ascending (conversation order)

**Fields NOT stored in DDB** (only passed via WS real-time, not in REST response):
- `stopReason`: assistant message stop reason (`end_turn` / `tool_use` / null), used by frontend to determine wsRunning state
- `toolUseResult`: Agent tool execution metadata `{ status, totalDurationMs, totalToolUseCount, totalTokens, agentId }`, attached to tool_result messages
- Impact: messages loaded from DDB after page refresh lack these fields. wsRunning can degrade to session-level `status`, Agent stats are lost

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
- App fetches the file body via this endpoint (REST, gzip-compressed, no WebSocket 128KB frame limit), then renders it with highlight.js in the file viewer
- The viewer caches by `key`; since the key embeds mtime+size, an edited file is re-fetched automatically
- `404` if key not found

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
  Attributes: accountId, role (app|bridge), deviceName?, connectedAt
  TTL: 24h
```

`deviceName` is only carried by bridge connections, used for:
- Device routing for `send_message` / `permission_reply` / `interrupt` (only forwarded to matching bridge)
- Online status in `GET /devices`

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
2. Find bridge connections under this accountId
3. Notify bridge to start pushing this session

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

Send a message to Claude Code (via tmux). Supports two modes:

**Existing session:**
```json
{ "action": "send_message", "sessionId": "a1ca0870-xxxx", "text": "help me fix this bug", "device": "MacBook-Pro" }
```

**New session (no sessionId, with projectHash):**
```json
{ "action": "send_message", "projectHash": "-Users-xxx-workspace-project", "text": "hello", "device": "MacBook-Pro", "requestId": "req_abc123", "asAgent": false }
```

**Optional fields**:
| Field | Description |
|-------|-------------|
| `requestId` | Client-generated id echoed back in `send_message_result`. Used as the launch lock key and to match the result to the originating new-session request |
| `asAgent` | `true` → launch/route via `claude agents` TUI (Claude Agents background session) instead of a normal `claude --resume` session |

**Server handling**: Forward to matching bridge by `device`. Bridge handling:
1. Has sessionId → find corresponding tmux pane → sendKeys
2. Has sessionId but no tmux target → auto-create tmux + `claude --resume` → wait ready → sendKeys
3. No sessionId, has projectHash → create tmux + `claude` (or `claude agents` if `asAgent`) → wait ready → sendKeys → poll .jsonl for new sessionId

**Return**: Bridge sends `send_message_result` (with `sessionId` + echoed `requestId`) → Server broadcasts to all app connections.

---

#### permission_reply

Reply to a permission confirmation or user choice.

```json
{ "action": "permission_reply", "sessionId": "a1ca0870-xxxx", "approved": "arrow:1", "device": "MacBook-Pro" }
```

**approved values**:
| Value | Description |
|-------|-------------|
| `arrow:N` | Select the Nth option (0-based, applies to all selection UIs) |
| `type:N:text` | Navigate to Nth option (Type something), enter text, press Enter |
| `escape` | Cancel/dismiss the prompt |

**Server handling**: Forward to matching bridge by `device`.

**Permission detection mechanism**: App detects tools requiring user confirmation from `tool_use` blocks in WS real-time messages:
- AskUserQuestion / ExitPlanMode → show prompt immediately
- Bash / Edit / Write → delayed judgment; if tool_result arrives first, don't show (auto-approved)

---

#### interrupt

Interrupt the currently running Claude Code (equivalent to Ctrl+C).

```json
{ "action": "interrupt", "sessionId": "a1ca0870-xxxx", "device": "MacBook-Pro" }
```

**Server handling**: Forward to matching bridge by `device`. Bridge sends interrupt signal to the matching tmux pane.

---

#### create_project

Create a new project directory on the device and launch a Claude Code (or Claude Agents) session in it.

```json
{ "action": "create_project", "projectPath": "workspace/my-new-project", "device": "MacBook-Pro", "asAgent": false }
```

**Fields**:
| Field | Required | Description |
|-------|----------|-------------|
| `projectPath` | Yes | Path relative to `$HOME` (absolute paths under `$HOME` also accepted) |
| `device` | Yes | Target device |
| `asAgent` | No | `true` → launch via `claude agents` instead of a normal session |

**Server handling**: Forward to matching bridge by `device` (rejected with `400` if `projectPath` missing).

**Bridge handling**: `mkdir -p` the path → derive `projectHash` → launch a new session (normal or agent) → reply `create_project_result`.

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
3. Decide image vs text by extension (`.png .jpg .jpeg .gif .webp .bmp .svg .ico .avif` → image)
4. Compute `key` from the stat (see key formula under `POST /upload-file`)
5. **Dedup**: if `key` is already in the bridge's in-memory uploaded-set → skip read + upload, reply `file_ready` immediately
6. Read + upload:
   - **Text**: read up to **5 MB** (larger → read first 5 MB, drop the partial last line, set `truncated: true`); reject if a NUL byte appears in the first 8 KB (`error: "binary file"`); `POST /api/bridge/upload-file`
   - **Image**: reject if larger than **10 MB** (`error: "image too large"` — never truncate image bytes); otherwise read the **whole** file and `POST /api/bridge/upload-image` (reuses the image endpoint + `GET /image/{key}` retrieval)
7. Add `key` to the uploaded-set, reply `file_ready` via WS (no path restriction beyond OS permissions — matches Claude Code's own Read scope)

**Caching & dedup** (no separate mtime tracking needed — the key *is* the version):
- Because `key` embeds `mtime + size`, an unchanged file always hashes to the same key and an edited file always hashes to a new one. "Already synced and unchanged" ≡ "this key is already known".
- **Bridge** keeps a bounded **LRU set of uploaded keys** (cap 1000 keys ≈ ~25 KB; evict oldest on overflow). A hit skips both the disk read and the S3 upload. Memory stays capped; an evicted key just causes one harmless re-upload on next click (S3 PUT is idempotent — same key overwrites identical bytes). The set is in-memory only, so a bridge restart may re-upload each file at most once.
- **App** keeps a `fileCache` keyed by `key`; a hit skips the `GET /file/{key}`. Since the key changes when the file changes, the cache never serves stale content.

#### list_commands

Ask the bridge to scan all available slash commands (custom commands, skills, and enabled-plugin commands/skills) so the app can show a `/`-autocomplete menu like Claude Code's.

```json
{
  "action": "list_commands",
  "projectHash": "-Users-xiaoweii-workspace-rn-agentpeek",
  "device": "MacBook-Pro",
  "requestId": "cmds_1717300000000"
}
```

**Fields**:
| Field | Required | Description |
|-------|----------|-------------|
| `projectHash` | No | Resolves the project dir for project-level `.claude/commands` + `/skills`. Omitted/empty → user + plugin commands only (e.g. new-session view) |
| `device` | Yes | Target device (routing) |
| `requestId` | Yes | Client-generated id, echoed back in `commands_list` |

**Server handling**: Forward to matching bridge by `device` (via `_handle_send_to_bridge`).

**Bridge handling** (`scanSlashCommands`, live read — no cache/watch, ~15ms):
1. **User**: `~/.claude/commands/**/*.md` + `~/.claude/skills/*/SKILL.md`
2. **Project**: `<projectDir>/.claude/commands/**/*.md` + `/skills/*/SKILL.md`
3. **Plugins**: read `settings.json` `enabledPlugins`; resolve each plugin root (`installed_plugins.json` `installPath` → `extraKnownMarketplaces` path → `plugins/marketplaces/<mkt>/plugins/<name>` → `.../<name>`); scan its `/commands` + `/skills`
4. `name` = command file basename (sans `.md`) — directory entries only, no file read; subdirectories form a `:` namespace. Skill `name` is read from `SKILL.md` frontmatter `name` (falls back to dir name)
5. Append `BUILTIN_COMMANDS` (`source: "builtin"`) — bundled skills + builtin slash commands CC compiles into its binary (no file on disk): `batch` `code-review` `compact` `config` `context` `debug` `deep-research` `fewer-permission-prompts` `goal` `heapdump` `init` `insights` `loop` `reload-skills` `review` `run` `run-skill-generator` `security-review` `simplify` `stats` `status` `team-onboarding` `update-config` `usage` `verify` (`/clear` is excluded — it spawns a fresh empty session each time; use the "+" new-session button instead)
6. Dedup by `name` (priority user > project > plugin > builtin — so a user's `commit.md`/`recap.md` wins over a same-named built-in), then sort all names alphabetically (`localeCompare`); reply `commands_list`

Only command names are returned (no descriptions) — matches Claude Code's `/`-menu, which shows names only. Keeps the payload tiny (~2.5 KB for ~75 commands) and means command scanning needs no file reads.

**Built-ins**: bundled skills and builtin slash commands live in the CC binary, not on disk, so the directory scan can't see them. `BUILTIN_COMMANDS` is a hand-maintained list that mirrors **exactly** what the running CC surfaces in its `/`-menu beyond the disk-scannable commands — so AgentPeek's list matches CC 1:1 (no padding with CC's full `COMMANDS()` set, none of CC's hidden/feature-gated commands). Re-check on CC upgrades, since CC may add/remove bundled skills between versions (e.g. `deep-research`, `run`, `goal`, `run-skill-generator`, `team-onboarding` are newer additions).

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
2. Execute in parallel:
   - **Has subscribers** → `post_to_connection` push to all apps (priority, latency-sensitive)
   - **Write DDB** → BridgeMessages table (fallback cache, non-blocking)

Message format pushed to app:
```json
{
  "action": "messages",
  "sessionId": "a1ca0870-xxxx",
  "messages": [...]
}
```

**Notes**:
- Bridge only sends messages via WS, no longer writes DDB directly via HTTP POST
- DDB writes are handled by Lambda, in parallel with app push
- When no app is subscribed, only writes DDB (no wasted forwarding)

---

#### permission_request

Bridge detects a permission confirmation need, pushes to all apps subscribed to the session.

```json
{
  "action": "permission_request",
  "sessionId": "a1ca0870-xxxx",
  "title": "Run command?",
  "description": "npm install",
  "options": [
    { "label": "Yes", "value": "arrow:0", "key": "1" },
    { "label": "No", "value": "arrow:2", "key": "3" }
  ]
}
```

**Server handling**: `_handle_bridge_relay` — query Subscriptions table by sessionId, forward to all subscribed app connections (excluding bridge itself).

---

#### send_message_result

Bridge returns the result after processing send_message.

```json
{ "action": "send_message_result", "ok": true, "sessionId": "new-session-id (only for new sessions)", "requestId": "req_abc123" }
```

**Fields**: `ok`, optional `sessionId` (new sessions only), `error` (when `ok=false`), and `requestId` (echoed from the originating `send_message`, lets the app match the result to its new-session request).

**Server handling**: `_handle_bridge_broadcast` — broadcast to **all** app connections under this accountId (not limited to subscribers).

---

#### create_project_result

Bridge returns the result after processing `create_project`.

```json
{ "action": "create_project_result", "ok": true, "sessionId": "new-session-id", "projectPath": "workspace/my-new-project" }
```

**Fields**: `ok`, `projectPath` (echoed, used by the app to match the pending create), optional `sessionId`, and `error` (when `ok=false`).

**Server handling**: `_handle_bridge_broadcast` — broadcast to **all** app connections under this accountId.

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
{ "action": "sync_complete", "sessionId": "a1ca0870-xxxx" }
```

**Server handling**: Forward to all apps subscribed to this session.

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
| `error` | Present (instead of `key`) when the read failed — `not found`, `is a directory`, `binary file`, `image too large`, `upload failed` |

**Note on syntax highlighting**: the bridge does *not* send a language hint. The app derives the highlight.js language from the file extension (`detectLang(path)`), falling back to `highlightAuto` for unknown extensions and to plain text for files larger than 256 KB (to avoid blocking the UI). Images skip highlighting entirely and reuse the image overlay (`viewImage`), with the `data:` MIME type derived from the key's extension.

**Server handling**: `_handle_bridge_relay` — forward to all app connections subscribed to `sessionId` (excluding the bridge).

---

#### commands_list

Bridge replies with the scanned slash-command list (response to `list_commands`).

```json
{
  "action": "commands_list",
  "requestId": "cmds_1717300000000",
  "commands": [
    { "name": "commit", "source": "user" },
    { "name": "pdf", "source": "plugin" }
  ]
}
```

**Fields**:
| Field | Description |
|-------|-------------|
| `requestId` | Echoed from `list_commands` (the app currently ignores it — see broadcast note) |
| `commands` | Array of `{name, source}`; `source` ∈ `user` / `project` / `plugin` / `builtin` |

**Server handling**: `_handle_bridge_broadcast` — broadcast to **all** app connections for the account (not scoped by session). This is deliberate: the new-session view has no `sessionId` subscription, so a session-scoped relay (like `file_ready`) wouldn't reach it. Same pattern as `create_project_result`.

---

#### command_output

A "local" slash command (e.g. `/goal`, `/usage`, `/status`) renders output only in CC's terminal and never writes to the `.jsonl`. After the bridge sends one (a bare `/cmd`, no args — args would trigger the AI and flow through the `.jsonl` instead), it grabs the terminal output via `tmux capture-pane -e -p` and pushes it here.

```json
{
  "action": "command_output",
  "sessionId": "a1ca0870-xxxx",
  "requestId": "...",
  "ansi": "[1m  ✔ Goal achieved[0m\n  ..."
}
```

**Fields**:
| Field | Description |
|-------|-------------|
| `sessionId` | Scopes the relay to subscribers of this session |
| `ansi` | The captured terminal body, **ANSI colour codes preserved** (the app renders them with the same anser path as tool output). Empty string `""` when the capture found nothing meaningful — the app just stops its spinner. |

**Bridge handling** (`captureCommandOutput`): poll the pane every 800 ms (≤25 s, since `/context`/`/stats` are slow). While `esc to interrupt` is present CC is busy (local calc or AI) → keep waiting. Once idle and the screen is identical across two reads → slice the body between the last `❯ /cmd` prompt and the surrounding dividers, keeping ANSI. If the screen is a full-screen dialog (`Esc to cancel/dismiss/close/clear` footer), **send `Escape`** afterwards so the input box is freed for the next message.

**Server handling**: `_handle_bridge_relay` — forward to app connections subscribed to `sessionId`.

---

### Server → Bridge (Push)

#### messages_ack

Server acknowledges receipt and processing of bridge messages, allowing bridge to advance its synced pointer.

```json
{ "action": "messages_ack", "sessionId": "a1ca0870-xxxx" }
```

**Bridge handling**: `wsSendWithAck` waits for this message (5s timeout). Received → resolve(true), bridge advances line number. Timeout → resolve(false), bridge falls back to HTTP POST to DDB.

---

#### sync_session

Server notifies bridge to sync a specific session's messages to DDB (triggered by GET /messages returning needSync).

```json
{ "action": "sync_session", "sessionId": "a1ca0870-xxxx" }
```

**Bridge handling**:
1. Find the corresponding .jsonl file by sessionId
2. Read and extract messages → POST /sync-messages to write DDB
3. On completion, send `sync_complete` via WS

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
  "title": "...",
  "description": "...",
  "options": [...]
}
```

---

#### send_message_result

Server forwards bridge send result (broadcast to **all** app connections under this account).

```json
{ "action": "send_message_result", "ok": true, "sessionId": "new-session-id (only for new sessions)", "requestId": "req_abc123" }
```

---

#### create_project_result

Server forwards bridge create-project result (broadcast to **all** app connections under this account).

```json
{ "action": "create_project_result", "ok": true, "sessionId": "new-session-id", "projectPath": "workspace/my-new-project" }
```

---

#### sync_complete

Notifies app that a session's historical messages have been synced to DDB, app can re-fetch GET /messages.

```json
{ "action": "sync_complete", "sessionId": "a1ca0870-xxxx" }
```

---

#### file_ready

Server forwards bridge's file-ready notification (only pushed to app connections subscribed to this sessionId). Same payload as the Bridge → Server `file_ready` above. The app matches it by `requestId`, then fetches the content (`GET /file/{key}` for text → highlight.js, or `GET /image/{key}` for images → image viewer).

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

Server forwards the bridge's slash-command list (broadcast to **all** app connections under this account). Same payload as the Bridge → Server `commands_list` above. The app **splits the reply by `source`** and caches it in `localStorage` in two buckets: global commands (`user`/`plugin`/`builtin`) under `apeek_cmds:g:<deviceName>` (shared by every project on that device, stored once) and project commands (`source: "project"`) under `apeek_cmds:p:<projectHash>`. The `/`-autocomplete popup shows the **union** of the two (deduped, sorted). This way a brand-new project directory immediately gets all global commands from the device cache without waiting for its own scan.

```json
{
  "action": "commands_list",
  "requestId": "cmds_1717300000000",
  "commands": [{ "name": "commit", "source": "user" }]
}
```

---

#### command_output

Server forwards a local slash command's captured terminal output to app connections subscribed to the session. Same payload as the Bridge → Server `command_output`. The app renders `ansi` (ANSI colours preserved) as a `.cmd-output` terminal block and stops the send spinner; empty `ansi` just clears the spinner. These are live-only — not persisted, so they don't reappear on reload.

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
| BridgeSessions | accountId | deviceName#projectHash#sessionId | Session metadata | 90 days |
| BridgeMessages | sessionId | timestamp#uuid | Message cache (uuid/type/content/timestamp only) | 30 days |
| Connections | connectionId | — | WS connection records (includes role, deviceName?) | 24h |
| Subscriptions | sessionId | connectionId | WS subscription relationships | 24h |

---

## Known Limitations & Design Notes

### DDB message field loss

DDB only stores `uuid`, `type`, `content`, `timestamp` (four fields). The following fields are only passed via WS real-time path, not in DDB/REST:
- `stopReason` — after page refresh, cannot determine wsRunning from messages; degrades to session-level `status`
- `toolUseResult` — Agent sub-task statistics are lost after refresh
- `parentUuid` — message parent-child relationships

### Connections table scan

Forwarding `send_message` / `permission_reply` / `interrupt` to bridge scans DDB by `accountId + role` (Connections table has no GSI). Current connection volume is small, no impact — at scale would need GSI on accountId. `_handle_disconnect` cleanup of Subscriptions is also a scan (PK=sessionId cannot reverse-lookup by connectionId).

### send_message_result broadcast scope

`send_message_result` uses `_handle_bridge_broadcast` to broadcast to **all** app connections under the account, not just the requester. When multiple devices/tabs are open, all apps receive the new session's `sessionId`. Frontend handles this via `appState.session === '__new__'` check — no functional impact.

### device routing strips `device` before forwarding

`_handle_send_to_bridge` rebuilds the payload with a dict comprehension (`{k: v for k, v in body.items() if k != "device"}`) rather than mutating the request body, then forwards only to bridge connections whose `deviceName` matches. Applies to `send_message` / `permission_reply` / `interrupt` / `create_project` / `request_file` / `list_commands`.

### Image & file endpoints have no account isolation

`GET /api/bridge/image/{key}` and `GET /api/bridge/file/{key}` do not verify accountId — any valid API key can access any image/file. Relies on the key being a hash value that is not guessable. `POST /upload-image` / `POST /upload-file` similarly do not associate with an account.
