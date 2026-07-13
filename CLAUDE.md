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
  - Agent status source is **`claude agents --json --all`** (daemon-live, matches the TUI), NOT `jobs/*/state.json` (the daemon computes state live but flushes state.json lazily, so it reads stale — often `done` while the agent is really blocked/working). `getAgentsJson()` runs the CLI (3s TTL cache; returns last-good cache on failure so agents never flap to stopped), resolving the `claude` binary by absolute path since systemd's bare PATH can't find it. `mapAgentState()` maps the CLI's clean working/blocked/done → running/blocked/done. Filter to `kind === 'background'` — `--json` also lists plain `kind:"interactive"` sessions (no `state`) which must NOT be tagged isAgent.
  - `agentDetail` (the blocked question shown on the card) is the ONE field still read from `jobs/<sid[:8]>/state.json`'s `needs` — `--json`'s `waitingFor` is almost always null.
  - `getDaemonRunningSessionIds()`: reads `~/.claude/daemon/roster.json` → active worker sessionIds (still used to detect a done-agent resumed as a normal CC session).
  - Agent status poll (`watcher.pollAgentStates`, every `AGENTS_POLL_INTERVAL_MS`): diffs `getAgentsJson()` vs `_jobsState`, pushes changed agents. Empty `_jobsState` on startup → first poll full-pushes every agent (heals DDB + covers every version-update restart). Replaced the old `fs.watch(state.json)` (missed transitions since state.json lags).
  - Status paths that key off live CC processes (`checkStopped`, stall idle-downgrade) must **skip daemon agents** — they have no `--resume` process, so they'd be misread as stopped and stripped of agent metadata. Agent status is owned by the poll.
  - Worktree project-hash normalization: a session that `cd`s into `<proj>/.claude/worktrees/<name>` has its jsonl moved to a new project dir, producing a 2nd DDB row for one sessionId. `normalizeProjectHash()` strips `--claude-worktrees-*` at every POST site (keeps real hash for on-disk reads) → one session, one row, under the parent project. See `docs/claude-code-bridge.md`.
  - Send to agent: `launchAgentsSession()` → tmux + `claude agents --cwd` → navigate TUI → Right → sendKeys
  - New agent session: `handleNewAgentSession()` → tmux + `claude agents` → type in bottom input → poll for .jsonl → kill tmux
  - Reveal stuck agent: app opens an agent with no visible pending prompt → `reveal_agent` WS → bridge opens the agents TUI + Escape to flush an in-memory AskUserQuestion to jsonl (reuses the stall-rescue path). Gate on `hasNoDanglingTurn`, not agentState.
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
POST /api/bridge/video-prepare              — video preview: HEAD dedup + presigned PUT URL (bridge streams to S3)
GET  /api/bridge/video-url/{key}            — video preview: presigned GET URL (no-store; browser streams from S3)
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

### Reliable WS Delivery (app side, `web/js/ws.js`)
- **Sends must survive a dead socket.** User actions (`send_message`/`interrupt`/`create_project`) use `wsSendReliable`, not bare `wsSend` (which drops frames when not OPEN): queues to `_wsSendQueue` (array, ordered) + reconnects, flushed on `onopen` after re-subscribe. iOS suspends the socket in background into a zombie (reads OPEN, frames vanish, no `close`) — `handleForegroundResume` (`visibilitychange`/`pageshow`/`focus`) forces reconnect + `recoverMissing()` when a real session is active. This kills the "agent 2nd message fails / Retry dead until re-enter" bug.
- **No duplicate/stuck bubbles.** Each optimistic bubble carries a monotonic send `seq`. `reconcileEchoedPending()` (end of `updateLastTurn`) retires a pending when (1) its echo is present (covers echoes that arrived via `bufferAndFetch`, which `tryDedup` skips), or (2) `seq < lastDeliveredSeq` — a later send was already confirmed, so this earlier one was swallowed by a busy-CC send and never reached jsonl (echo never comes). `lastDeliveredSeq` is a persistent watermark bumped in `tryDedup`/`resolvePending(ok)`/echo-match, so orphan detection survives the confirmed pending being removed; reset with `pendingSentMessages` on every session switch. `isImage` bubbles are never auto-orphaned (attachments, no matchable text). Without this an orphan has no `data-ts` and sticks to the bottom forever. New-session banner: `body.new-session #content` is flex-centered, so `.ws-banner` is pinned `position:absolute; top:0` instead of being pulled to the middle.

### Scroll-to-bottom on session open (no flash / no "差一截")
- **Order matters: clamp BEFORE scroll.** `clampOverflow` collapses long messages (adds `.clamped` → max-height 4.5em), shrinking total height. If you scroll first then clamp, the collapse pulls the viewport off the bottom → visible correction jump. Both the initial render (`app.js` `loadMessages`) and the live-append path (`ws.js`) call `loadImages` + `clampOverflow` and only then set `scrollTop = scrollHeight`. Removed the old `setTimeout(...,500)` correction jump (it was the visible "flash then snap"). Initial render also re-scrolls in `requestAnimationFrame` (runs after layout settles, before paint) to absorb sync reflow without a visible jump.
- **diff2html height is async & unknowable at render time.** `tool.js` `renderEdit` injects the diff via `setTimeout` (Diff2HtmlUI draws line-by-line later), so `scrollHeight` at scroll time doesn't include it → scroll lands short ("差一截"). Do NOT try to read the rendered height. Fix (方案 B): the `.diff-container` ships with an **estimated `min-height`** (`(oldLines+newLines)*18 + 12`, capped at 240 because taller diffs get collapsed) so the initial scroll lands near the true bottom; the estimate is **cleared after `ui.draw()`, and that clear must happen BEFORE the `scrollHeight > 240` collapse check** or an over-estimate falsely triggers collapse. Small residual (estimate vs real) is absorbed by the browser's default `overflow-anchor` — never set `overflow-anchor: none` on `#content`/`.messages`.
- **Watch-outs (observing):** estimate over-counts for large replace-diffs (diff2html shows changed+context, not old+new summed) → brief shrink after draw, hidden by anchor; iOS/WKWebView `overflow-anchor` support is weaker than Chrome — if residual reappears on iOS it's this. Both degrade to "barely visible", not back to the original bug, because min-height already killed the large reflow.

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

### File / Video Preview (click a file link in a message)
- Click file link → `openFile()` → WS `request_file` → bridge `handleRequestFile` (`ws.mjs`) reads from disk.
- Text/image: bridge base64s + POSTs to Lambda (`/upload-file` → `files/{key}`, `/upload-image` → `images/{key}`), replies `file_ready {key}`; frontend GETs `/api/bridge/file|image/{key}` (served base64-as-text from S3). Binary text files (NUL byte in first 8KB) → `binary file` error.
- **Video** (`.mp4/.m4v/.mov/.webm/.mkv/.avi`, ≤5GB): base64-through-Lambda is impossible (API GW 6MB limit), so the bridge **streams the file straight to S3** via a presigned PUT. `POST /video-prepare {key}` → server HEADs `videos/{key}`: exists → `{exists:true}` (skip upload, dedup by content-hash key so it survives bridge restarts), else returns presigned PUT URL → bridge `fs.createReadStream` piped to `fetch(PUT, {duplex:'half'})` (flat memory regardless of size). Bridge replies `file_ready {video:true, key}`; frontend calls `GET /api/bridge/video-url/{key}` for a short-lived presigned GET URL and plays it in a `<video>` element streaming directly from S3 (Range/seek supported). No CloudFront/IAM change — Lambda already has S3 Get/Put; presigning uses those creds.

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

## Stall Rescue (multi-question AskUserQuestion wizard)

A multi-question AskUserQuestion (the tab-bar wizard: `☐ header1  ☐ header2  ✔ Submit`) holds its entire tool_use in CC's memory and never writes it to jsonl until the user reaches Submit — a session can sit like this indefinitely with nothing for the bridge to see, looking permanently `running` with no way to view or answer the question from the app.

- **Detection is two gates, not a timeout** (`bridge/stall.mjs`): jsonl mtime silence (`STALL_JSONL_SILENCE_MS`) is only a cheap pre-filter to decide whether `capture-pane` is worth calling — the file goes silent for as long as CC is generating a turn (thinking + text + tool_use flush together once the turn ends, sometimes 30-60s+), which is completely normal and indistinguishable from a real stall at the file level. The actual verdict comes from the pane content: `tmux.mjs`'s `isAskUserQuestionWizard()` matches the wizard's fixed chrome (`✔ Submit` tab bar, not busy), and a candidate must show that same match on **two captures `STALL_CONFIRM_INTERVAL_MS` apart** before being rescued — a wizard that only just rendered fails that stability check and is left alone next poll.
- **Rescue**: `interruptSession()` (Escape + C-u) forces CC to flush the pending tool_use — with the real, complete `questions[]` data — plus a synthetic rejection `tool_result` and `[Request interrupted by user for tool use]` marker.
- **Hiding the synthetic pair**: `bridge/stallState.mjs` tracks an armed/rescued state per session. `watcher.mjs` recognizes the synthetic rejection (matches the rescued tool_use's id) + interrupt marker and never forwards them to WS/DDB — the real `.jsonl` file is never touched or rewritten, only what the bridge relays is filtered. The flushed tool_use itself is tagged `stallRescued: true` before being sent to the app.
- **App side** (`web/js/components/permission.js`'s `checkPendingPrompts` + `web/js/components/stallprompt.js`): a `stallRescued` tool_use looks pending (no visible tool_result, since the real one is hidden) but CC has already moved on — there's no live AskUserQuestion state left to navigate via arrow keys. Answers are collected through the wizard's questions and sent back as one plain chat message via `send_message`, not `permission_reply`.
- Normal single-question AskUserQuestion prompts (no tab bar) are unaffected — they flush to jsonl immediately like any other tool_use and are handled by the pre-existing `needsPermission` prompt path.

## Known Issues / TODO

- **WS oversized messages**: API Gateway WS single-frame cap is **32768B** (not 128KB — exceeding it drops the whole connection with close code 1009 → reconnect storm + hundreds of stale ConnectionsTable entries). Fixed: `watcher.mjs` checks the WS envelope size; oversized messages send a **truncated copy** over WS (`truncateToBytes()` in `extract.mjs`, byte-aware so CJK/emoji keep a real prefix; carries `truncated: true` + `noCache: true`) for real-time display, and the **full copy** over HTTP to DDB. `bridge_ws.py` skips the DDB cache write when `noCache` is set so the truncated WS copy never clobbers the full HTTP copy. `uploadMessages()` also caps every message to `DDB_ITEM_LIMIT` (360KB) so the 400KB DDB item limit can't be exceeded. Limits: `WS_FRAME_LIMIT`/`DDB_ITEM_LIMIT` in `config.mjs`.
- **VS Code CC status precision**: VS Code extension launches CC without `--resume` flag, cannot precisely match session. Uses mtime heuristic (5 min timeout → stopped). terminal/tmux-launched CC unaffected.
