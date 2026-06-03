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
│              │              │ (real-time push)      │           │              │
└──────────────┘              └───────────────────────┘           └──────────────┘
```

**Key principles:**
- **DDB**: session metadata (bridge REST) + message cache (Lambda writes on WS receive)
- **WS**: bridge → Lambda → app push + DDB write in parallel (bridge only needs one WS connection)
- **Data minimization**: bridge extracts only uuid, type, content, timestamp (~40-60% smaller)
- **Multi-device**: server broadcasts to all subscribed app connections

## Bridge

### Startup
1. Scan `~/.claude/projects/` → collect ALL session metadata (preview from `ai-title`)
2. `POST /api/bridge/sync-sessions` → full upload to DDB (only on startup)
3. Build `recentSessions` set (sessions active in last 24h) for periodic sync
4. Initial message sync: active session per project (latest only) + recent 24h sessions → extract + upload to DDB
   - Active: for each running project, only the most recent session (the one being used)
   - Recent: sessions with mtime within 24h
   - Sessions synced in parallel (sliding window, concurrency=4)
   - Images: compressed to 1280px JPEG (quality=90) via sharp → uploaded to S3 via Lambda
   - Messages batched by byte size (≤4MB per POST)
   - Line-number tracking: only reads new lines, no UUID set in memory
5. Start `fs.watch` on all `.jsonl` files (no age filter)

### Runtime (always-on, auto-start on boot)
- **File change** → fs.watch triggers → immediately read new lines → extract → WS push to server
  - Per-session busy flag prevents concurrent reads (pending events replayed after)
  - Partial JSON lines (mid-write) → break, synced not advanced, next event re-reads
  - Trailing empty string from `split('\n')` removed to prevent synced pointer drift
  - WS ack: `wsSendWithAck` waits for server `messages_ack` (5s timeout), only advances synced line on ack
  - WS fallback: ack timeout or WS disconnected → HTTP POST to DDB
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
  - Interrupt detection: `[Request interrupted by user*]` → idle, `tool_result(is_error=true)` only → idle
  - terminal/tmux CC: `--resume` flag → exact session match → precise status
  - VS Code CC: no `--resume` → project-level detection + file mtime heuristic (mtime > 5min → stopped regardless of content)
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
- `image` → compress 1280px JPEG quality=90 (sharp) → upload S3 → `{ type: "image", key: "hash.jpg" }`
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

GET /api/bridge/messages?session=abc&after=<timestamp>
→ { messages: [{ uuid, type, content, timestamp }] }
```

## WebSocket Protocol

Three participants: App, Server (relay), Bridge. All on persistent WS connections.

### Real-time message push

```
Bridge detects new message in .jsonl:
  1. Bridge → WS → API GW → Lambda
  2. Lambda in parallel:
     a. Query Subscriptions → post_to_connection → App (priority, latency-sensitive)
     b. Write DDB BridgeMessages (fallback cache, non-blocking)
  Bridge maintains one WS connection, no longer writes DDB directly via HTTP POST.
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
Existing session:
App → Server → Bridge:  { action: "send_message", sessionId: "abc", text: "...", device: "MacBook-Pro" }
Bridge: findTmuxTarget(sessionId) → sendKeys
  or: no target → auto tmux new-session + claude --resume → waitForCCReady → sendKeys

New session:
App → Server → Bridge:  { action: "send_message", projectHash: "xxx", text: "...", device: "MacBook-Pro", requestId: "..." }
Bridge: create tmux + claude → waitForCCReady → sendKeys → poll .jsonl → return sessionId
Bridge → Server → App:  { action: "send_message_result", ok: true, sessionId: "new-uuid", requestId: "..." }
App subscribes to new sessionId, starts receiving messages

(send_message also accepts asAgent:true → launch via `claude agents`)
```

#### `sendKeys` injection (how text reaches Claude)

`sendKeys` injects a message into the tmux pane in three steps:

1. `send-keys C-u` — clear any partial input (reliable for Ink, unlike Escape which eats the first pasted char)
2. `load-buffer` + `paste-buffer -p` — atomic paste, no size limit, CJK-safe. **`-p` (bracketed paste)** keeps newlines literal, so a multiline message stays one message instead of each `\n` being treated as a submit (which would split it into several sends).
3. `send-keys C-m` — submit. **Must be `C-m`, not `Enter`**: Claude's Ink TUI swallows a plain `Enter` issued right after a bracketed paste (this is why `-p` was removed in commit ceb84e6 back when submit used `Enter`). `C-m` submits reliably.

History: `-p` was added (4aa7eb0), removed because `-p`+`Enter` dropped the submit (ceb84e6), then re-added together with the `Enter`→`C-m` switch. The receive-side `\r`→`\n` normalization in `extract.mjs` (commit 41dc032) is now a no-op under `-p` but kept as a harmless fallback. Verified 30/30 on EC2 (CC v2.1.159): single/multiline, long text, CJK, special chars, markdown image. If Claude's Ink behavior changes, re-verify before editing. Same approach in `sendTypeInput` (AskUserQuestion "Type something" input).

### Create project

```
App → Server → Bridge:  { action: "create_project", projectPath: "workspace/x", device: "MacBook-Pro", asAgent?: bool }
Bridge: mkdir -p → derive projectHash → launch session → return result
Bridge → Server → App:  { action: "create_project_result", ok: true, sessionId: "new-uuid", projectPath: "workspace/x" }
```

### View a project file (click-to-sync)

```
App → Server → Bridge:  { action: "request_file", path: "bridge/ws.mjs", sessionId: "abc",
                          projectHash: "xxx", device: "MacBook-Pro", requestId: "..." }
Bridge: resolve path (relative → projectHashToPath), stat, dedup by key (LRU 1000), then by type:
  text  → read ≤5MB (truncate + drop partial last line) → POST /upload-file  (S3 files/{key})
  image → ≤10MB whole file (else "image too large")     → POST /upload-image (S3 images/{key})
Bridge → Server → App:  { action: "file_ready", requestId: "...", sessionId: "abc",
                          key: "<sha>.ext", path: "/abs/path", size: N, truncated: false, image: false }
App: text  → GET /api/bridge/file/{key}  → detectLang(path) → highlight.js file viewer
     image → GET /api/bridge/image/{key} → reuse the image overlay (viewImage)
     (content travels via REST/S3, never over WS — avoids the 128KB frame limit)
```

### Slash commands (autocomplete)

Mirrors Claude Code's `/`-menu: typing `/` at the start of the input lists all
available slash commands (names only, like CC); continuing to type (`/as`) filters
by prefix; ↑↓ navigates, Enter/Tab/click selects and **sends immediately**
(`/name\n` via the normal send path).

```
App → Server → Bridge:  { action: "list_commands", projectHash: "xxx", device: "MacBook-Pro", requestId: "cmds_..." }
Bridge: scanSlashCommands(projectHashToPath(projectHash)) — live read, no cache/watch (~15ms):
  user    → ~/.claude/commands/**/*.md  +  ~/.claude/skills/*/SKILL.md
  project → <projectDir>/.claude/commands/**/*.md  +  /skills/*/SKILL.md
  plugin  → settings.json enabledPlugins → resolve each plugin root → /commands + /skills
            (root resolution: installed_plugins.json installPath → extraKnownMarketplaces
             path → plugins/marketplaces/<mkt>/plugins/<name> → .../<name>)
  builtin → BUILTIN_COMMANDS static list (bundled skills + builtin slash commands
            compiled into CC, no file on disk). Mirrors EXACTLY the running CC's
            "/" menu beyond disk-scannable commands (no padding, no hidden cmds) —
            re-sync on CC upgrades. e.g. batch clear compact context debug
            deep-research goal init loop run review verify usage update-config…
  name = command file basename (sans .md, no file read); subdirs → ':' namespace.
         skill name from SKILL.md frontmatter `name` (fallback dir name).
  dedup by name (user>project>plugin>builtin — user recap.md beats bundled recap),
  then sort all names alphabetically (localeCompare — char-by-char). Names only.
Bridge → Server → App:  { action: "commands_list", requestId: "cmds_...", commands: [{name, source}] }
  (~2.5KB for ~75 commands; server broadcasts to ALL app connections for the account —
   like create_project_result — so it reaches the new-session view too, which has no
   sessionId subscription)
App: split reply by source → cache global (user/plugin/builtin) once per DEVICE
     (apeek_cmds:g:<device>) + project cmds per PROJECT (apeek_cmds:p:<projectHash>).
     Typing "/" shows the UNION (deduped, sorted). Prefetched on session open
     (startWs / WS onopen) → cache shows instantly, WS refresh updates it. A brand-new
     project dir gets all global commands from the device cache with no per-project wait.
```

### Local slash commands (terminal-only output)

Some builtin commands (status/config/usage/stats/goal/compact/context/heapdump/
reload-skills) run client-side in CC and render output ONLY in the terminal —
nothing reaches the .jsonl. After sending a bare such command, the bridge
captures the terminal output and pushes it so the app can show it. (`/clear` is
NOT included — it spawns a fresh empty session each time; users use the "+"
new-session button for a clean context instead.)

```
App → … → Bridge:  send_message text="/usage"  (handled like any send)
Bridge: sendKeys → then maybeCaptureLocalCommand():
  bare "/cmd" (no args) AND cmd ∈ LOCAL_COMMANDS?   (args → triggers AI → .jsonl)
   → captureCommandOutput(): poll `tmux capture-pane -e -p` every 800ms (≤25s):
       "esc to interrupt" present → CC busy (local calc or AI), keep waiting
       idle + screen stable across 2 reads → slice body (❯/cmd → dividers), keep ANSI
       if full-screen dialog ("Esc to cancel/dismiss/close/clear") → send Escape
         afterwards so the input box is freed (else next message is swallowed)
Bridge → Server → App:  { action: "command_output", sessionId, requestId, ansi }
  (relayed to session subscribers; empty ansi → app just stops the spinner)
App: render ansi as a .cmd-output terminal block (anser → coloured HTML), live-only
     (not persisted, won't reappear on reload). NOTE: full-screen dialogs taller than
     the pane (Settings/Config) are truncated — we capture the visible screen only.
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
│   ├── bridge.mjs          # Entry point — startup, orchestration
│   ├── config.mjs          # CLI args, config loading, server config fetch
│   ├── http.mjs            # HTTP POST helper
│   ├── extract.mjs         # Message extraction, image compression, DDB upload
│   ├── session.mjs         # Preview, model, project name, session status detection
│   ├── permissions.mjs     # Permission prompt detection via tmux capture-pane
│   ├── tmux.mjs            # tmux target discovery, sendKeys, auto-launch
│   ├── sync.mjs            # Initial + periodic session sync
│   ├── watcher.mjs         # fs.watch → read → WS push
│   └── ws.mjs              # WebSocket client, auto-reconnect, sync_session handler
├── server/
│   ├── src/
│   │   ├── main.py         # FastAPI entry
│   │   ├── bridge_sync.py  # POST sync-sessions, sync-messages, upload-image, upload-file
│   │   ├── bridge_read.py  # GET devices/projects/sessions/messages/image/file
│   │   └── bridge_ws.py    # WS relay ($connect/$disconnect/$default)
│   ├── template/AgentPeek.template
│   └── install.sh          # One-command deploy (ECR → S3 → CodeBuild → CloudFormation)
├── web/
│   ├── landing.html        # API key auth page
│   ├── index.html          # Session viewer (auth guard)
│   ├── setup.html          # Bridge install + QR code + device list
│   ├── css/style.css       # Dark theme styles
│   └── js/
│       ├── entry-index.js  # Entry point for index.html
│       ├── entry-landing.js # Entry point for landing.html
│       ├── entry-setup.js  # Entry point for setup.html
│       ├── globals.js      # Shared constants and utilities
│       ├── state.js        # App state management
│       ├── api.js          # REST client + auth (localStorage)
│       ├── ws.js           # WebSocket client
│       ├── app.js          # Navigation, session lifecycle
│       ├── render.js       # Message orchestrator, timeline layout
│       ├── scroll-indicator.js # Scroll-to-bottom indicator
│       └── components/
│           ├── markdown.js     # Markdown rendering (marked.js + highlight.js)
│           ├── message.js      # User/system bubbles, file badges, document blocks
│           ├── tool.js         # Tool nodes (Bash, Edit, Agent stats/timer, etc.)
│           ├── image.js        # Image lazy-loading, upload, gallery
│           ├── fileviewer.js   # Click-to-sync project file viewer (highlight.js)
│           ├── permission.js   # Permission prompt UI (options, input, escape)
│           ├── skeleton.js     # Loading skeleton placeholders
│           └── typing-status.js # Typing/thinking status indicator
├── src-tauri/
│   ├── tauri.conf.json     # Tauri v2 config (frontendDist: "../web")
│   ├── Cargo.toml          # Rust dependencies
│   ├── src/                # Rust backend (minimal, mostly native API bridges)
│   ├── capabilities/       # Permission capabilities for plugins
│   ├── icons/              # App icons (all platforms)
│   └── gen/                # Generated platform projects (android/, apple/)
├── scripts/
│   ├── release-ios.sh      # Build + bump CFBundleVersion + upload TestFlight
│   └── release-mac.sh      # macOS DMG build with code signing + notarization
├── docs/
│   ├── api.md              # Full API specification
│   ├── claude-code-bridge.md  # This file
│   ├── frontend-patterns.md   # Frontend rendering patterns
│   └── assets/             # Images (promo.avif, etc.)
├── package.json            # Root package (Vite + Tauri CLI)
└── vite.config.js          # Vite config for web/ bundling
```

## Phases

### Phase 1: Bridge → DDB ✅ Complete
- bridge.mjs watches .jsonl, syncs session metadata + messages to DDB
- New/resumed sessions detected instantly via fs.watch
- fs.watch → immediate read → WS push (no debounce, no polling)
- Periodic check (1min) only detects disappeared CC processes
- Deployed to ap-northeast-1 (AgentPeekTest), verified

### Phase 2A: Backend + API Validation ✅ Complete

- Server REST read endpoints (devices, projects, sessions, messages)
- WebSocket API Gateway + relay (subscribe, broadcast, heartbeat)
- Bridge WS connection + real-time push
- Web viewer (web/) with dark theme, diff2html, markdown, file badges, Agent stats

### Phase 2B: Send Messages + Images ✅ Complete

- tmux send-keys (cross-platform, zero-intrusion approach)
- Server WS relay: send_message, permission_reply, interrupt
- Bridge: findTmuxTarget → sendKeys, auto-launch tmux + claude --resume
- Viewer: message sending + optimistic rendering + dedup, permission prompt + user interaction, image sending via S3
- WS reconnect recovery: track wsLastTimestamp → recoverMissing() on reconnect
- Auto-create tmux session when no existing target + device routing
- Permission detection: client-side tool_use scanning + server-side capture-pane

### Phase 2C: Native App (Tauri v2) ✅ Complete

Tauri v2 wraps the web/ static frontend as a native app — zero web code changes.

- `src-tauri/` at project root (sibling to web/, bridge/, server/)
- `frontendDist: "../web"` — directly serves static HTML/CSS/JS
- `withGlobalTauri: true` — JS accesses native APIs via `window.__TAURI__`
- Bundle identifier: `com.agentpeek.app`

**Targets:**
- Android: APK via `npm run build:android`
- iOS: IPA via `npm run build:ios`, TestFlight via `npm run release:ios`
- macOS: DMG via `npm run build:mac` (code signed + notarized)

**Native plugins:**
- QR code login: `tauri-plugin-barcode-scanner`
- Local notifications: `tauri-plugin-notification` (planned)
- Biometric auth: `tauri-plugin-biometric` (planned)

### Phase 3: Production Polish (Future)
- Windows support: bridge process detection, Task Scheduler auto-start, %APPDATA% paths
- Push notifications
- Persist bridge sync state (~/.claude-bridge/sync-state.json) to avoid re-uploading messages on restart
- DDB TTL: auto-clean messages for sessions inactive > 30 days
