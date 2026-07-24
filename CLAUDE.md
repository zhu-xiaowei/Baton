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

### Phase 2B: COMPLETE ✅ — Send Messages + Images + Device Routing
> ⚠️ Originally built on tmux send-keys; **superseded by Phase 2E (headless)** — tmux is deleted. The image/device pieces below still stand.
- Message sending (was tmux send-keys → now headless stream-json pool, see Phase 2E)
- Permission prompt detection + approval UI
- Image upload via S3 + `claude-bridge:` protocol
- Auto-create session when no CC process running (was tmux auto-launch → TODO under headless)
- Device routing for multi-bridge setups

### Phase 2C: COMPLETE ✅ — Native App (Tauri v2)
- Tauri v2 wraps web/ as native app, zero web code changes
- Android, iOS (TestFlight), macOS builds

### Phase 2D: COMPLETE ✅ — Claude Agents Support
- Bridge monitors daemon roster.json + jobs/state.json for agent session detection
- Agent sessions display [Agent] badge + Working/Needs input/Completed status
- Send messages to agent sessions: was `claude agents` TUI navigation over tmux; **superseded by Phase 2E** — headless `claude -p --resume <agentSessionId>` handles agent sessions like any other (TODO: not yet wired, see 2E)
- Create new agent sessions from web ("Run in background" toggle, localStorage persisted) — TODO under headless
- Bridge respects permissions.defaultMode: bypassPermissions (no false permission prompts)

### Phase 2E: IN PROGRESS 🚧 — tmux removed, headless is the only send path
**tmux is fully deleted.** The entire send/permission/launch stack now goes through
the headless stream-json process pool (`bridge/headless.mjs` `ClaudePool`). Anything
that was tmux-only and not yet re-covered by headless is a TODO below — DO NOT
reintroduce tmux to fix it; wire it through the pool.

Done:
- **`bridge/tmux.mjs` deleted entirely** (send-keys, capture-pane, launch, TUI nav, wizard detection, `hasTmux`, stale-session cleanup).
- `projectHashToPath` moved into `session.mjs` (pure path util, not tmux). `getClaudeProcesses` was tmux-only and dropped — `getRunningInfo` in `session.mjs` has its own `ps aux` parser.
- Server bridge-install script (`/api/install`) no longer auto-installs tmux.
- Existing-session send → headless streaming (`handleHeadlessSend` → `_pool.send`), the primary happy path. Works today.
- `interrupt` routed to `_pool.interrupt` (SIGINT the headless proc).
- Stall Rescue detector (`stall.mjs` `checkStalledSessions`) removed; arm/rescue state kept as an inert stub so `watcher.mjs`/`ws.mjs` imports still resolve (fully removable once headless permission path lands).

TODO (each currently returns a "not available yet" reply or is a no-op so the bridge boots; ref `docs/headless-streaming.md` §十三 Step 2–5):
- [ ] **Permission bridge** — `handlePermissionReply` is a no-op; `onControlRequest` only auto-allows non-interactive tools. Wire: control_request → app prompt → `_pool.replyControl` (allow/deny); `requires_user_interaction` (AskUserQuestion/ExitPlanMode) → deny + send answer as a plain user message. Frontend `permission.js` `arrow:`/`type:`/`escape` protocol must change to carry the actual answer text.
- [ ] **New session / new agent / create_project** — `handleSendMessage` projectHash branch + `handleCreateProject` return "not available yet". Wire: headless spawn without `--resume`, take sessionId + cwd from `system/init` (watch the symlink-cwd trap).
- [ ] **AskUserQuestion stall** — no longer needs pane sampling; headless surfaces the full `questions[]` via control_request. `handleRevealAgent` is a no-op until the permission bridge lands.
- [ ] **Local slash-command output** (`/context`, `/usage`, …) — capture removed. Under headless, `/cmd` is sent as plain text and its output streams back normally; the pure-TUI ones just won't be exposed. `LOCAL_COMMANDS`/`DIALOG_COMMANDS`/`SYNTHETIC_COMMANDS` in `commands.mjs` are now dead exports, removable.
- [ ] **External-session status precision** — lost capture-pane truth; `resolveStatus`/`getSessionStatus` fall back to `ps aux` only. Headless-owned sessions report `busy` via the pool.
- [ ] Remove the `streamMode` flag entirely (headless is unconditional now; frontend `web/js/ws.js` still sends it).

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
  - terminal CC launched with `--resume` → exact session match → precise status
  - Interrupt detection: `[Request interrupted by user*]` → idle, `tool_result(is_error=true)` only → idle
  - VS Code CC: no `--resume` → project-level detection + file mtime heuristic (mtime > 5min → stopped regardless of content)
  - NOTE: capture-pane terminal-truth (`isTerminalBusy`/`paneRunState`) was removed with tmux (Phase 2E); external-session status now falls back to `ps aux` only. Headless-owned sessions report `busy` via the pool.
- `projectHashToPath()` (in `session.mjs`): reverse hash to real directory path (validates each segment exists)
- Claude Agents support:
  - Agent status source is **`claude agents --json --all`** (daemon-live, matches the TUI), NOT `jobs/*/state.json` (the daemon computes state live but flushes state.json lazily, so it reads stale — often `done` while the agent is really blocked/working). `getAgentsJson()` runs the CLI (3s TTL cache; returns last-good cache on failure so agents never flap to stopped), resolving the `claude` binary by absolute path since systemd's bare PATH can't find it. `mapAgentState()` maps the CLI's clean working/blocked/done → running/blocked/done. Filter to `kind === 'background'` — `--json` also lists plain `kind:"interactive"` sessions (no `state`) which must NOT be tagged isAgent.
  - `agentDetail` (the blocked question shown on the card) is the ONE field still read from `jobs/<sid[:8]>/state.json`'s `needs` — `--json`'s `waitingFor` is almost always null.
  - `getDaemonRunningSessionIds()`: reads `~/.claude/daemon/roster.json` → active worker sessionIds (still used to detect a done-agent resumed as a normal CC session).
  - Agent status poll (`watcher.pollAgentStates`, every `AGENTS_POLL_INTERVAL_MS`): diffs `getAgentsJson()` vs `_jobsState`, pushes changed agents. Empty `_jobsState` on startup → first poll full-pushes every agent (heals DDB + covers every version-update restart). Replaced the old `fs.watch(state.json)` (missed transitions since state.json lags).
  - Status paths that key off live CC processes (`checkStopped`, stall idle-downgrade) must **skip daemon agents** — they have no `--resume` process, so they'd be misread as stopped and stripped of agent metadata. Agent status is owned by the poll.
  - Worktree project-hash normalization: a session that `cd`s into `<proj>/.claude/worktrees/<name>` has its jsonl moved to a new project dir, producing a 2nd DDB row for one sessionId. `normalizeProjectHash()` strips `--claude-worktrees-*` at every POST site (keeps real hash for on-disk reads) → one session, one row, under the parent project. See `docs/claude-code-bridge.md`.
  - Send to agent / new agent / reveal stuck agent: were tmux `claude agents` TUI navigation — **removed in Phase 2E**, TODO to re-wire via headless `claude -p --resume <agentSessionId>` (agent sessions resume like any normal CC session; the daemon-live `--json` status source is untouched).
  - `permissions.mjs` respects `defaultMode: bypassPermissions` from global/project settings
- Slash commands (`commands.mjs`): `/`-autocomplete like CC. Bridge `scanSlashCommands()` scans user/project/enabled-plugin commands+skills on disk, plus a static `BUILTIN_COMMANDS` list mirroring CC's compiled-in bundled skills (re-sync on CC upgrades). WS `list_commands` → `commands_list`; app caches per-device (global) + per-project in localStorage. NOTE: "local" command output was captured via `tmux capture-pane` — **removed in Phase 2E**. Under headless a `/cmd` is sent as plain text and its output streams back normally; `LOCAL_COMMANDS`/`DIALOG_COMMANDS`/`SYNTHETIC_COMMANDS` in `commands.mjs` are now dead exports. Details: `docs/api.md` (protocol) + `docs/claude-code-bridge.md` (flow).
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
- Bridge install script (`/api/install`): exports `XDG_RUNTIME_DIR` for Ubuntu SSH compatibility (tmux auto-install removed in Phase 2E)

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
GET  /api/install                           — bridge install script (sets up always-on service)
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

Approach: **headless stream-json process pool** (`bridge/headless.mjs` `ClaudePool`). One
persistent `claude -p --input-format stream-json --output-format stream-json` process per
session, fed over a kept-open stdin. Single-writer per session → no jsonl double-write.
Replaced the old tmux send-keys approach (deleted in Phase 2E). Full design: `docs/headless-streaming.md`.

### Message Sending
- Viewer → WS → Server → Bridge → `handleHeadlessSend` → `_pool.send` → CC stdin
- Streaming back: `stream_delta` (typewriter preview) + `stream_end`; full assistant/user
  lines arrive as authoritative `messages` (uuid-deduped against the jsonl copy)
- Optimistic rendering + dedup + timestamp update

### Reliable WS Delivery (app side, `web/js/ws.js`)
- **Sends must survive a dead socket.** User actions (`send_message`/`interrupt`/`create_project`) use `wsSendReliable`, not bare `wsSend` (which drops frames when not OPEN): queues to `_wsSendQueue` (array, ordered) + reconnects, flushed on `onopen` after re-subscribe. iOS suspends the socket in background into a zombie (reads OPEN, frames vanish, no `close`) — `handleForegroundResume` (`visibilitychange`/`pageshow`/`focus`) forces reconnect + `recoverMissing()` when a real session is active. This kills the "agent 2nd message fails / Retry dead until re-enter" bug.
- **No duplicate/stuck bubbles.** Each optimistic bubble carries a monotonic send `seq`. `reconcileEchoedPending()` (end of `updateLastTurn`) retires a pending when (1) its echo is present (covers echoes that arrived via `bufferAndFetch`, which `tryDedup` skips), or (2) `seq < lastDeliveredSeq` — a later send was already confirmed, so this earlier one was swallowed by a busy-CC send and never reached jsonl (echo never comes). `lastDeliveredSeq` is a persistent watermark bumped in `tryDedup`/`resolvePending(ok)`/echo-match, so orphan detection survives the confirmed pending being removed; reset with `pendingSentMessages` on every session switch. `isImage` bubbles are never auto-orphaned (attachments, no matchable text). Without this an orphan has no `data-ts` and sticks to the bottom forever. New-session banner: `body.new-session #content` is flex-centered, so `.ws-banner` is pinned `position:absolute; top:0` instead of being pulled to the middle.

### Scroll-to-bottom on session open (no flash / no "差一截")
- **Order matters: clamp BEFORE scroll.** `clampOverflow` collapses long messages (adds `.clamped` → max-height 4.5em), shrinking total height. If you scroll first then clamp, the collapse pulls the viewport off the bottom → visible correction jump. Both the initial render (`app.js` `loadMessages`) and the live-append path (`ws.js`) call `loadImages` + `clampOverflow` and only then set `scrollTop = scrollHeight`. Removed the old `setTimeout(...,500)` correction jump (it was the visible "flash then snap"). Initial render also re-scrolls in `requestAnimationFrame` (runs after layout settles, before paint) to absorb sync reflow without a visible jump.
- **diff2html height is async & unknowable at render time.** `tool.js` `renderEdit` injects the diff via `setTimeout` (Diff2HtmlUI draws line-by-line later), so `scrollHeight` at scroll time doesn't include it → scroll lands short ("差一截"). Do NOT try to read the rendered height. Fix (方案 B): the `.diff-container` ships with an **estimated `min-height`** (`(oldLines+newLines)*18 + 12`, capped at 240 because taller diffs get collapsed) so the initial scroll lands near the true bottom; the estimate is **cleared after `ui.draw()`, and that clear must happen BEFORE the `scrollHeight > 240` collapse check** or an over-estimate falsely triggers collapse. Small residual (estimate vs real) is absorbed by the browser's default `overflow-anchor` — never set `overflow-anchor: none` on `#content`/`.messages`.
- **Watch-outs (observing):** estimate over-counts for large replace-diffs (diff2html shows changed+context, not old+new summed) → brief shrink after draw, hidden by anchor; iOS/WKWebView `overflow-anchor` support is weaker than Chrome — if residual reappears on iOS it's this. Both degrade to "barely visible", not back to the original bug, because min-height already killed the large reflow.

### Permission Detection + User Interaction
> ⚠️ This is the **old tmux-era client-side heuristic**. Bridge-side reply (`handlePermissionReply`) is a no-op after Phase 2E — TODO to re-wire via headless `control_request`/`replyControl` (see Phase 2E). The frontend detection below still runs but its replies currently go nowhere.
- Viewer detects AskUserQuestion / ExitPlanMode / Bash / Edit / Write from tool_use
- AskUserQuestion / ExitPlanMode: show prompt immediately (CC is waiting for user)
- Bash / Edit / Write: 5s wait for tool_result; if received → mark auto; if not → mark manual and show prompt
- Mode cached in memory (not localStorage), re-detected on page refresh
- tool_result arrival unconditionally closes prompt dialog
- Option card UI (arrow:N, type:N:text, escape) — the `arrow:`/`type:` protocol was tmux-nav; under headless it must carry the actual answer text (TODO)
- Real-time tool_result (OUT) appended (tool-grid structure + collapsible)

### Image Sending
- S3 upload + `![](claude-bridge:key)` protocol
- Bridge downloads → replaces with absolute path → CC Read tool reads it
- Multi-image staging + gallery + paste support

### File / Video Preview (click a file link in a message)
- Click file link → `openFile()` → WS `request_file` → bridge `handleRequestFile` (`ws.mjs`) reads from disk.
- Text/image: bridge base64s + POSTs to Lambda (`/upload-file` → `files/{key}`, `/upload-image` → `images/{key}`), replies `file_ready {key}`; frontend GETs `/api/bridge/file|image/{key}` (served base64-as-text from S3). Binary text files (NUL byte in first 8KB) → `binary file` error.
- **Video** (`.mp4/.m4v/.mov/.webm/.mkv/.avi`, ≤5GB): base64-through-Lambda is impossible (API GW 6MB limit), so the bridge **streams the file straight to S3** via a presigned PUT. `POST /video-prepare {key}` → server HEADs `videos/{key}`: exists → `{exists:true}` (skip upload, dedup by content-hash key so it survives bridge restarts), else returns presigned PUT URL → bridge `fs.createReadStream` piped to `fetch(PUT, {duplex:'half'})` (flat memory regardless of size). Bridge replies `file_ready {video:true, key}`; frontend calls `GET /api/bridge/video-url/{key}` for a short-lived presigned GET URL and plays it in a `<video>` element streaming directly from S3 (Range/seek supported). No CloudFront/IAM change — Lambda already has S3 Get/Put; presigning uses those creds.

### Session Launch (headless)
- Existing session with no live CC process → `_pool.send` spawns a headless `claude -p --resume <id>`; the persistent process becomes the single writer. No tmux, no wait-for-ready, no trust-dialog handling (headless inherits the folder's trust state).
- Idle reap (10min) + LRU cap (16) manage the pool; a reaped session re-spawns with `--resume` on the next message, context intact. (No more `cleanStaleSessions` / `apeek_*` tmux naming — all deleted in Phase 2E.)
- **TODO — New Session ("+ New Session" button, `send_message` with only projectHash):** currently returns "not available yet". Wire headless spawn WITHOUT `--resume`, take sessionId + cwd from `system/init` (mind the symlink-cwd trap), then return to Viewer for subscribe.

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

## Live State (headless native — was "tmux capture-pane Live State")

CC has many intermediate states not written to jsonl (thinking animation/content, permission
waiting, tool progress). The old plan was to scrape them with `tmux capture-pane`. **Headless
delivers them natively** as stream events (`content_block_delta` text/thinking, `control_request`
for permissions, `result` for turn end) — no pane scraping needed. What's already wired: typewriter
text preview (`stream_delta`), turn-end (`stream_end`). What's TODO: surfacing permission
`control_request` to the app (see Phase 2E), optional thinking-block streaming.

## Stall Rescue — REMOVED in Phase 2E (headless makes it unnecessary)

The old problem: a multi-question AskUserQuestion (tab-bar wizard `☐ header1  ☐ header2  ✔ Submit`)
held its entire tool_use in CC's memory and never wrote it to jsonl until Submit, so the bridge
saw nothing and the session looked permanently `running`. The tmux workaround (`stall.mjs`
`checkStalledSessions` + capture-pane wizard detection + Escape to force-flush + hiding the
synthetic rejection pair in `watcher.mjs`) is **deleted**.

Under headless this can't happen: CC pushes the full `questions[]` up front via a `control_request`
(`requires_user_interaction`), so the bridge has the complete question immediately — no pane
sampling, no force-flush. **TODO:** wire that control_request to the app prompt (part of the
Phase 2E permission bridge). `stall.mjs` currently keeps only inert arm/rescue-state stubs so
`watcher.mjs`'s synthetic-pair filter still imports cleanly; both are removable once the permission
bridge lands. `watcher.mjs` still tags a `stallRescued` tool_use, but nothing arms it anymore.

## Known Issues / TODO

- **WS oversized messages**: API Gateway WS single-frame cap is **32768B** (not 128KB — exceeding it drops the whole connection with close code 1009 → reconnect storm + hundreds of stale ConnectionsTable entries). Fixed: `watcher.mjs` checks the WS envelope size; oversized messages send a **truncated copy** over WS (`truncateToBytes()` in `extract.mjs`, byte-aware so CJK/emoji keep a real prefix; carries `truncated: true` + `noCache: true`) for real-time display, and the **full copy** over HTTP to DDB. `bridge_ws.py` skips the DDB cache write when `noCache` is set so the truncated WS copy never clobbers the full HTTP copy. `uploadMessages()` also caps every message to `DDB_ITEM_LIMIT` (360KB) so the 400KB DDB item limit can't be exceeded. Limits: `WS_FRAME_LIMIT`/`DDB_ITEM_LIMIT` in `config.mjs`.
- **VS Code CC status precision**: VS Code extension launches CC without `--resume` flag, cannot precisely match session. Uses mtime heuristic (5 min timeout → stopped). terminal-launched CC (with `--resume`) unaffected.
