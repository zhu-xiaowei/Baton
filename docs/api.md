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

**Response** `200`: JPEG binary, `Content-Type: image/jpeg`

**Notes**: App loads images via this endpoint to avoid exposing S3 directly

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
{ "action": "send_message", "projectHash": "-Users-xxx-workspace-project", "text": "hello", "device": "MacBook-Pro" }
```

**Server handling**: Forward to matching bridge by `device`. Bridge handling:
1. Has sessionId → find corresponding tmux pane → sendKeys
2. Has sessionId but no tmux target → auto-create tmux + `claude --resume` → wait ready → sendKeys
3. No sessionId, has projectHash → create tmux + `claude` → wait ready → sendKeys → poll .jsonl for new sessionId

**Return**: Bridge sends `send_message_result` (with sessionId) → Server broadcasts to all app connections.

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
{ "action": "send_message_result", "ok": true, "sessionId": "new-session-id (only for new sessions)" }
```

**Server handling**: `_handle_bridge_broadcast` — broadcast to **all** app connections under this accountId (not limited to subscribers).

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
{ "action": "send_message_result", "ok": true, "sessionId": "new-session-id (only for new sessions)" }
```

---

#### sync_complete

Notifies app that a session's historical messages have been synced to DDB, app can re-fetch GET /messages.

```json
{ "action": "sync_complete", "sessionId": "a1ca0870-xxxx" }
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

### body.pop("device") in-place mutation

`_handle_send_to_bridge` uses `body.pop("device")` to mutate the passed dict, stripping device before forwarding to bridge. All current callers (send_message / permission_reply / interrupt) return immediately after the call and don't reuse body, so no actual bug. But note if body is reused in the future.

### Image endpoint has no account isolation

`GET /api/bridge/image/{key}` does not verify accountId — any valid API key can access any image. Relies on the key being a hash value that is not guessable. `POST /upload-image` similarly does not associate with an account.
