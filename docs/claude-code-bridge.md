# Claude Code Bridge — Technical Design

## Overview

**AgentPeek** — view and interact with Claude Code sessions from your phone. No wrapping of `claude` command.

This document covers the Claude Code runtime. The shared runtime model and current Codex
integration status are documented in [codex.md](codex.md); the wire contract is in
[api.md](api.md).

## Architecture

```
Mac/Linux/Windows                   AWS (Serverless)                    AgentPeek App
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
The current startup coordinator discovers all registered runtime adapters, merges their catalogs,
and computes Device/Project aggregates once. The steps below describe the Claude-specific part.

1. Scan `~/.claude/projects/` → collect ALL session metadata (preview from `ai-title`)
2. `POST /api/bridge/sync-sessions` → full upload to DDB (only on startup)
3. Build `recentSessions` set (sessions active in last 24h) for periodic sync
4. Initial message sync: active session per project (latest only) + recent 24h sessions → extract + upload to DDB
   - Active: for each running project, only the most recent session (the one being used)
   - Recent: sessions with mtime within 24h
   - Sessions synced in parallel (sliding window, shared concurrency=2)
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
  - terminal CC (launched with `--resume`): exact session match → precise status
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
- Windows: Task Scheduler runs `bridge-launcher.mjs`

## DynamoDB

```
BridgeSessions
  PK: accountId (SHA256(apiKey)[:16])
  SK: DEV#deviceName
      PROJ#deviceName#projectHash
      SESS#deviceName#projectHash#sessionId
  Attributes: deviceName, projectHash, projectName, sessionId,
              lastActive, preview, model, status (running/needs_input/completed),
              runtime, nativeSessionId, size, os
  TTL: no value written

BridgeMessages
  PK: sessionId
  SK: timestamp#uuid (e.g. "2026-03-27T10:30:00.000Z#msg_abc123")
  Attributes: uuid, type, content (JSON), timestamp
  TTL: 90 days
```

### Worktree project-hash normalization (one session = one row)

The session row's SK is `SESS#deviceName#projectHash#sessionId`, so a session's
identity in DDB is `(projectHash, sessionId)` — **not sessionId alone**. That
breaks when a session moves between project dirs.

When a Claude session `cd`s into a **git worktree** (e.g. an agent working under
`<project>/.claude/worktrees/<name>`), CC re-homes that session's `.jsonl`:
it *moves* the file (same inode, birth time preserved — verified, not a copy)
from the parent project dir to a new project dir whose hash is
`<parentHash>--claude-worktrees-<name>`. There is still only **one** jsonl and
**one** sessionId.

The bridge derives `projectHash` from the file's directory
(`path.basename(path.dirname(...))`), so after the move it starts POSTing under
the new worktree hash while the old parent-project row is left frozen (the
bridge never deletes rows). Result, before the fix:

- The same sessionId has **two** rows (two SKs) → the app shows two cards for
  one session; opening either shows identical messages (messages are keyed by
  sessionId over WS, so both cards read the same jsonl).
- The worktree project often never appears in the project list, because the
  agent poll (`pushAgentMeta`) writes the `SESS#` row but not the `PROJ#`
  aggregate the projects list reads.

**Fix — `normalizeProjectHash(hash)` (`session.mjs`)**: strips the
`--claude-worktrees-*` suffix, collapsing a worktree hash back to its parent.
It is applied **only to the projectHash POSTed to the server** — every write
site: full sync (`syncSessions`), `watcher.postSessionMeta`,
`watcher.pushAgentMeta`, `updateSessionStatus`, and `checkStopped`. On-disk
reads (`findSessionFile`, `getPreview`, `projectHashToPath`, the `_projectDirs`
cache) keep the **real** worktree hash, so the jsonl is still read from the
worktree dir.

Net effect: a session that enters a worktree keeps the same SK (parent hash),
stays a single row under the parent project, and its worktree is treated as an
implementation detail rather than a separate project. Pre-existing duplicate
`--claude-worktrees-*` rows from before the fix are stale and must be deleted
once (they no longer receive updates).

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
→ { devices: [{ deviceName, os, lastActive, projectCount, sessionCount, runningCount, needsInputCount, runtimeCapabilities }] }

GET /api/bridge/projects?device=MacBook-Pro
→ { projects: [{ projectHash, projectName, lastActive, sessionCount, runningCount, needsInputCount }] }

GET /api/bridge/sessions?device=MacBook-Pro&project=-Users-...
→ { sessions: [{ sessionId, nativeSessionId, runtime, preview, lastActive, size, model, status }] }

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
     b. Write DDB BridgeMessages, then ack; write failure falls back to Bridge HTTP upload
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
Bridge: _pool.send(sessionId) → headless `claude -p --resume <id>` over kept-open stdin (spawns if none)
        → stream_delta/stream_end (preview) + authoritative `messages` rows

New session (TODO): projectHash-only send → headless spawn without --resume, sessionId from system/init.

(send_message also accepts asAgent:true → the new session runs as a Claude Agents background session)
```

#### How text reaches Claude (headless stdin)

The bridge writes one JSON line per message to the session's headless process stdin:
`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<msg>"}]}}`. Single-writer per session (one pooled process) → no jsonl double-write. Output is parsed line-by-line: `content_block_delta` → `stream_delta` preview, full `assistant`/`user` rows → authoritative `messages` (uuid-deduped against the jsonl copy), `result` → `stream_end`. See `docs/headless-streaming.md`.

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
  video → ≤5GB; ack file_progress, then POST /video-prepare (HEAD dedup) →
          stream file to presigned PUT URL, direct to S3 (never through Lambda) (S3 videos/{key})
Bridge → Server → App:  { action: "file_ready", requestId: "...", sessionId: "abc",
                          key: "<sha>.ext", path: "/abs/path", size: N, truncated: false, image: false }
App: text  → GET /api/bridge/file/{key}  → detectLang(path) → highlight.js file viewer
     image → GET /api/bridge/image/{key} → reuse the image overlay (viewImage)
     video → GET /api/bridge/video-url/{key} (presigned, no-store, ~50min app cache) → <video> streams from S3
     (text/image content travels via REST/S3, never over WS — avoids the ~31KB frame budget;
      video bytes stream browser↔S3 directly, bypassing the Lambda 6MB payload limit)
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

### Local slash commands

The tmux `command_output` path was removed. Under headless every `/cmd` is sent as ordinary text;
supported commands return through normal stream/JSONL messages, while Claude itself reports commands
that are unavailable in headless mode. `/compact` can also surface through its
`<local-command-stdout>` JSONL row.

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
│   ├── runtime-adapter.mjs # Shared runtime read contract
│   ├── runtime-registry.mjs # Claude/Codex adapter registry
│   ├── claude-runtime.mjs  # Claude runtime adapter
│   ├── codex-runtime.mjs   # Codex read/status runtime adapter
│   ├── codex-session.mjs   # Codex rollout discovery
│   ├── codex-extract.mjs   # Codex event normalization
│   ├── session.mjs         # Preview, model, project name, session status detection
│   ├── headless.mjs        # ClaudePool — persistent `claude -p` stream-json process per session
│   ├── commands.mjs        # Slash-command scan (user/project/plugin/builtin)
│   ├── sync.mjs            # Initial + periodic session sync
│   ├── watcher.mjs         # fs.watch → read → WS push
│   └── ws.mjs              # WebSocket client, send/permission/interrupt, sync_session handler
├── server/
│   ├── src/
│   │   ├── main.py         # FastAPI entry
│   │   ├── bridge_sync.py  # POST sync-sessions, sync-messages, upload-image, upload-file, video-prepare
│   │   ├── bridge_read.py  # GET devices/projects/sessions/messages/image/file/video-url
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
│   ├── codex.md            # Codex design, implementation status, and validation
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

> ⚠️ Originally tmux send-keys; **superseded by Phase 2E (headless stream-json pool)**. tmux is deleted. The image/reconnect/device pieces still stand.

- Server WS relay: send_message, permission_reply, interrupt
- Bridge: `_pool.send` → headless `claude -p --resume` (was tmux findTarget/sendKeys/auto-launch)
- Viewer: message sending + optimistic rendering + dedup, permission prompt + user interaction, image sending via S3
- WS reconnect recovery: track wsLastTimestamp → recoverMissing() on reconnect
- Device routing
- Permission: bridge relays CC's `control_request` → app prompt → `permission_reply` (was client-side scan + capture-pane)

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
- Improve native Windows process/status precision
- Push notifications
- Harden the existing persisted `~/.claude-bridge/synced.json` recovery path
- Continue monitoring the existing 90-day message-cache TTL
