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
  - New session detected → immediately sync session metadata to DDB + add to `recentSessions`
- **Periodic sync (60s)** → only sync `recentSessions` (24h active) metadata to DDB, NOT full scan
  - Refreshes `isRunning`, `preview`, `lastActive` for recent sessions
  - Startup does full sync; periodic sync is incremental
- **Active detection** → `pgrep -f claude` + cwd matching, re-checked every 60s
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
│   ├── bridge.mjs                         # Entry point — startup, orchestration
│   ├── config.mjs                         # CLI args, config loading, server config fetch
│   ├── http.mjs                           # HTTP POST helper
│   ├── extract.mjs                        # Message extraction, image compression, DDB upload
│   ├── session.mjs                        # Preview, model, project name, isRunning detection
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
├── test/
│   ├── index.html                         # Test viewer — browser app, no build step
│   ├── css/style.css                      # Dark theme styles
│   └── js/
│       ├── components/markdown.js         # Markdown rendering (marked.js)
│       ├── components/message.js          # User/system bubbles, file badges, document blocks
│       ├── components/tool.js             # Tool nodes (Bash, Edit, Agent stats/timer, etc.)
│       ├── render.js                      # Message orchestrator, timeline layout
│       ├── api.js                         # REST client
│       ├── ws.js                          # WebSocket client
│       └── app.js                         # App state, navigation
└── docs/claude-code-bridge.md
```

## Phases

### Phase 1: Bridge → DDB ✅ Complete
- bridge.mjs watches .jsonl, syncs session metadata + messages to DDB
- New/resumed sessions detected instantly via fs.watch
- fs.watch → immediate read → WS push (no debounce, no polling)
- Periodic sync (60s) only covers recent 24h sessions, not full scan
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

#### Step 5: Test viewer (test/) ✅
- [x] Modular JS: markdown, message, tool, render, api, ws, app
- [x] Dark theme with collapsible diffs, syntax highlighting, diff2html
- [x] User message: file badges (document blocks), ide_opened_file extraction, image thumbnails
- [x] Agent tool: stats display (tool calls, duration), running timer
- [x] REST: devices → projects → sessions drill-down, messages load
- [x] WS: subscribe session → real-time message rendering
- [x] Status: connection indicator, message count

### Phase 2B: Send messages — Test Viewer 先行验证

目标：在 test viewer 中实现消息发送，跑通完整双向链路，为 mobile 铺路。

链路：`Test Viewer → WS → Server → WS → Bridge → Claude Code → JSONL → Bridge → WS → Viewer`

#### Step 6: 调研 Claude Code 输入机制
- [ ] 调研 Claude Code 接收外部输入的方式（stdin pipe / tmux send-keys / Agent SDK / VS Code extension API）
- [ ] 确定最佳方案，考虑 CLI 和 VS Code 两种运行模式
- [ ] 验证: 手动测试选定方案能否向 Claude Code 发送消息

#### Step 7: Server WS relay — send_message
- [ ] `bridge_ws.py`: 处理 `send_message` action，app → server → bridge 转发
- [ ] 部署并验证: wscat 模拟 app 发送，bridge 端收到

#### Step 8: Bridge — 接收并执行 send_message
- [ ] bridge: 收到 `send_message`，找到对应 session 的 Claude Code 进程
- [ ] bridge: 通过选定方案注入消息
- [ ] 验证: 从 wscat 发送消息 → Claude Code 收到并响应 → 响应通过 WS 推回

#### Step 9: Test Viewer — 发送 UI
- [ ] 消息输入框 + 发送按钮（chat 页面底部）
- [ ] WS 发送 `{ action: "send_message", sessionId, text }`
- [ ] 发送后清空输入框，等待响应（已有 WS 实时推送链路）
- [ ] 验证: 在浏览器输入消息 → Claude Code 响应 → 浏览器实时显示

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
- Setup page + QR code, one-line install with auto-start
- Push notifications
- Persist bridge sync state (~/.claude-bridge/sync-state.json) to avoid re-uploading messages on restart
- DDB TTL: auto-clean messages for sessions inactive > 30 days
