# Claude Code Bridge — Technical Design

## Overview

**AgentPeek** — view and interact with Claude Code sessions from your phone. No wrapping of `claude` command.

## Architecture

```
Mac/Linux/EC2                       AWS (Serverless)                    AgentPeek App
┌──────────────┐              ┌───────────────────────┐           ┌──────────────┐
│ Claude Code  │              │ REST API GW + Lambda  │           │              │
│ (unchanged)  │              │ (FastAPI in Docker)   │           │ Device/      │
│   ↓ writes   │              │                       │           │ Project/     │
│ .jsonl files │  HTTP POST   │ DynamoDB              │   REST    │ Session list │
│   ↓ watches  ├─────────────→│ - Session metadata    │←──────────┤              │
│ bridge       │              │ - Message cache       │           │ Chat view    │
│              │              │                       │           │ (markdown)   │
│              │◄────── WS ──►│ WebSocket API GW      │◄── WS ──►│              │
│              │              │ (real-time push)      │           │ MMKV cache   │
└──────────────┘              └───────────────────────┘           └──────────────┘
```

**Key principles:**
- **DDB**: session metadata (bridge REST) + message cache (Lambda writes on WS receive)
- **WS**: bridge → Lambda → app 推送 + DDB 写入并行（bridge 只需一个 WS 连接）
- **App MMKV**: local cache (fast re-open, offline viewing)
- **Data minimization**: bridge extracts only uuid, type, content, timestamp (~40-60% smaller)
- **Multi-device**: server broadcasts to all subscribed app connections
- **Better than Happy**: Happy uses notify+pull (3 round trips), we use DDB+direct push (1 round trip)

## Bridge

### Startup
1. Scan `~/.claude/projects/` → collect ALL session metadata (preview from `ai-title`)
2. `POST /api/bridge/sync-sessions` → full upload to DDB (only on startup)
3. Build `recentSessions` set (sessions active in last 24h) for periodic sync
4. Initial message sync: active session per project (latest only) + recent 24h sessions → extract + upload to DDB
   - Active: for each running project, only the most recent session (the one being used)
   - Recent: sessions with mtime within 24h
   - Sessions synced in parallel (sliding window, concurrency=4)
   - Images: compressed to 720p JPEG via sharp → uploaded to S3 via Lambda
   - Messages batched by byte size (≤4MB per POST)
   - Line-number tracking: only reads new lines, no UUID set in memory
5. Start `fs.watch` on all `.jsonl` files (no age filter)

### Runtime (always-on, auto-start on boot)
- **File change** → fs.watch triggers → immediately read new lines → extract → WS push to server
  - Per-session busy flag prevents concurrent reads (pending events replayed after)
  - Partial JSON lines (mid-write) → break, synced not advanced, next event re-reads
  - Trailing empty string from `split('\n')` removed to prevent synced pointer drift
  - WS fallback: if WS not connected, HTTP POST to DDB
  - Metadata sync only on: status change, new session, or ai-title arrived (via `lastKnownStatus` cache)
- **Periodic check (1min)** → `checkStopped()` detects disappeared CC processes via `ps aux`
  - Only checks sessions previously known as running/idle
  - Updates status to stopped if process gone
- **Status detection** → three-layer architecture:
  - `statusFromEntry(entry)`: pure function, entry → running/idle/null. Shared by watcher + file reader
  - `getSessionStatus()`: reads last lines of jsonl via reverse `\n` scan + process detection. Used by syncSessions/checkStopped
  - Watcher: uses `statusFromEntry()` directly on already-parsed data (no file re-read)
  - `getRunningInfo()`: `ps aux` + `--resume` arg extraction → exact session ID + project cwd
  - stop_reason mapping: `end_turn`/`max_tokens`/`stop_sequence` → idle, `tool_use`/`null` → running, `user` last → running
  - terminal/tmux CC: `--resume` flag → exact session match → precise status
  - VS Code CC: no `--resume` → project-level detection + file mtime heuristic (content=running → keep, content=idle + mtime > 2min → stopped)
- **isMeta filtering** → VS Code `--replay-user-messages` creates duplicate user entries with `isMeta=true`
  - Skip `isMeta` user messages (avoid duplicate user input)
  - Keep their assistant replies (contain real CC output: first text paragraph, thinking blocks)
- **WS connection** → auto-discover WS URL from `GET /api/bridge/config`, auto-reconnect on disconnect

### Data extraction

Raw .jsonl (~2KB per message):
```json
{"type":"assistant","uuid":"a7x","parentUuid":"p1","isSidechain":false,
 "cwd":"/Users/user/project","message":{"model":"claude-sonnet-4-5","id":"msg_xxx",
 "role":"assistant","content":[{"type":"text","text":"..."}],"stop_reason":"end_turn",
 "usage":{"input_tokens":5000,"output_tokens":2000}},"timestamp":"...","version":"2.1.81"}
```

Extracted (~0.8KB):
```json
{"uuid":"a7x","parentUuid":"p1","type":"assistant","content":[{"type":"text","text":"..."}],"timestamp":"..."}
```

Content block processing:
- `image` → compress 720p JPEG (sharp) → upload S3 → `{ type: "image", key: "hash.jpg" }`
- `document` → pass through as-is (`{ type: "document", source: { type: "text", data: "..." }, title: "file.txt" }`)
- `tool_result` with `toolUseResult` → extract Agent metadata (`totalToolUseCount`, `totalDurationMs`, etc.)
- `text` → keep as-is
- `thinking`, `tool_use`, `tool_result` → keep as-is

### Auto-start
- macOS: launchd plist (`~/Library/LaunchAgents/`)
- Linux: systemd user service (`~/.config/systemd/user/`)

## DynamoDB

```
BridgeSessions
  PK: accountId (SHA256(apiKey)[:16])
  SK: deviceName#projectHash#sessionId
  Attributes: deviceName, projectHash, projectName, sessionId,
              lastActive, preview, model, status (running/idle/stopped), size, os
  TTL: 90 days

BridgeMessages
  PK: sessionId
  SK: timestamp#uuid (e.g. "2026-03-27T10:30:00.000Z#msg_abc123")
  Attributes: uuid, type, content (JSON), timestamp
  TTL: 30 days
```

## REST API

All require `x-api-key` header.

### Bridge → Server

```
POST /api/bridge/sync-sessions
Body: {
  deviceName: "MacBook-Pro", os: "darwin",
  sessions: [{ id, project, projectName, lastActive, size, preview, status }]
}

POST /api/bridge/sync-messages
Body: {
  sessionId: "abc123",
  messages: [{ uuid, type, content, timestamp }]
}
```

### App → Server

```
GET /api/bridge/devices
→ { devices: [{ deviceName, os, lastActive, projectCount, sessionCount, runningCount, idleCount }] }

GET /api/bridge/projects?device=MacBook-Pro
→ { projects: [{ projectHash, projectName, lastActive, sessionCount, runningCount, idleCount }] }

GET /api/bridge/sessions?device=MacBook-Pro&project=-Users-...
→ { sessions: [{ sessionId, preview, lastActive, size, model, status }] }

GET /api/bridge/messages?session=abc&after=<uuid>
→ { messages: [{ uuid, type, content, timestamp }] }
```

## WebSocket Protocol

Three participants: App, Server (relay), Bridge. All on persistent WS connections.

### Real-time message push

```
Bridge detects new message in .jsonl:
  1. Bridge → WS → API GW → Lambda
  2. Lambda 并行:
     a. 查 Subscriptions → post_to_connection → App (优先，延迟敏感)
     b. 写 DDB BridgeMessages (兜底缓存，不阻塞推送)
  Bridge 只维护一个 WS 连接，不再直接 HTTP POST 写 DDB。
```

### App subscribe/unsubscribe

```
App → Server:  { action: "subscribe", sessionId: "abc" }
App → Server:  { action: "unsubscribe", sessionId: "abc" }
Server → App:  { action: "messages", sessionId: "abc", messages: [...] }
```

### Heartbeat

```
App → Server:  { action: "heartbeat" }
Bridge → Server:  { action: "heartbeat" }
(every 5 minutes)
```

### Send message

```
已有 session:
App → Server → Bridge:  { action: "send_message", sessionId: "abc", text: "...", device: "MacBook-Pro" }
Bridge: findTmuxTarget(sessionId) → sendKeys
  或: 无 target → 自动 tmux new-session + claude --resume → waitForCCReady → sendKeys

新建 session:
App → Server → Bridge:  { action: "send_message", projectHash: "xxx", text: "...", device: "MacBook-Pro" }
Bridge: 创建 tmux + claude → waitForCCReady → sendKeys → poll .jsonl → 返回 sessionId
Bridge → Server → App:  { action: "send_message_result", ok: true, sessionId: "new-uuid" }
App subscribes to new sessionId, starts receiving messages
```

## Entering a Session — Complete Flow

```
App taps session "abc":

1. _wsBuffer = [] → start buffering WS messages
   WS: { action: "subscribe", sessionId: "abc" }

2. bufferAndFetch(sessionId, '') → REST load from DDB
   GET /api/bridge/messages?session=abc
   → DDB has cached messages → return instantly (<100ms)
   → DDB empty → return empty (bridge hasn't synced this session yet)

3. Merge: DDB results + _wsBuffer, dedup by uuid, sort by timestamp

4. _wsBuffer = null → switch to real-time mode. Render merged result.
   Track wsLastTimestamp for reconnect recovery.

5. Subsequent WS messages → append directly via updateLastTurn().

6. WS reconnect → subscribe + recoverMissing():
   _wsBuffer = [] → bufferAndFetch(sessionId, wsLastTimestamp)
   Same buffer+fetch+merge pattern, dedup + sort + full re-render.

7. App leaves session:
   WS: { action: "unsubscribe", sessionId: "abc" }
   Save to MMKV: messages + lastUuid
```

### Why DDB + WS is better than WS-only

| Scenario | WS only | DDB cache + WS |
|---|---|---|
| Open session (bridge syncing for 30min) | Wait for bridge to read & transmit file | **DDB has 30min of cached msgs, instant** |
| Switch phone / clear cache | Bridge retransmits everything | **DDB instant** |
| Bridge temporarily offline | Can't load anything | **DDB has cached history** |
| Real-time new messages | WS push ~100ms | **WS push ~100ms (same)** |

## Code Structure

```
agentpeek/
├── bridge/
│   ├── bridge.mjs                         # Entry point — startup, orchestration
│   ├── config.mjs                         # CLI args, config loading, server config fetch
│   ├── http.mjs                           # HTTP POST helper
│   ├── extract.mjs                        # Message extraction, image compression, DDB upload
│   ├── session.mjs                        # Preview, model, project name, session status detection
│   ├── sync.mjs                           # Initial + periodic session sync
│   ├── watcher.mjs                        # fs.watch → read → WS push
│   └── ws.mjs                             # WebSocket client, auto-reconnect, sync_session handler
├── server/
│   ├── src/
│   │   ├── main.py                        # FastAPI entry
│   │   ├── bridge_sync.py                 # POST sync-sessions, sync-messages
│   │   ├── bridge_read.py                 # GET devices/projects/sessions/messages
│   │   └── bridge_ws.py                   # WS relay
│   ├── template/AgentPeek.template
│   └── install.sh
├── mobile/                                # Fresh RN project
│   └── src/
│       ├── App.tsx
│       ├── screens/
│       │   ├── SessionListScreen.tsx      # REST from DDB
│       │   ├── ChatScreen.tsx             # REST history + WS real-time
│       │   └── SettingsScreen.tsx
│       ├── service/BridgeService.ts       # REST + WS client
│       ├── hooks/useClaudeCode.ts
│       ├── components/
│       │   ├── MessageBubble.tsx
│       │   └── MarkdownRenderer.tsx
│       ├── storage/ConfigStorage.ts       # MMKV: config + message cache
│       └── theme/index.ts
├── web/
│   ├── landing.html                       # API key auth page
│   ├── index.html                         # Session viewer (auth guard)
│   ├── setup.html                         # Bridge install + QR code + device list
│   ├── css/style.css                      # Dark theme styles
│   └── js/
│       ├── components/markdown.js         # Markdown rendering (marked.js)
│       ├── components/message.js          # User/system bubbles, file badges, document blocks
│       ├── components/tool.js             # Tool nodes (Bash, Edit, Agent stats/timer, etc.)
│       ├── render.js                      # Message orchestrator, timeline layout
│       ├── api.js                         # REST client + auth (localStorage)
│       ├── ws.js                          # WebSocket client
│       └── app.js                         # App state, navigation
└── docs/claude-code-bridge.md
```

## Phases

### Phase 1: Bridge → DDB ✅ Complete
- bridge.mjs watches .jsonl, syncs session metadata + messages to DDB
- New/resumed sessions detected instantly via fs.watch
- fs.watch → immediate read → WS push (no debounce, no polling)
- Periodic check (1min) only detects disappeared CC processes
- Deployed to us-west-2 (AgentPeekTest), verified

### Phase 2A: Backend + 接口验证

目标：所有后端接口可用，本地测试页面验证通过。

#### Step 1: Server REST read endpoints ✅
- [x] `bridge_read.py`: GET devices, projects, sessions, messages (from DDB)
- [x] Register in main.py, redeploy
- [x] Verify: curl all 4 endpoints return correct data

#### Step 2: WebSocket API Gateway ✅
- [x] CloudFormation: WebSocket API GW + Lambda handler + DDB connections table
- [x] `bridge_ws.py`: $connect/$disconnect (DDB connections table), $default (route by action)
- [x] Verify: wscat connect, DDB shows connection record

#### Step 3: Bridge WS connection + real-time push ✅
- [x] bridge.mjs: add WS connection to server (alongside existing HTTP POST)
- [x] bridge.mjs: on file change → WS push to server (primary), HTTP POST fallback
- [x] Verify: wscat subscribe → bridge detects file change → wscat receives message

#### Step 4: Server WS relay ✅
- [x] bridge_ws.py: subscribe → record in DDB subscriptions table
- [x] bridge_ws.py: bridge WS message → lookup subscribers → post_to_connection to all apps
- [x] Verify: two wscat clients subscribe same session → both receive messages

#### Step 5: Web viewer (web/) ✅
- [x] Modular JS: markdown, message, tool, render, api, ws, app
- [x] Dark theme with collapsible diffs, syntax highlighting, diff2html
- [x] User message: file badges (document blocks), ide_opened_file extraction, image thumbnails
- [x] Agent tool: stats display (tool calls, duration), running timer
- [x] REST: devices → projects → sessions drill-down, messages load
- [x] WS: subscribe session → real-time message rendering
- [x] Status: connection indicator, message count

### Phase 2B: Send messages + Viewer polish ✅

链路：`Viewer → WS → Server → WS → Bridge → tmux send-keys → Claude Code → JSONL → Bridge → WS → Viewer`

- [x] tmux send-keys 方案（全平台通用，零侵入）
- [x] Server WS relay: send_message, permission_reply
- [x] Bridge: findTmuxTarget → sendKeys, auto-launch tmux + claude --resume
- [x] Viewer: 消息发送 + 乐观渲染 + 去重, 权限确认 + 用户交互, 图片发送 via S3
- [x] WS reconnect recovery: track wsLastTimestamp → recoverMissing() on reconnect
- [x] Unified expand/collapse: .clamp-btn (always visible, mobile-friendly), post-render overflow detection
- [x] WS tool_result: reuse renderToolNode() (same as history, no separate code path)
- [x] ai-title: real-time breadcrumb update (WS + REST history)
- [x] Diff view fix: normalize trailing newlines for correct diff output
- [x] CC internal tag filtering: system-reminder, task-notification, etc.
- [x] Setup page: URL key auto-strip via history.replaceState

### Phase 2C: Mobile App

目标：React Native app 完整实现。此时所有接口已在 test viewer 中验证通过，mobile 只需接 UI。

#### Step 10: Mobile app init
- [ ] `npx react-native init` in mobile/
- [ ] Install deps, App.tsx, theme, ConfigStorage
- [ ] Verify: app launches

#### Step 11: Mobile session list
- [ ] SettingsScreen: manual server + key input
- [ ] BridgeService.ts: REST client
- [ ] SessionListScreen: device → project → session (🟢/⚫ indicators)
- [ ] Verify: app shows real session list from DDB

#### Step 12: Mobile chat + send
- [ ] BridgeService.ts: WS client (subscribe/unsubscribe/heartbeat/send_message)
- [ ] useClaudeCode.ts: WS buffer → REST load → merge → render → real-time append
- [ ] ChatScreen: message list + input + send
- [ ] MessageBubble + MarkdownRenderer
- [ ] MMKV message cache + lastUuid
- [ ] Verify: open session → history loads → send message → Claude responds → phone 实时显示

### Phase 3: Production polish
- Windows support: bridge process detection, Task Scheduler auto-start, %APPDATA% paths
- ~~Setup page + QR code, one-line install with auto-start~~ ✅ (web/setup.html)
- Push notifications
- Persist bridge sync state (~/.claude-bridge/sync-state.json) to avoid re-uploading messages on restart
- DDB TTL: auto-clean messages for sessions inactive > 30 days
