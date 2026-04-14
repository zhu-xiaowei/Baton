# AgentPeek — Project Context

## Workflow Rules

- **先方案后代码**: 所有代码改动必须先给出详细方案（改哪些文件、改什么、为什么），用户明确确认后才能修改代码。未经确认不得动代码。

## What is this

AgentPeek is a mobile app + bridge + server that lets you view and interact with Claude Code sessions from your phone. Three components:

1. **bridge/** — Node.js script running on Mac/Linux (always-on, auto-start), watches Claude Code's `.jsonl` session files
2. **server/** — AWS Lambda (FastAPI) + DynamoDB + WebSocket API GW, relays between bridge and app
3. **mobile/** — React Native app (NOT YET CREATED), displays sessions and messages

Brand name "AgentPeek" is only in user-facing places. Internal code uses generic names so renaming is easy.

## Core Design Principle

**Messages never touch DynamoDB.** They flow through WebSocket only:
- DDB: session metadata only (device/project/session lists for browsing)
- WS: all message content (history load + real-time)
- App MMKV: local message cache

## Current Status

### Phase 1: COMPLETE ✅
- bridge.mjs syncs session metadata to DDB via HTTP POST
- bridge.mjs watches .jsonl files, detects new messages in real-time
- Deployed to us-west-2 (AgentPeekTest), verified 300+ sessions

### Phase 2A: NEXT — Backend + 接口验证
- Server: bridge_read.py (REST read), bridge_ws.py (WS relay), WebSocket API GW
- Bridge: add WS connection, file change → DDB + WS push in parallel
- web/: 静态页面（landing/viewer/setup），验证 REST + WS 全链路

### Phase 2B: Mobile App
- Fresh RN project, SessionList (REST) → Chat (WS), MMKV cache

### Phase 3: LATER — Send messages from phone
### Phase 4: LATER — Production polish
- Persist bridge sync state to disk, avoid re-uploading messages on restart

## Deployed Test Environment

- **Region**: us-west-2
- **Stack**: AgentPeekTest
- **API URL**: https://d08cs70rb3.execute-api.us-west-2.amazonaws.com/v1
- **API Key**: 9LS7hlOlvG4MMUYFsz3avkF7u7flnsv80CwpjD3h
- **DDB Tables**: AgentPeekTest-bridge-sessions, AgentPeekTest-bridge-messages
- **S3 Bucket**: agentpeektest-images-949580910056
- **ECR**: 949580910056.dkr.ecr.us-west-2.amazonaws.com/agentpeek-api:latest
- **Deploy**: `cd server && ./install.sh --region us-west-2 --stack AgentPeekTest`

## Key Technical Decisions

### Bridge
- Watches `~/.claude/projects/<project-hash>/<session-id>.jsonl`
- `readableProjectName()` resolves hash back to real path by walking filesystem
- `preview` uses `ai-title` from .jsonl, falls back to first user message
- Filters: skips empty/no-preview files, subagent sessions
- Session `status`: three-state (`running`/`idle`/`stopped`), determined by:
  - `getRunningInfo()`: `ps aux` + `--resume` arg extraction → exact session ID + project cwd
  - `getSessionStatus()`: reads jsonl tail `stop_reason` (`end_turn` → idle, `tool_use`/null → running, `user` last → running)
  - Process detection: `ps aux | grep claude` (not `pgrep`, which fails from Node.js on macOS)
  - terminal/tmux CC: `--resume` flag → exact session match → precise status
  - VS Code CC: no `--resume` → project-level detection + file mtime heuristic (< 5min → jsonl analysis, > 5min → stopped)
- `findTmuxTargetForSession`: 精确匹配 CC 进程 args 中的 sessionId → 找到 tmux pane
- `projectHashToPath()`: 从 hash 反解真实目录路径（逐段验证目录存在）
- Auto-launch: 无 tmux target 时自动创建 tmux + `claude --resume` + `waitForCCReady`
- Config: `~/.claude-bridge/config.json`, auto-created from CLI args
- Always-on: launchd (macOS) / systemd user service + `loginctl enable-linger` (Linux)
- Initial sync: full session metadata + messages for running/idle + recent 24h sessions, parallel (concurrency=4)
- Periodic check (5min): `checkStopped()` — only detects disappeared CC processes via `ps aux`
- Watcher: fs.watch detects jsonl changes → sync metadata only on status change, new session, or ai-title
- Status cache: `lastKnownStatus` Map prevents redundant sync POSTs (only sends on change)
- Debounce: busy Map per session dedup fs.watch duplicate events
- Line-number tracking per session (not UUID set), lightweight
- Images: sharp compress 720p JPEG → upload S3 via Lambda → store key in message
- Batching: by byte size (≤4MB/POST), with 200ms delay between batches

### Server
- FastAPI in Docker Lambda, API Key auth
- DDB `accountId` = SHA256(apiKey)[:16] — raw key never stored
- `install.sh`: ECR → S3 → CodeBuild (arm64) → CloudFormation

### Message Flow (WS single path + DDB cache)
- Bridge detects new message → WS push to server (单一链路，不直接写 DDB)
- Lambda 收到消息 → 并行: post_to_connection 推 app (优先) + 写 DDB (缓存)
- Bridge extracts: uuid, parentUuid, type, content, timestamp, toolUseResult (drops model/usage/cwd/version, ~40-60% smaller)
- Content blocks preserved: text, image (compressed), document, thinking, tool_use, tool_result
- App opens session → REST from DDB (instant, <100ms) + WS subscribe for real-time
- WS buffer during REST load → merge by timestamp → render → subsequent WS direct append
- Server broadcasts to ALL app connections subscribed to a sessionId (multi-device)
- See `docs/claude-code-bridge.md` for full protocol and flow diagrams

## DynamoDB Schema

```
BridgeSessions
  PK: accountId (SHA256(apiKey)[:16])
  SK: deviceName#projectHash#sessionId
  Attributes: deviceName, projectHash, projectName, sessionId, lastActive, preview, model, status (running/idle/stopped), size, os

BridgeMessages
  PK: sessionId    SK: timestamp#uuid
  Attributes: uuid, type, content (JSON), timestamp
  TTL: 30 days
```

## API Summary

### REST
```
POST /api/bridge/sync-sessions              — bridge uploads session metadata
POST /api/bridge/sync-messages              — bridge 启动时批量同步（运行时改走 WS）
GET  /api/bridge/devices                    — device list (含 online 字段，查 connections 表)
GET  /api/bridge/projects?device=X          — project list
GET  /api/bridge/sessions?device=X&project=Y — session list
GET  /api/bridge/messages?session=X&after=ts — messages (incremental, ts=ISO timestamp)
```

### WebSocket (real-time)
```
App → Server:           { action: "subscribe", sessionId }
App → Server:           { action: "unsubscribe", sessionId }
App → Server → Bridge:  { action: "send_message", sessionId, text, device }
                        { action: "send_message", projectHash, text, device }  — new session
App → Server → Bridge:  { action: "permission_reply", sessionId, approved, device }
Bridge → Server → App:  { action: "send_message_result", ok, sessionId? }
Server → App:           { action: "messages", sessionId, messages }
```

Full protocol: `docs/api.md`

## Phase 2A: COMPLETE ✅

- Server REST read endpoints (devices, projects, sessions, messages)
- WebSocket API Gateway + relay (subscribe, broadcast, heartbeat)
- Bridge WS connection + real-time push
- Web viewer (web/) with dark theme, diff2html, markdown, file badges, Agent stats

## Phase 2B: COMPLETE ✅ — Send Messages + Images

方案: tmux send-keys（全平台通用，零侵入）

### 消息发送
- Viewer → WS → Server → Bridge → tmux send-keys → CC
- 乐观渲染 + 去重 + 时间戳更新

### 权限确认 + 用户交互
- Viewer 从 tool_use 检测 AskUserQuestion / ExitPlanMode / Bash / Edit / Write
- AskUserQuestion / ExitPlanMode: 立即弹窗（CC 在等用户回答）
- Bash / Edit / Write: 5 秒等待 tool_result，到了则标记 auto，没到则标记 manual 并弹窗
- 模式缓存在内存（不存 localStorage），刷新页面重新检测
- tool_result 到达时无条件关闭弹窗
- 选项卡片 UI（arrow:N, type:N:text, escape）
- 实时 tool_result (OUT) 追加（tool-grid 结构 + collapsible 折叠）

### 图片发送
- S3 上传 + ![](claude-bridge:key) 协议
- Bridge 下载 → 替换绝对路径 → CC Read tool 读取
- 多图 staging + gallery + 粘贴支持

### UI
- CC 内部 XML 标签过滤，空 Read 输出隐藏
- 刷新页面保持导航状态

## Phase 2B-next: COMPLETE ✅ — Auto-create tmux + Device Routing

### 自动创建 tmux session
- 已有 session 无 CC 运行 → Bridge 自动 `tmux new-session` + `claude --resume <id>` + 等 ready + sendKeys
- New Session: Viewer "+ New Session" 按钮 → `send_message` 带 projectHash → Bridge 创建 tmux + claude → poll .jsonl 获取 sessionId → 返回给 Viewer subscribe
- Trust dialog 自动确认（检测 "Yes, I trust this folder" → Enter）
- tmux 命名: resume `apeek_{project}_{sessionId前8位}`, new `apeek_{project}_{MMDDHHmmss}`
- 旧 session 清理: 创建新 tmux 时异步清理 >1 天无活动的 `apeek_*` sessions
- 重复 session name: 创建前 kill 同名 session

### Device 路由
- Bridge WS 连接带 `device` 参数
- Server 存 `deviceName`，转发 send_message/permission_reply 时按 device 过滤
- Viewer 发消息带 `device: appState.device`

### macOS / Linux 验证 ✅
- Linux: `fs.readlinkSync('/proc/{pid}/cwd')` 替代 `lsof`（ESM 兼容）
- tmux 进程匹配: 精确匹配 args 中的 sessionId

## Web Deployment: COMPLETE ✅ — Static Files + Auth + Setup

### Web Pages (served from FastAPI Lambda)
- `web/landing.html` — API key input, URL `?key=` auto-login, localStorage (`_ak` btoa obfuscated)
- `web/index.html` — Session viewer (auth guard redirects to landing if no key)
- `web/setup.html` — Bridge install command + QR code + connected devices list
- Top bar: AgentPeek logo + Setup / Logout links

### Auth Flow
- Key stored in localStorage (`_ak` = btoa, `_as` = server URL)
- No cookies, no server middleware — static files publicly accessible
- API calls use `x-api-key` header from localStorage
- API Gateway `ApiKeyRequired: false` — auth handled by FastAPI layer

### Deployment
- Dockerfile: `COPY web/ web/` → FastAPI `StaticFiles` mount
- `install.sh`: copies `web/` to Docker build context, deploys via CodeBuild
- Deploy output: single setup URL with embedded key

### Three-State Session Status
- `running`: CC process alive + jsonl `stop_reason: "tool_use"` or `null`
- `idle`: CC process alive + jsonl `stop_reason: "end_turn"` or `last-prompt`
- `stopped`: no CC process for this session
- Badge colors: running (green), idle (yellow), stopped (gray)
- Device/Project lists show `runningCount` + `idleCount`

## Phase 2C: Mobile App

所有接口已在 test viewer 验证，mobile 只需接 UI。

### Step 10-12: Init + Session List + Chat + Send
- [ ] RN 项目初始化，导航，theme，MMKV
- [ ] Session 列表 (REST) + Chat 页面 (WS 实时 + 发送)
- [ ] MessageBubble + MarkdownRenderer

### SwiftChat markdown reference
`/Users/xiaoweii/workspace/rn/swift-chat/react-native/src/core/markdown/`
Key files: Parser.tsx, Markdown.tsx, CustomMarkdownRenderer.tsx, CustomCodeHighlighter.tsx

## Future: tmux capture-pane 实时状态（未实现）

CC 有大量中间状态不写 jsonl，只在终端显示。`tmux capture-pane -p` 是唯一获取途径：

- **思考动画**: Pondering... / Vibing... / Computing... 等临时状态文本
- **thinking 过程**: 推理内容实时展示
- **权限等待**: 精确检测 CC 是否在等用户确认（区分 "在跑长命令" vs "在等审批"）
- **进度信息**: tool 执行中的输出

### 权限检测方案
当前 viewer 用 5 秒定时器启发式判断是否弹权限弹窗，存在误判（auto-approve 的长命令也会弹）。
更优方案：bridge 检测到 tool_use 后等几秒 → capture-pane 一次 → 看到权限提示则推 `permission_needed` 给 viewer。
性能：capture-pane 读一屏文本 ~5ms，仅在 tool_use 时触发，开销可忽略。

### 实现方向
作为 "tmux live state" 模块统一设计，bridge 定期或按需 capture-pane，解析 CC 终端状态，通过 WS 推送给 viewer。

## Known Issues / TODO

- **WS 128KB 帧限制**: API Gateway WS payload 上限 128KB。超大消息（如 Edit 大文件）WS 发送失败，bridge 自动 fallback 到 HTTP 写 DDB，但 app 实时收不到（刷新后可见）。DDB 单条 item 上限 400KB，超过会丢失。极少触发，暂不处理。
- **VS Code CC 状态精度**: VS Code 扩展启动 CC 无 `--resume` flag，无法精确匹配 session。使用 mtime 启发式（2 分钟），空闲超时后显示 stopped 而非 idle。terminal/tmux 启动的 CC 不受影响。
