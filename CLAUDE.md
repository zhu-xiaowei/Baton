# AgentPeek — Project Context

## Workflow Rules

- **Plan before code**: All code changes must be preceded by a detailed proposal (which files, what changes, why). Only modify code after explicit user confirmation.
- **Concise comments**: Keep code comments minimal — only what's necessary to understand non-obvious logic. Detailed design/architecture notes belong in CLAUDE.md, not inline.

## What is this

AgentPeek is a cross-platform app + bridge + server that lets you view and interact with Claude Code sessions from your phone or desktop. Three components:

1. **bridge/** — Node.js script running on Mac/Linux (always-on, auto-start), watches Claude Code's `.jsonl` session files
2. **server/** — AWS Lambda (FastAPI) + DynamoDB + WebSocket API GW, relays between bridge and app
3. **web/ + src-tauri/** — Static HTML/CSS/JS frontend, packaged as native app via Tauri v2 (Android/iOS/Desktop)

Brand name "AgentPeek" is only in user-facing places. Internal code uses generic names so renaming is easy.

## Core Design Principle

**Messages never touch DynamoDB.** They flow through WebSocket only:
- DDB: session metadata only (device/project/session lists for browsing)
- WS: all message content (history load + real-time)
- App localStorage: local auth/nav state cache

## Current Status

### Phase 1: COMPLETE ✅
- bridge.mjs syncs session metadata to DDB via HTTP POST
- bridge.mjs watches .jsonl files, detects new messages in real-time
- Deployed to ap-northeast-1 (AgentPeekTest), verified 300+ sessions

### Phase 2A: COMPLETE ✅ — Backend + API Verification
- Server REST read endpoints (devices, projects, sessions, messages)
- WebSocket API Gateway + relay (subscribe, broadcast, heartbeat)
- Bridge WS connection + real-time push
- Web viewer (web/) with dark theme, diff2html, markdown, file badges, Agent stats

### Phase 2B: COMPLETE ✅ — Send Messages + Images + Auto-tmux + Device Routing
- Message sending via tmux send-keys (cross-platform, zero-intrusion)
- Permission prompt detection + approval UI
- Image upload via S3 + `claude-bridge:` protocol
- Auto-create tmux session when no CC process running
- Device routing for multi-bridge setups

### Phase 2C: COMPLETE ✅ — Native App (Tauri v2)
- Tauri v2 wraps web/ as native app, zero web code changes
- Android, iOS (TestFlight), macOS builds

### Phase 2D: COMPLETE ✅ — Claude Agents Support
- Bridge monitors daemon roster.json + jobs/state.json for agent session detection
- Agent sessions display [Agent] badge + Working/Needs input/Completed status
- Send messages to agent sessions via claude agents TUI navigation (tmux → Right arrow → sendKeys)
- Create new agent sessions from web ("Run in background" toggle, localStorage persisted)
- Bridge respects permissions.defaultMode: bypassPermissions (no false permission prompts)

### Phase 3: LATER — Production polish
- Persist bridge sync state to disk, avoid re-uploading messages on restart

## Deployed Test Environment

**API URL and API key live in `.env.local` (gitignored). When you need them,
read that file** — do not hardcode them in committed code. Variables:
`AGENTPEEK_API_URL`, `AGENTPEEK_API_KEY`. See `.env.local.example` for the
template. S3 bucket / ECR repo / AWS account id are derived automatically by
`server/install.sh` from the stack name + `aws sts get-caller-identity`.

- **Region**: ap-northeast-1
- **Stack**: AgentPeekTest
- **DDB Tables**: `AgentPeekTest-bridge-sessions`, `AgentPeekTest-bridge-messages`
- **Deploy**: `cd server && ./install.sh --region ap-northeast-1 --stack AgentPeekTest`

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
  - Interrupt detection: `[Request interrupted by user*]` → idle, `tool_result(is_error=true)` only → idle
  - VS Code CC: no `--resume` → project-level detection + file mtime heuristic (mtime > 5min → stopped regardless of content)
- `findTmuxTargetForSession`: exact match CC process args sessionId → find tmux pane
- `projectHashToPath()`: reverse hash to real directory path (validates each segment exists)
- Auto-launch: no tmux target → auto-create tmux + `claude --resume` + `waitForCCReady`
- Claude Agents support:
  - `getDaemonSessions()`: reads `~/.claude/jobs/*/state.json` → isAgent/agentName/agentDetail/agentState
  - `getDaemonRunningSessionIds()`: reads `~/.claude/daemon/roster.json` → active worker sessionIds
  - Status via `mapAgentState()` (single source): `state` field authoritative (done/completed→done, blocked/failed→blocked, else→running), falls back to `tempo` only when `state` absent. `tempo` lags and stays 'active' after a job blocks/fails, so it can't lead.
  - Jobs watcher: `fs.watch(~/.claude/jobs/)` detects state.json changes → sync to DDB
  - Send to agent: `launchAgentsSession()` → tmux + `claude agents --cwd` → navigate TUI → Right → sendKeys
  - New agent session: `handleNewAgentSession()` → tmux + `claude agents` → type in bottom input → poll for .jsonl → kill tmux
  - `permissions.mjs` respects `defaultMode: bypassPermissions` from global/project settings
- Slash commands (`commands.mjs`): `/`-autocomplete like CC. Bridge `scanSlashCommands()` scans user/project/enabled-plugin commands+skills on disk, plus a static `BUILTIN_COMMANDS` list mirroring CC's compiled-in bundled skills (re-sync on CC upgrades). WS `list_commands` → `commands_list`; app caches per-device (global) + per-project in localStorage. "Local" commands (status/config/usage/stats/goal/…) render only in CC's terminal — bridge grabs their output via `tmux capture-pane` and pushes `command_output` (ANSI preserved), Esc-dismissing full-screen dialogs afterward. Details: `docs/api.md` (protocol) + `docs/claude-code-bridge.md` (flow).
- Config: `~/.claude-bridge/config.json`, auto-created from CLI args
- Always-on: launchd (macOS) / systemd user service + `loginctl enable-linger` (Linux)
- Deployed bridge runs from `~/.claude-bridge/` (copied), NOT the workspace `bridge/`. Local dev: `cp bridge/*.mjs ~/.claude-bridge/` + restart service.
- Auto-update: every 5min `checkUpdate()` compares local `config.version` vs server `/api/version`; on change, downloads from `/api/install` (files baked into the Lambda image) + restarts. So deploying the server (`install.sh`) auto-updates ALL bridges within 5min — no manual touch.
- `/api/version` reads `APP_VERSION` env (= semantic + git hash, set per build). Managed by CFN (`AppVersion` param in template, passed by install.sh). Lambda env overrides image ENV, so the CFN param MUST stay wired or the version freezes and auto-update silently stops.
- Initial sync: full session metadata + messages for running/idle + recent 24h sessions, parallel (concurrency=4)
- Periodic check (5min): `checkStopped()` — only detects disappeared CC processes via `ps aux`
- Watcher: fs.watch detects jsonl changes → sync metadata only on status change, new session, or ai-title
- Status cache: `lastKnownStatus` Map prevents redundant sync POSTs (only sends on change)
- Debounce: busy Map per session dedup fs.watch duplicate events
- Line-number tracking per session (not UUID set), lightweight
- Images: sharp compress 1280px JPEG (quality=90) → upload S3 via Lambda → store key in message
- Batching: by byte size (≤4MB/POST), with 200ms delay between batches
- WS ack: `wsSendWithAck` waits for server `messages_ack` reply (5s timeout), falls back to HTTP POST to DDB if no ack

### Server
- FastAPI in Docker Lambda, API Key auth
- DDB `accountId` = SHA256(apiKey)[:16] — raw key never stored
- `install.sh`: ECR → S3 → CodeBuild (arm64) → CloudFormation
- Bridge install script (`/api/install`): auto-installs tmux if missing, exports `XDG_RUNTIME_DIR` for Ubuntu SSH compatibility

### Message Flow (WS single path + DDB cache)
- Bridge detects new message → WS push to server (single path, never writes DDB directly)
- Lambda receives message → parallel: post_to_connection to app (priority) + write DDB (cache)
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
POST /api/bridge/sync-messages              — bridge bulk sync on startup (runtime uses WS)
GET  /api/bridge/devices                    — device list (includes online field from connections table)
GET  /api/bridge/projects?device=X          — project list
GET  /api/bridge/sessions?device=X&project=Y — session list
GET  /api/bridge/messages?session=X&after=ts — messages (incremental, ts=ISO timestamp)
GET  /api/install                           — bridge install script (auto-installs tmux, sets up service)
```

### WebSocket (real-time)
```
App → Server:           { action: "subscribe", sessionId }
App → Server:           { action: "unsubscribe", sessionId }
App → Server → Bridge:  { action: "send_message", sessionId, text, device }
                        { action: "send_message", projectHash, text, device }  — new session
App → Server → Bridge:  { action: "permission_reply", sessionId, approved, device }
App → Server → Bridge:  { action: "list_commands", projectHash, device, requestId }  — slash-command scan
Bridge → Server → App:  { action: "send_message_result", ok, sessionId? }
Bridge → Server → App:  { action: "commands_list", requestId, commands }  — broadcast to all app conns
Server → App:           { action: "messages", sessionId, messages }
```

Full protocol: `docs/api.md`

## Send Messages Architecture

Approach: tmux send-keys (cross-platform, zero-intrusion)

### Message Sending
- Viewer → WS → Server → Bridge → tmux send-keys → CC
- Optimistic rendering + dedup + timestamp update

### Permission Detection + User Interaction
- Viewer detects AskUserQuestion / ExitPlanMode / Bash / Edit / Write from tool_use
- AskUserQuestion / ExitPlanMode: show prompt immediately (CC is waiting for user)
- Bash / Edit / Write: 5s wait for tool_result; if received → mark auto; if not → mark manual and show prompt
- Mode cached in memory (not localStorage), re-detected on page refresh
- tool_result arrival unconditionally closes prompt dialog
- Option card UI (arrow:N, type:N:text, escape)
- Real-time tool_result (OUT) appended (tool-grid structure + collapsible)

### Image Sending
- S3 upload + `![](claude-bridge:key)` protocol
- Bridge downloads → replaces with absolute path → CC Read tool reads it
- Multi-image staging + gallery + paste support

### Auto-create tmux Session
- Existing session with no CC process → Bridge auto `tmux new-session` + `claude --resume <id>` + wait ready + sendKeys
- New Session: Viewer "+ New Session" button → `send_message` with projectHash → Bridge creates tmux + claude → poll .jsonl for sessionId → return to Viewer for subscribe
- Trust dialog auto-confirm (detects "Yes, I trust this folder" → Enter)
- tmux naming: resume `apeek_{project}_{sessionId first 8 chars}`, new `apeek_{project}_{MMDDHHmmss}`
- Old session cleanup: `cleanStaleSessions()` kills `apeek_*` tmux inactive >1 day; runs periodically (hourly-throttled) inside `checkStopped`, not on tmux creation. Only touches bridge-created `apeek_*` sessions — never user-opened terminals.
- Duplicate session name: kill existing before creating

### Device Routing
- Bridge WS connection includes `device` parameter
- Server stores `deviceName`, filters send_message/permission_reply forwarding by device
- Viewer sends messages with `device: appState.device`

## Web Deployment

### Web Pages (served from FastAPI Lambda)
- `web/landing.html` — API key input, URL `?key=` auto-login, localStorage (`_ak` btoa obfuscated)
- `web/index.html` — Session viewer (auth guard redirects to landing if no key)
- `web/setup.html` — Bridge install command + QR code + connected devices list
- Top bar: AgentPeek logo + Setup gear icon
- Favicon: inline data:image/svg+xml (all pages unified)

### Auth Flow
- Key stored in localStorage (`_ak` = btoa, `_as` = server URL)
- No cookies, no server middleware — static files publicly accessible
- API calls use `x-api-key` header from localStorage
- API Gateway `ApiKeyRequired: false` — auth handled by FastAPI layer

### Deployment
- Dockerfile: `COPY web/ web/` → FastAPI `StaticFiles` mount
- `install.sh`: copies `web/` to Docker build context, deploys via CodeBuild
- Deploy output: single setup URL with embedded token (12h TTL)

### Three-State Session Status
- `running`: CC process alive + jsonl `stop_reason: "tool_use"` or `null`
- `idle`: CC process alive + jsonl `stop_reason: "end_turn"` or `last-prompt`
- `stopped`: no CC process for this session
- Badge colors: running (green), idle (yellow), stopped (gray)
- Device/Project lists show `runningCount` + `idleCount`

## Native App (Tauri v2)

Tauri v2 wraps web/ static frontend as native app, zero web code changes.

### Architecture
- `src-tauri/` at project root (sibling to web/, bridge/, server/)
- `frontendDist: "../web"` — directly serves static HTML/CSS/JS
- `withGlobalTauri: true` — JS accesses native API via `window.__TAURI__`
- Bundle identifier: `com.agentpeek.app`
- Built-in dev server (no http-server needed), hot-reload

### Targets
- Android: primary
- iOS: secondary (TestFlight)
- Desktop (macOS/Win/Linux): bonus, same config

### Commands
```
# Dev
npm run dev:android / dev:ios / tauri:dev

# Release (all four platforms have ready-made scripts in scripts/)
npm run build:android       — release APK (aarch64)
npm run release:ios         — build + bump CFBundleVersion + upload TestFlight
npm run build:mac           — signed + notarized universal macOS DMG
npm run build:windows       — cross-compiled Windows NSIS installer (.exe)
```

All release scripts read secrets from `.env.local` (gitignored). See each script's
header comment for required env vars, one-time setup, and output paths.

### Native Features (planned)
- QR scan login: `tauri-plugin-barcode-scanner`
- Local notifications: `tauri-plugin-notification`
- Biometric auth: `tauri-plugin-biometric`

## Future: tmux capture-pane Live State (not implemented)

CC has many intermediate states not written to jsonl, only displayed in terminal. `tmux capture-pane -p` is the only way to capture them:

- **Thinking animation**: Pondering... / Vibing... / Computing... etc.
- **Thinking content**: reasoning displayed in real-time
- **Permission waiting**: precise detection of whether CC is waiting for user confirmation (vs. running a long command)
- **Progress info**: tool execution output

### Permission Detection Improvement
Current viewer uses 5s timer heuristic to decide whether to show permission prompt — false positives exist (auto-approved long commands also trigger it).
Better approach: bridge detects tool_use → waits a few seconds → capture-pane once → sees permission prompt → pushes `permission_needed` to viewer.
Performance: capture-pane reads one screen of text in ~5ms, triggered only on tool_use, negligible overhead.

### Implementation Direction
Design as a "tmux live state" module: bridge periodically or on-demand capture-pane, parse CC terminal state, push via WS to viewer.

## Known Issues / TODO

- **WS oversized messages**: API Gateway WS single-frame cap is **32768B** (not 128KB — exceeding it drops the whole connection with close code 1009 → reconnect storm + hundreds of stale ConnectionsTable entries). Fixed: `watcher.mjs` checks the WS envelope size; oversized messages send a **truncated copy** over WS (`truncateToBytes()` in `extract.mjs`, byte-aware so CJK/emoji keep a real prefix; carries `truncated: true` + `noCache: true`) for real-time display, and the **full copy** over HTTP to DDB. `bridge_ws.py` skips the DDB cache write when `noCache` is set so the truncated WS copy never clobbers the full HTTP copy. `uploadMessages()` also caps every message to `DDB_ITEM_LIMIT` (360KB) so the 400KB DDB item limit can't be exceeded. Limits: `WS_FRAME_LIMIT`/`DDB_ITEM_LIMIT` in `config.mjs`.
- **VS Code CC status precision**: VS Code extension launches CC without `--resume` flag, cannot precisely match session. Uses mtime heuristic (5 min timeout → stopped). terminal/tmux-launched CC unaffected.
