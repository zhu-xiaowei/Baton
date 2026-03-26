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
- **File change** → 100ms debounce per session (dedup `fs.watch` duplicate events) → read new lines → extract → POST to DDB
  - New session detected (`synced` has no entry) → immediately sync session metadata to DDB + add to `recentSessions`
  - Resumed historical session (not in `recentSessions`) → immediately sync session metadata + add to `recentSessions`
  - Phase 2: also WS push for real-time
- **Periodic sync (60s)** → only sync `recentSessions` (24h active) metadata to DDB, NOT full scan
  - Refreshes `isRunning`, `preview`, `lastActive` for recent sessions
  - Startup does full sync; periodic sync is incremental
- **Active detection** → `pgrep -f claude` + cwd matching, re-checked every 60s

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
{"uuid":"a7x","type":"assistant","content":[{"type":"text","text":"..."}],"timestamp":"..."}
```

Content block processing:
- `image` → compress 720p JPEG (sharp) → upload S3 → `{ type: "image", key: "hash.jpg" }`
- `tool_result` > 2KB → truncate to 500 chars
- `text` → keep as-is

### Auto-start
- macOS: launchd plist (`~/Library/LaunchAgents/`)
- Linux: systemd user service (`~/.config/systemd/user/`)

## DynamoDB

```
BridgeSessions
  PK: accountId (SHA256(apiKey)[:16])
  SK: deviceName#projectHash#sessionId
  Attributes: deviceName, projectHash, projectName, sessionId,
              lastActive, preview, model, isRunning, size, os
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
  sessions: [{ id, project, projectName, lastActive, size, preview, isRunning }]
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
→ { devices: [{ deviceName, os, lastActive, isOnline }] }

GET /api/bridge/projects?device=MacBook-Pro
→ { projects: [{ projectHash, projectName, lastActive, sessionCount, activeCount }] }

GET /api/bridge/sessions?device=MacBook-Pro&project=-Users-...
→ { sessions: [{ sessionId, preview, lastActive, createdAt, isRunning }] }

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

### Send message (Phase 3)

```
App → Server → Bridge:  { action: "send_message", sessionId: "abc", text: "..." }
Bridge executes (tmux send-keys / kill + Agent SDK resume)
Response flows back as normal messages through DDB + WS
```

## Entering a Session — Complete Flow

```
App taps session "abc":

1. Establish WS subscribe + start buffering (don't display)
   WS: { action: "subscribe", sessionId: "abc" }

2. REST load from DDB (parallel with step 1)
   GET /api/bridge/messages?session=abc&after=<last-local-uuid>
   → DDB has cached messages → return instantly (<100ms)
   → DDB empty → return empty (bridge hasn't synced this session yet)

3. Render REST result immediately

4. Merge WS buffer: filter messages with timestamp > last REST message's timestamp
   Append to rendered list. (UUID dedup as fallback for same-millisecond edge case)

5. Initialization complete. Subsequent WS messages → append directly, no dedup needed.

6. App leaves session:
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
│   └── bridge.mjs                         # File watcher + HTTP POST + WS
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
└── docs/claude-code-bridge.md
```

## Phases

### Phase 1: Bridge → DDB ✅ Complete
- bridge.mjs watches .jsonl, syncs session metadata + messages to DDB
- New/resumed sessions detected instantly via fs.watch (no 60s delay)
- 100ms debounce per session to dedup fs.watch duplicate events
- Periodic sync (60s) only covers recent 24h sessions, not full scan
- Deployed to us-west-2 (AgentPeekTest), verified

### Phase 2A: Backend + 接口验证

目标：所有后端接口可用，本地测试页面验证通过。

#### Step 1: Server REST read endpoints
- [ ] `bridge_read.py`: GET devices, projects, sessions, messages (from DDB)
- [ ] Register in main.py, redeploy
- [ ] Verify: curl all 4 endpoints return correct data

#### Step 2: WebSocket API Gateway
- [ ] CloudFormation: WebSocket API GW + Lambda handler + DDB connections table
- [ ] `bridge_ws.py`: $connect/$disconnect (DDB connections table), $default (route by action)
- [ ] Verify: wscat connect, DDB shows connection record

#### Step 3: Bridge WS connection + real-time push
- [ ] bridge.mjs: add WS connection to server (alongside existing HTTP POST)
- [ ] bridge.mjs: on file change → HTTP POST to DDB + WS push (parallel)
- [ ] Verify: wscat subscribe → bridge detects file change → wscat receives message

#### Step 4: Server WS relay
- [ ] bridge_ws.py: subscribe → record in DDB subscriptions table
- [ ] bridge_ws.py: bridge WS message → lookup subscribers → post_to_connection to all apps
- [ ] Verify: two wscat clients subscribe same session → both receive messages

#### Step 5: 本地测试页面 (test.html)
- [ ] `test/test.html`: 单文件，浏览器直接打开，无需构建
- [ ] 配置区：输入 server URL + API key
- [ ] REST 验证：devices → projects → sessions 级联选择，messages 加载显示
- [ ] WS 验证：subscribe session → 实时显示新消息（raw JSON）
- [ ] 状态指示：连接状态、消息计数、延迟
- [ ] 验证：打开页面 → 选择 session → 在 Claude Code 中发消息 → 页面实时显示

### Phase 2B: Mobile App

目标：React Native app 完整实现。

#### Step 6: Mobile app init
- [ ] `npx react-native init` in mobile/
- [ ] Install deps, App.tsx, theme, ConfigStorage
- [ ] Verify: app launches

#### Step 7: Mobile session list
- [ ] SettingsScreen: manual server + key input
- [ ] BridgeService.ts: REST client
- [ ] SessionListScreen: device → project → session (🟢/⚫ indicators)
- [ ] Verify: app shows real session list from DDB

#### Step 8: Mobile chat
- [ ] BridgeService.ts: WS client (subscribe/unsubscribe/heartbeat)
- [ ] useClaudeCode.ts: WS buffer → REST load → merge → render → real-time append
- [ ] ChatScreen: message list + spinner
- [ ] MessageBubble + MarkdownRenderer
- [ ] MMKV message cache + lastUuid
- [ ] Verify: open session → history loads → Claude real-time output appears on phone

### Phase 3: Send messages from phone
- Bridge: tmux send-keys / kill + Agent SDK resume
- Same WS + DDB channels

### Phase 4: Production polish
- Setup page + QR code, one-line install with auto-start
- Push notifications, Claude Code markdown, code diff display
- Persist bridge sync state (~/.claude-bridge/sync-state.json) to avoid re-uploading messages on restart
