# Claude Code Bridge — Technical Design

## Overview

**Baton** — view and interact with Claude Code sessions from your phone. No wrapping of `claude` command.

This document covers the Claude Code runtime. The shared runtime model and current Codex
integration status are documented in [codex.md](codex.md); the wire contract is in
[api.md](api.md).

## Architecture

```
Mac/Linux/Windows                   AWS (Serverless)                    Baton App
┌──────────────┐              ┌───────────────────────┐           ┌──────────────┐
│ Claude Code  │              │ REST API GW + Lambda  │   REST    │ Device list, │
│ (unchanged)  │  REST (S3    │ (devices, auth,       │←──────────┤ attachments  │
│   ↓ writes   ├─ uploads) ──→│  attachments)         │           │              │
│ .jsonl files │              │                       │           │ Home/Project/│
│   ↓ watches  │◄─ control ──►│ WebSocket API GW      │           │ Session list │
│ bridge       │◄─ direct ───►│ data API (direct RPC  │◄─ direct ─►│ Chat view    │
│              │   channel    │  + pushes, no Lambda) │  channel  │              │
└──────────────┘              └───────────────────────┘           └──────────────┘
```

**Key principles:**
- **Local JSONL is the only source**: the Bridge answers lists, history, threads and tool details
  over the direct channel; the server stores no Session data
- **Pushes**: real-time rows go from the Bridge straight to the subscribed App connections, best effort
- **Data minimization**: bridge extracts only uuid, type, content, timestamp (~40-60% smaller)

## Bridge

### Startup
The current startup coordinator discovers all registered runtime adapters, merges their catalogs,
and computes Device/Project aggregates once. The steps below describe the Claude-specific part.

1. Scan `~/.claude/projects/` → collect ALL session metadata. Preview order:
   `custom-title` → `ai-title` → `summary` → first prompt → `last-prompt`;
   `~/.claude/history.jsonl` preserves the original first prompt, including slash commands.
   This is Baton's rule, not CC's: the CC resume list prefers `last-prompt` over the first
   prompt (verified in 2.1.316), but Baton names a Session by its first prompt. The open-Session
   title (`web/js/ws.js` `updateTitleFromMessages`) uses the same order.
2. `reportSessions()` (`sync.mjs`) fills the local status cache (`lastKnownStatus`) and the
   notifier (`notify.mjs`); nothing is sent to the server
3. Set every Session's line cursor to the end of its file (in memory only); the watcher pushes
   only what is written from then on, and history is read from the files on demand
4. Start `fs.watch` on all `.jsonl` files (no age filter)

### Runtime (always-on, auto-start on boot)
- **File change** → fs.watch triggers → immediately read new lines → extract → push to the
  Session's subscribers (dropped when nobody is subscribed)
  - Per-session busy flag prevents concurrent reads (pending events replayed after)
  - Partial JSON lines (mid-write) → break, synced not advanced, next event re-reads
  - Trailing empty string from `split('\n')` removed to prevent synced pointer drift
  - Session rows are reported (`reportSessions`) only on status change, new session, or ai-title arrived (via `lastKnownStatus` cache)
- **Periodic check** → `checkStopped()` runs once after the session index warms up, then every
  10 min (`CHECK_STOPPED_INTERVAL`)
  - Candidates: running/needs_input entries in `lastKnownStatus`, matched to session-index roots
  - Updates status to completed if the process is gone
- **Status detection** → process, daemon, pool, and JSONL sources:
  - `statusFromEntry(entry)`: pure function, entry → running/needs_input/completed/null
  - `getSessionStatus()`: reads last lines of jsonl via reverse `\n` scan + process detection. Used by syncSessions/checkStopped
  - Watcher: uses `statusFromEntry()` directly on already-parsed data (no file re-read)
  - `getRunningInfo()`: `ps aux` + `--resume` arg extraction → exact session ID + project cwd
  - stop_reason mapping: `end_turn`/`max_tokens`/`stop_sequence` → completed, `tool_use`/`null` → running
  - structured `AskUserQuestion`/`ExitPlanMode` tool use → needs_input
  - Interrupt detection: `[Request interrupted by user*]` and error-only tool results → completed
  - Busy pool-owned status overrides daemon and JSONL; roster-active daemon status overrides external process/JSONL
  - terminal CC (launched with `--resume`): exact session match → precise status
  - VS Code CC: no `--resume` → project-level detection + file mtime heuristic (mtime > 5min → completed)
- **isMeta filtering** → VS Code `--replay-user-messages` creates duplicate user entries with `isMeta=true`
  - Skip `isMeta` user messages (avoid duplicate user input)
  - Keep their assistant replies (contain real CC output: first text paragraph, thinking blocks)
- **WS connection** → `wsUrl` from `~/.baton-bridge/config.json` (written by the install script; `--ws` for manual runs; missing → exit asking to reinstall), auto-reconnect on disconnect

### Bridge connection recovery

Healthy sockets are reused. The same Node.js timers handle normal operation and
resume on macOS, Windows, and Linux; there is no extra sleep/network listener.
The system DNS resolver is unchanged.

- Protocol Ping: every 20 seconds, one outstanding probe, five-second Pong
  timeout. It does not renew database records or check updates. Silent failure
  detection takes up to about 25 seconds plus reconnect time, not a hard SLA.
- Business heartbeat: every four minutes, ten-second timeout, independent of
  Pong. Both probes run immediately on connection; only the business reply
  confirms backend responsiveness.
- Reconnect: first retry immediate, subsequent retries every five seconds,
  five-second handshake deadline. Configuration discovery has a three-second
  timeout, retries every five seconds, and caches the URL for the same server.
- Shutdown clears timers; old sockets and late Pongs cannot affect a replacement.
  Duplicate connect calls reuse the current attempt. Queued messages still flush.
- Version checks run on startup/reconnect or a heartbeat version mismatch, at
  most once per four minutes, without a dedicated timer. Version requests have a
  ten-second timeout. Updates can restart Bridge and interrupt active terminals.
- The instance lock reserves a loopback port (20000–39999) derived from the
  canonical Bridge directory. The kernel releases it on exit or crash; port
  conflicts fail closed. PID metadata also protects an older running Bridge:
  it is never killed automatically, and cleanup only removes the owner's PID.
- Installers preserve `bridgeId`; the server atomically assigns one owner per
  account/device, retires old connections, and rejects stale handshakes/messages.
  Replaced Bridges stop retrying. Routing follows the owner despite index lag.
- Online status is a recent control-connection lease, not a delivery guarantee.
  The four-minute heartbeat has five seconds of freshness slack; business
  acknowledgements, not Pongs, establish message delivery. Deploy the server
  before Bridge updates. OS/network/backend delays can extend recovery time.

Regression tests: `node --test test/bridge/sleep-gap-monitor.test.mjs test/bridge/updater.test.mjs`
and `python3 -m pytest test/server/test_bridge_connection_ownership.py`.

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

The launcher retries unexpected exits after five seconds and update exits after
one second. Successful exits and an explicit stop do not restart the child.
Task Scheduler remains the fallback for launcher failures; its existing
one-minute restart interval is unchanged.

### Claude credentials in background services

On macOS/Linux, directly resolved Claude executables load `~/.claude/env.sh`
when present, exporting its settings and adding Node's directory and `~/.local/bin`
to the child process PATH. This optional file must be trusted Bash code; Bridge
does not copy its credentials. Without it, existing authentication is unchanged.
Automatic updates restart Bridge, so no manual restart or unit changes are needed
for this fix. Later credential edits apply to new Claude processes; restart Bridge
to refresh already-running processes immediately.

## Worktree project-hash normalization (one session = one row)

When a Claude session `cd`s into a **git worktree** (e.g. an agent working under
`<project>/.claude/worktrees/<name>`), CC *moves* that session's `.jsonl` (same inode, not a copy)
to a project dir whose hash is `<parentHash>--claude-worktrees-<name>`. There is still one jsonl
and one sessionId.

`normalizeProjectHash(hash)` (`session-identity.mjs`) strips the `--claude-worktrees-*` suffix.
The session index, watcher, Claude runtime adapter and rename use the normalized hash, so the
session is listed once under its parent project. On-disk reads (`findSessionFile`,
`projectHashToPath`) keep the **real** worktree hash, so the jsonl is still read from the
worktree dir.

## REST API

All require `x-api-key` header.

### Bridge → Server

Only `/api/version`, `/api/install` (updates) and `/api/notifications/events` (alerts). Files go
through the account's S3 transfer area `t/<accountId>/<key>`, signed by the Bridge itself
(`bridge/transfer-store.mjs`, see "File transfer area" in docs/api.md).

### App → Server

```
GET /api/bridge/devices
→ { protocol: 2, devices: [{ deviceName, deviceDisplayName, os, online }], rpc }
# Home, project and session lists, history, threads and tool details are Bridge RPCs
# (home / projects / sessions / history / threads / tool_details), see docs/api.md.
```

## WebSocket Protocol

Three participants: App, Server (relay), Bridge. App ⇄ Bridge requests and pushes use the
direct channel (see docs/api.md); the Bridge's control socket carries heartbeats and routing.

### Real-time message push

```
Bridge detects new message in .jsonl:
  Bridge → direct channel → every App connection subscribed to that Session
  (best effort: no subscriber, no socket or a backlog drops it; the App recovers from a
   turn seq gap or its next history request)
```

### App subscribe/unsubscribe

```
App → Bridge (rpc):  history { sessionId, subscribe: true }  or  subscribe { sessionId }
App → Bridge (rpc):  unsubscribe { sessionId }
Bridge → App (push): { action: "messages", sessionId: "abc", messages: [...] }
```

### Heartbeat

```
Bridge → Server:  { action: "heartbeat" }
Server → Bridge:  { action: "heartbeat", ts: 1789900000, bridgeVersion: "1.0.0-abcdef0" }
(Bridge: every 4 minutes)
```

### Send message

```
Existing session:
App → Bridge (rpc):  send_message { sessionId: "abc", text: "...", turnId: "..." }
Bridge: _pool.send(sessionId) → headless `claude -p --resume <id>` over kept-open stdin (spawns if none)
        → stream_delta/stream_end (preview) + authoritative `messages` rows

New regular session: projectHash-only send → Bridge mints a UUID and acknowledges it before
spawning headless with `--session-id <id>`, so the app subscribes before stream frames arrive.

New agent session: `send_message` with `asAgent:true` launches detached `claude --bg`; the agent
poll and watcher publish its metadata and messages.
```

#### How text reaches Claude (headless stdin)

The bridge writes one JSON line per message to the session's headless process stdin:
`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<msg>"}]}}`. Single-writer per session (one pooled process) → no jsonl double-write. Output is parsed line-by-line: `content_block_delta` → `stream_delta` preview, full `assistant`/`user` rows → authoritative `messages` (uuid-deduped against the jsonl copy), `result` → `stream_end`. See `docs/headless-streaming.md`.

### Create project

```
App → Bridge (rpc):  create_project { projectPath: "workspace/x" }
Bridge: mkdir -p → derive projectHash → reply
Bridge → App:  { ok: true, projectHash: "...", projectName: "x", projectPath: "workspace/x" }
```

### View a project file (click-to-sync)

```
App → Bridge (rpc):  project_files { operation: "read", projectHash: "xxx", path: "bridge/ws.mjs" }
Bridge (bridge/project/files.mjs): resolve inside the project, stat, then by type:
  text  ≤300KB → the content in the reply's frames
  text  >300KB → first 1MB (partial last line dropped) → signed PUT to t/<accountId>/<key>
  image ≤10MB  → transfer.prepareUpload (content-hash key, HEAD dedup) → signed PUT
  video ≤5GB   → HEAD, then a streamed signed PUT when missing
Bridge → App:  { ok, key, path, size, truncated, image?, video?, text frames? }
App: text  → inline frames, or transfer.text(key) (signed GET)
     image → transfer.fileInfo(key) → signed URL (cached in IndexedDB)
     video → transfer.url(key) → <video> streams from S3 (Range/seek); re-signed at the
             current position when playback errors
```

### Slash commands (autocomplete)

Mirrors Claude Code's `/`-menu: typing `/` lists the current runtime-filtered
commands with the same descriptions and argument hints. Continuing to type
filters by prefix; ↑↓ navigates; commands with options open a second-level picker.

```
App → Bridge (rpc):  list_commands { projectHash: "xxx", runtime, known: "<fingerprint>" }
Bridge → Claude `-p` control_request `{subtype:"initialize"}` with
         `--no-session-persistence`
Claude → Bridge: runtime-filtered `commands`, `models`, aliases, descriptions,
                 argument hints, account/provider and feature state
Bridge: filter terminal-only or unsafe local commands; order executable local
        commands alphabetically, followed by prompt/Skill commands alphabetically,
        matching the TUI groups; attach live model/effort/fast picker options
App: cache by device/runtime/project for five minutes; send `list_commands` only
     when missing or expired
Bridge: force-refresh that current project for every real request; hash the compact
        frontend DTO into a stable revision; hard-truncate descriptions to 256
        UTF-8 bytes without splitting characters; coalesce concurrent refreshes
Bridge → App: the catalog in the rpc reply, or `notModified`
App: cache content + revision by device/runtime/project; show it immediately, skip
     validation for five minutes, and redraw an open top-level menu only when revision changes
```

Session-scoped picker values are requested separately through `list_command_options`; they never
enter the project catalog. This prevents Codex agent/subagent choices from one thread appearing in
another thread.

If an old Claude Code version does not support `initialize`, `commands.mjs` scans
only user/project/plugin Markdown commands and Skills. The fallback parses
frontmatter descriptions, argument hints and `user-invocable`; it intentionally
does not maintain a static built-in table.

### Local slash commands

The tmux `command_output` path was removed. Prompt/Skill commands and streaming local commands are
sent through the current headless process. Synchronous commands such as model selection use the same
process but finish through an ephemeral `commandOutput`; they do not invent a JSONL row.

`/usage` and its aliases (`/cost`, `/stats`) open a structured four-tab Settings panel. `/status`
and bare `/config` open the same panel at their matching tab. Status, Config, and current-session
Usage use `initialize`, `get_settings`, and `get_usage`. Stats is a read-only Worker-thread scan of
Claude's JSONL history, with Overview/Models and all-time/7-day/30-day ranges. The panel never writes
Claude settings or transcripts. `/config key=value` remains Claude's native setting command.

See [claude-commands.md](claude-commands.md) for the audited TUI command matrix and explicit
full/reduced/filtered classifications.

## Entering a Session — Complete Flow

```
App taps session "abc":

1. App → Bridge (rpc): history { sessionId: "abc", subscribe: true }
   The Bridge subscribes the caller before reading the file, so nothing falls between the
   page and the pushes, then answers the latest page from the local JSONL.

2. The App merges the page into its cached history (IndexedDB) and renders; a running turn is
   replayed to the new subscriber from its start.

3. Subsequent pushes (`messages`, stream events) append in turn/seq order.

4. Reconnect or foreground → the same `history` request refreshes the page and renews the
   subscription.

5. App leaves session → unsubscribe { sessionId: "abc" }
```

## Code Structure

```
baton/
├── bridge/
│   ├── bridge.mjs          # Entry point — startup, orchestration
│   ├── config.mjs          # CLI args, config loading, server config fetch
│   ├── http.mjs            # HTTP POST helper (attachment uploads)
│   ├── extract.mjs         # Message extraction, image compression + S3 upload
│   ├── runtime-adapter.mjs # Shared runtime read contract
│   ├── runtime-registry.mjs # Claude/Codex adapter registry
│   ├── claude-runtime.mjs  # Claude runtime adapter
│   ├── codex-runtime.mjs   # Codex read/status runtime adapter
│   ├── codex-session.mjs   # Codex rollout discovery
│   ├── codex-extract.mjs   # Codex event normalization
│   ├── session.mjs         # Preview, model, project name, session status detection
│   ├── headless.mjs        # ClaudePool — persistent `claude -p` stream-json process per session
│   ├── commands.mjs        # Slash-command scan (user/project/plugin/builtin)
│   ├── sync.mjs            # Startup catalog, reportSessions, checkStopped
│   ├── session-index.mjs   # Home/project/session lists for the direct channel
│   ├── history-service.mjs # History pages and threads from local JSONL
│   ├── direct-rpc.mjs      # Direct-channel requests and subscriber pushes
│   ├── transfer-store.mjs  # Signed S3 requests to the transfer area (Bridge and App)
│   ├── watcher.mjs         # fs.watch → read → push to subscribers
│   └── ws.mjs              # Control socket, rpc handlers, send/permission/interrupt
├── server/
│   ├── src/
│   │   ├── main.py         # FastAPI entry
│   │   ├── bridge_read.py  # devices, delete-device, device-name/validate, install
│   │   ├── devices.py      # Device rows in SystemTable
│   │   └── bridge_ws.py    # WS control socket ($connect/$disconnect/$default)
│   ├── template/Baton.template
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

> The DynamoDB Session storage was removed in v2; the Bridge's local JSONL is the only source.
- bridge.mjs watches .jsonl, syncs session metadata + messages to DDB
- New/resumed sessions detected instantly via fs.watch
- fs.watch → immediate read → WS push (no debounce, no polling)
- Periodic check (1min) only detects disappeared CC processes
- Deployed to ap-northeast-1 (Baton), verified

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
- Device routing
- Permission: bridge relays CC's `control_request` → app prompt → `permission_reply` (was client-side scan + capture-pane)

### Phase 2C: Native App (Tauri v2) ✅ Complete

Tauri v2 wraps the web/ static frontend as a native app — zero web code changes.

- `src-tauri/` at project root (sibling to web/, bridge/, server/)
- `frontendDist: "../web"` — directly serves static HTML/CSS/JS
- `withGlobalTauri: true` — JS accesses native APIs via `window.__TAURI__`
- Bundle identifier: `com.batonai.app`

**Targets:**
- Android: APK via `npm run build:android`
- iOS: IPA via `npm run build:ios`, TestFlight via `npm run release:ios`
- macOS: DMG via `npm run build:mac` (code signed + notarized)

**Native plugins:**
- QR code login: `tauri-plugin-barcode-scanner`
- Biometric auth: `tauri-plugin-biometric` (planned)

### Phase 2D: Claude Agents ✅ Complete

- Daemon roster and agent catalog provide agent identity and active worker state.
- Existing agents are resumed through the same headless pool as regular sessions.
- New background agents launch through detached `claude --bg`.
- Agent status supports Working, Needs input, and Completed without reviving stale daemon state.

### Phase 2E: Headless Streaming ✅ Complete

- `ClaudePool` is the only send path; tmux and Stall Rescue are removed.
- Existing and new sessions stream previews and authoritative rows through the shared WS protocol.
- Permission requests, `AskUserQuestion`, `ExitPlanMode`, interrupt, queueing, idle reap, and LRU
  process limits are implemented.
- Busy pool ownership, daemon roster state, and external JSONL/process state use explicit precedence
  so Web takeover and terminal resume update status correctly.

### Phase 3: Production Polish (Future)
- Improve native Windows process/status precision
- Push notifications
