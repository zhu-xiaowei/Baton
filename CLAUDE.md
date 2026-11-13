# Baton — Project Context

## Workflow Rules

- **Plan before code**: All code changes must be preceded by a detailed proposal (which files, what changes, why). Only modify code after explicit user confirmation.
- **Concise comments**: Keep code comments minimal — only what's necessary to understand non-obvious logic. Detailed design/architecture notes belong in CLAUDE.md, not inline.
- **Browser regression evidence workflow**: For ordering, missing-message, duplicate-message,
  recovery, or spinner regressions, first enable DevTools Preserve log and export the complete HAR.
  Copy the untouched HAR locally, extract every WebSocket frame and every messages API response,
  then replay the exact captured payload through the real frontend test harness until the browser
  result is reproduced exactly. Only after that may the root cause be reported or business code be
  changed. Keep HARs and extracted diagnostics local and untracked; never commit API keys or other
  captured credentials.

## What is this

Baton is a cross-platform app + bridge + server that lets you view local agent sessions from
your phone or desktop. Claude Code supports viewing and interaction; Codex supports history,
real-time monitoring, and interaction with existing Sessions. Three components:

1. **bridge/** — Node.js script running on macOS/Linux/Windows (always-on, auto-start), normalizes Claude Code and Codex JSONL
2. **server/** — AWS Lambda (FastAPI) + WebSocket API GW, relays between bridge and app (DynamoDB holds only connection, device, token and notification rows)
3. **web/ + src-tauri/** — Static HTML/CSS/JS frontend, packaged as native app via Tauri v2 (Android/iOS/Desktop)

Brand name "Baton" is only in user-facing places. Internal code uses generic names so renaming is easy.

## Core Design Principle

**The Bridge's local JSONL is the only source; reads and pushes go over the direct channel:**
- The App asks each Bridge for lists, history, threads and tool details over the direct RPC channel;
  the Bridge pushes real-time rows, streaming previews and permissions to subscribers.
- Nothing about Sessions or messages is stored server-side.
- The App caches what it has shown in IndexedDB / localStorage (plus local auth/nav state).

## Current Status

### Phase 1: COMPLETE ✅
- bridge.mjs watches .jsonl files, detects new messages in real-time
- Deployed to ap-northeast-1 (Baton), verified 300+ sessions

### Codex Phase 1 + Phase 2: COMPLETE
- Runtime adapters discover Claude Code and Codex into one Device → Project → Session catalog.
- Codex history is read on demand from the local rollout files.
- Codex uses `codex:<nativeSessionId>` storage IDs and the existing Claude-compatible project hash.
- Runtime icons and normalized message/tool rendering are complete.
- Codex watcher monitors every configured `CODEX_HOME/sessions` root and pushes append-only
  updates to subscribers with the same watermark semantics as Claude.
- Codex rollout-only status updates support `running`/`completed`; interaction resume recovers
  daemon-owned approval waits even though the startup catalog cannot infer them from JSONL alone.
- Codex Phase 3 interaction prefers the managed app-server Unix WebSocket when present and falls
  back to `codex app-server --stdio`: existing Sessions use `thread/resume` + `turn/start`; new
  Sessions use `thread/start` + `turn/start`. A resumed active turn is adopted so pending approvals
  and later deltas keep streaming; a new user turn waits in the same per-session queue.
- Codex and Claude share `StreamFramer`: first delta is immediate, later deltas use the same 50ms
  batch window, while `LiveTurnStream` assigns the turn-level `seq`. The frontend uses
  `TurnEventQueue → StreamCoordinator → StreamingDomRenderer` for ordered consumption,
  authority reconciliation, and progressive reveal.
- Codex user/assistant live rows are pushed immediately; the rollout watcher does not push matching
  rows again and remains the fallback when no live row was observed.
- Codex command/file/permissions/MCP approval variants are implemented. Automatic pending-request
  recovery immediately after a Bridge restart, before any send resumes the thread, remains Phase 3 work.
- Detailed status and validation: `docs/codex.md`.

### Phase 2A: COMPLETE ✅ — Backend + API Verification
- WebSocket API Gateway + relay (subscribe, broadcast, heartbeat)
- Bridge WS connection + real-time push
- Web viewer (web/) with dark theme, diff2html, markdown, file badges, Agent stats

### Phase 2B: COMPLETE ✅ — Send Messages + Images + Device Routing
> ⚠️ Originally built on tmux send-keys; **superseded by Phase 2E (headless)** — tmux is deleted. The image/device pieces below still stand.
- Message sending (was tmux send-keys → now headless stream-json pool, see Phase 2E)
- Permission prompt detection + approval UI
- Image upload via S3 + `baton-bridge:` protocol
- Auto-create regular sessions through headless `--session-id`
- Device routing for multi-bridge setups

### Phase 2C: COMPLETE ✅ — Native App (Tauri v2)
- Tauri v2 wraps web/ as native app, zero web code changes
- Android, iOS (TestFlight), macOS builds

### Phase 2D: COMPLETE ✅ — Claude Agents Support
- Bridge discovers agent identity through `claude agents --json --all`; roster.json determines active daemon ownership, while jobs/state.json only supplies the current blocked question
- Agent sessions display [Agent] badge + Working/Needs input/Completed status
- Send messages to agent sessions: was `claude agents` TUI navigation over tmux; **now headless** `claude -p --resume <agentSessionId>` handles agent sessions like any other (works via `_pool.send`)
- Create new agent sessions from the New Session view through detached `claude --bg`
- Bridge respects permissions.defaultMode: bypassPermissions (no false permission prompts)

### Phase 2E: COMPLETE ✅ — tmux removed, headless is the only send path
**tmux is fully deleted.** The entire send/permission/launch stack now goes through
the headless stream-json process pool (`bridge/headless.mjs` `ClaudePool`). Do not
reintroduce tmux; extend the pool for future Claude interaction work.

Done:
- **`bridge/tmux.mjs` deleted entirely** (send-keys, capture-pane, launch, TUI nav, wizard detection, `hasTmux`, stale-session cleanup).
- `projectHashToPath` moved into `session.mjs` (pure path util, not tmux). `getClaudeProcesses` was tmux-only and dropped — `getRunningInfo` in `session.mjs` has its own `ps aux` parser.
- Server bridge-install script (`/api/install`) no longer auto-installs tmux.
- Existing-session send → headless streaming (`handleHeadlessSend` → `_pool.send`), the primary happy path. Works today.
- **Stream ordering** — `stream-framer.mjs` only batches UTF-8-safe incremental chunks and block
  boundaries. `LiveTurnStream` is the single shared-event outlet and assigns one contiguous,
  turn-local `seq` across user authority, blocks, deltas, tool input, permission events, authority
  messages, and terminal `stream_end`. `TurnEventQueue` consumes only contiguous `turnId + seq`;
  `StreamCoordinator` owns turn/block state and authority reconciliation; `StreamingDomRenderer`
  applies operations without rebuilding correct DOM. Late join resumes at `seq=1 messages(user)`,
  the next complete block/permission checkpoint, or terminal authority. See
  `docs/streaming-render-design.md`.
- **Reply placement by turn identity** — Web generates `turnId` before send and stores it directly
  on the optimistic user bubble as `data-anchor`. Bridge and Server preserve the same `turnId` on
  every shared event and `send_message_result`; the renderer locates the exact anchor without
  `clientId/streamId` binding, text matching, timestamp ownership, or nearest-pending heuristics.
  Authority uses UUID/native ID to confirm or patch nodes inside that same turn.
- **Permission bridge DONE** — `onControlRequest` → app `permission_request {kind:tool|ask|plan}`; `handlePermissionReply {requestId, decision, answerText}` → `_pool.replyControl`. Ordinary tools allow/deny; AskUserQuestion/ExitPlanMode answer via **deny + answerText in `message`**, which every CC version understands (2.1.211 force-converted a structured answer to deny; 2.1.322 accepts `allow + updatedInput.answers`, not used); cancel = deny + `interrupt:true`. Answer renders in the tool-card OUT (green), cancel shows warning (yellow). A still-pending control_request is pushed again on every Bridge subscription (direct `subscribe`). Frontend `web/js/components/permission.js` fully rewritten (old `arrow:`/`type:`/`escape` protocol + client-side heuristic detection deleted).
- **New Session / new agent / create project DONE** — regular sessions mint a UUID, acknowledge
  it before spawning headless with `--session-id`, and then stream the first turn. Background
  agents launch through `claude --bg`. Creating a project creates its directory and enters the
  new-Session input view.
- **Stall Rescue + `stall.mjs` fully deleted**; `command_output` (tmux capture) path deleted (bridge/server/frontend); `streamMode` flag deleted; `permissions.mjs` + `needsPermission` + per-directory permission reads deleted.

### Multi-harness H0: registration points (no new runtime yet)
- `runtime-registry.registerRuntime(adapter)` adds a runtime beyond claude/codex; `session-identity` keeps
  the descriptors (storage id `<rt>:<native>`, claude unprefixed, unknown runtimes are `null`/`unknown_runtime`,
  never claude). A descriptor may carry `module` (its own URL; the index, history and tool-details workers
  import it), `catalog` (`kind:'file'`: files/match/newState/advance/summarize/view/status/running?;
  `kind:'rows'`: watchPaths/refresh(cursor)/view/status), `history(target)` (a reader), `messages(file, id)`
  (tool_details), `watcher`, and `interaction.listCommands/heldElsewhere`. `SessionIndex.touch()` dispatches by
  source; rows sources refresh at once and a change seen mid-refresh triggers one more pass (no debounce).
- Shared modules for H1–H5: `rpc-stdio.mjs`, `turn-process.mjs` (exit on Done: close step → EOF; SIGKILL of the
  process group only after 30 s; pid + start-time ledger), `runtime-bin.mjs`, `sqlite-ro.mjs` (+ `RowIndex`).
- App: `web/js/runtimes.js` (labels, icons, resume commands), the new-session runtime picker (from `ping.runtimes`,
  the runtimes that can create), generic tool card (source badge + name + key argument, key/value body),
  `system_event.icon` rows, generic `<rt>_active_writer` takeover dialog. History rows may carry `noAlert`
  (no Done alert for a turn a takeover, exit or parent ended).
- Bridge needs Node ≥ 22.15 (`node:sqlite`, zstd); install scripts refuse older Node, auto-update skips a package
  whose `engines` the running Node does not meet.

### Multi-harness H4: Pi (≥ 1.0)
- Files: `pi-catalog.mjs` (catalog, current-branch history, row mapping; worker-safe), `pi-runtime.mjs` (detect,
  adapter, watcher), `pi-interaction.mjs` (`pi --mode rpc`), `pi-approval-ext.mjs` (passed with `-e`),
  `pi-status-ext.mjs` (installed). Listed in `OPTIONAL_RUNTIMES` when the agent dir exists; `pi` ≥ 1.0 is found on
  first use; a JS entry (`.js` or a node shebang) runs as `<node ≥ 22.19> <realpath>` (`pickNode`), a wrapper
  script runs as it is. An exception in the RPC event handler ends the turn, not the Bridge.
- Catalog: `$PI_CODING_AGENT_DIR/sessions/**.jsonl` (default `~/.pi/agent`); project from the header `cwd`; title
  `session_info.name` > first user text. History follows `parentId` from the last entry; an entry that does not
  continue the previous one bumps the epoch (`historyReset`). One `edit` call with N edits = N Edit cards (`<id>#i`).
- Status: the Bridge installs `<agent dir>/extensions/baton-bridge-status.js` when its watcher starts (content
  compared, atomic rename; removed on device removal). Every pi process writes
  `~/.baton-bridge/pi-status/<sid>.<pid>.json` (`idle/running/waiting`; `waiting` = `ui_prompt_start` →
  needs_input); a dead pid or another start time is stale. The same file holds the fork guard: a terminal whose
  loaded leaf is not the file's last entry refuses input until `/baton-reload`.
- Interaction: one process per Session, ended on `agent_settled` (never `agent_end`) by EOF. Sends during a turn are
  `prompt{streamingBehavior:'steer'}`; interrupt = `clear_queue` + `abort` (the extension passes `ctx.signal`, so a
  waiting dialog ends too). Each prompt starts with `<!--baton:<turnId>-->`; the approval extension strips it and
  stores `batonTurnId` on the user message, so live and stored prompts are both `live:user:<turnId>`. Other rows:
  uuid = nativeId (`pi:assistant:<ts>`, `pi:tool:<callId>`). Images go in the RPC `images` field. Tool calls are
  streamed whole at `toolcall_end`, already mapped.
- Dialogs: `baton:permission` confirm → `kind:'tool'` (session grant `bash:<prog [sub]>` / tool name, kept in
  `~/.baton-bridge/pi-grants.json`, read by the extension on every call); `ask_user` (Baton's tool; `multiple:true`
  rides on `input('baton:multiselect')` and answers a JSON array) and user-extension select/confirm/input → `ask`.
  A bash command with any shell syntax beyond plain words, or behind a wrapper (`timeout`, `env`, `sudo`, …), gets
  no grant and is asked every time. One edit call with several edits is approved on one joined diff.
- Writer conflict: a status record of another live pid on the Session → `pi_active_writer` (only `mode:'tui'` may
  be terminated). Delete and rename refuse while busy or held; rename appends a `session_info` entry on the last entry
  (the catalog keeps its id, so nothing is re-read).

### Git Graph + Commit/Push: COMPLETE
- Git page header shows `project › branch ↑N ↓M` from the existing porcelain status; the branch text is display-only.
- Graph (below Changes, collapsed by default) draws real parent topology with an incremental lane layout
  (`web/js/git/graph-layout.js`); scope is Auto (HEAD + upstream) / All / one branch and never checks out.
- Everything stays on the `git_status` action: read-only `refs` / `history` / `commit_files`, commit-target `diff`,
  and `commit` / `push`. History pages over fixed head OIDs with `--topo-order` + `--skip`; commits and file lists
  share a first-parent base; subdirectory projects are scoped with pathspec / `--relative`.
- Commit only takes the staged set the user saw (`stagedId`); push never forces, publishes with `-u origin`, and fails
  fast on SSH prompts. The commit bar is one state-driven button (Commit / Push / Publish).
- Graph view state, the first page per scope and the branch list reuse the Changes IndexedDB cache
  (stale-while-revalidate). Checkout / Stash & Switch / Pull are deferred. Details: `docs/git-history-design.md`.

### Mobile Notifications: COMPLETE
- Finished runs and `needs_input` alert as **project · session** + summary; tapping opens the session.
  One Settings switch (default on). Local `tauri-plugin-push`: iOS registers with APNs;
  Android runs a foreground service ("Baton is running in the background") polling the event
  feed natively (5s foreground / 15s background; WebView timers are throttled in background).
- Bridge decides and words every alert (`bridge/notify.mjs`, from the rows `reportSessions` sees;
  each approval is `needs_input` + `agentDetail`) and posts it to
  `POST /api/notifications/events`, which stores the feed row and calls the push relay; while the
  server is unreachable it keeps the newest alert per Session (at most 10, 10 minutes). Devices are
  one `PUSH_DEVICE` row per `<environment>:<token>`. Before alerting it skips interrupted turns
  and sessions a visible, focused page is viewing (`notify_check` push → `notify_seen` request
  within 3 s, to the pages subscribed under the root).
  A turn started outside Baton also skips while the user is at that computer: Bridge attaches
  `localIdleSec` (`presence.mjs`: own pty atime, macOS `HIDIdleTime`, Windows Interactive helper
  task) and Bridge drops it under 120 s. Sessions Baton has driven (`batonSessions`), daemon
  agents and Baton's own terminals never set it, so their alerts are unchanged.
- iOS pushes carry only the event's feed key and a placeholder; the `NotificationService`
  extension fetches the text from the user's own server (`/api/notifications/event`, credentials
  in the shared `$(AppIdentifierPrefix)com.batonai.shared` keychain group). They go through the shared, stateless APNs relay
  (`push-relay/`, own AWS account, IAM-auth Function URL, holds the APNs key); stacks only know its
  URL (`PushRelayUrl`, `PUSH_RELAY_URL` for install.sh). The release script keeps the extension's
  CFBundleVersion in step with the app's. Device Farm public iOS devices strip the push entitlement. Details:
  `docs/mobile-notifications.md`.

## Deployed Environment

**API URL and API key live in `.env.local` (gitignored). When you need them,
read that file** — do not hardcode them in committed code. Variables:
`BATON_API_URL`, `BATON_API_KEY`. See `.env.local.example` for the
template. S3 bucket / ECR repo / AWS account id are derived automatically by
`server/install.sh` from the stack name + `aws sts get-caller-identity`.

- **Region**: ap-northeast-1
- **Stack**: Baton
- **DDB Tables**: `Baton-connections`, `Baton-system`
- **Deploy**: `cd server && ./install.sh --region ap-northeast-1 --stack Baton`

## Key Technical Decisions

### Bridge
- Watches `~/.claude/projects/<project-hash>/<session-id>.jsonl`
- `readableProjectName()` resolves hash back to real path by walking filesystem
- `preview` / Session title: `custom-title > ai-title > summary > first prompt > last-prompt`, in
  the Bridge list and the open-Session title alike. CC's resume list puts `last-prompt` first;
  Baton deliberately does not follow it. Until a Baton-created Session's transcript has a
  prompt (a forked Skill writes none until it finishes), the Bridge uses the prompt it sent.
- Filters: skips empty/no-preview files, subagent sessions
- Session `status`: **three-state** (`running`/`needs_input`/`completed`), one field, no
  parallel `agentState`. Displayed as Running (green) / Needs input (amber) / Done (grey).
  Three sources map into this single enum:
  - **busy pool-owned (headless)**: pool lifecycle events report status through `reportSessions`
    — `_pool.send` → `running`; `control_request` → `needs_input`; turn `result` →
    `completed` (or `needs_input` if a control_request is still pending). `ws.mjs` `syncPoolStatus`.
    Every turn end is `completed`, background tasks or not. A `completed` write also carries
    `backgroundAgents` while background agents still run (the pool's `local_agent` tasks, else
    CC's own `~/.claude/sessions` record reading `busy`, re-read after 1 s); Bridge's notifier skips
    that Done, so only the report-back turn after the last agent alerts, and a hold released
    without a running write in between (`heldForAgents`) alerts the last reply. Background Bash
    and Monitor never hold it: CC does not mark long-running ones (servers, persistent Monitors),
    so each Bash report-back turn alerts. Alerts stack per session (iOS thread, Android group).
    A `control_request`
    outside a pool turn (a background agent, or a turn CC started itself) goes to the pool's
    `onControlRequest`, so it still reaches the app as `needs_input` instead of blocking CC forever.
  - **external CC** (terminal/VS Code, not pool-owned): `getSessionStatus()` (startup sync +
    `checkStopped`) first uses CC's own `~/.claude/sessions/<pid>.json` record
    (`busy`/`waiting`/`idle`/`shell` → running/needs_input/completed/completed; terminal since
    2.1.119, SDK/VS Code since 2.1.269), trusted only for a pid listed as a claude process and,
    on Linux, the same `procStart` (killed processes leave records behind; Windows skips it).
    Without a record, it and the watcher's `statusFromEntry()` read the jsonl tail `stop_reason`
    (`tool_use`/null → running; structured `AskUserQuestion`/`ExitPlanMode` → `needs_input`;
    `end_turn`/interrupt/no-process → `completed`).
  - **daemon agent**: while its worker is present in `roster.json`, `mapAgentState()` maps
    `--json` working/blocked/done → running/needs_input/completed. Inactive historical
    `--all` entries preserve agent identity only; status falls back to process + jsonl.
  - Precedence when a session matches more than one source: **busy pool-owned >
    roster-active daemon agent > external/jsonl**.
    watcher/`checkStopped` skip status writes for busy pool-owned (`poolOwns()`) and daemon-agent sessions.
  - **subagent threads**: a root row shows the *effective* status (own status OR any child
    `runningAgentCount`/`needsInputAgentCount`). An interrupted subagent's tail stays
    non-terminal forever, so unless `.meta.json` says `finished:true` (CC never writes `false`) a
    child trusts its tail only while its parent's own status is running (CC stays `busy` while
    foreground or background subagents run) or it was written in the last 15s. A stopped agent never
    gets `finished:true`, so a child is also completed when its spawner's transcript last reports
    it in a `<task-notification>` rather than a later `resumedAgentId`. Only CC's own rows count
    (`claudeTaskEvent()`: enqueued notifications, notification prompts, `SendMessage` results), not
    tool output quoting them; `claudeSubagentEnded()` scans incrementally; the watcher rechecks active children when that notification is appended. `inspectActiveSession()`
    re-derives the counts on every `checkStopped` pass and reports them, because the notifier
    treats missing counts as "unchanged".
  - `getRunningInfo()`: `ps aux` + `--resume` arg extraction → exact session ID + project cwd
    (used by external detection). VS Code CC (no `--resume`) → project-level + mtime>5min → completed.
- `projectHashToPath()` (in `session.mjs`): reverse hash to real directory path (validates each segment exists)
- Claude Agents support:
  - Agent identity source is **`claude agents --json --all`**. Its working/blocked/done state
    is authoritative only while `roster.json` still contains that worker; stopped or
    headless-taken-over agents remain in `--all` with stale state indefinitely, so they keep
    `isAgent`/name but derive status from process + jsonl. `getAgentsJson()` caches the resolved
    catalog for 3s and returns the last-good cache on CLI failure. Filter to
    `kind === 'background'`; `kind:"interactive"` entries are not agents.
  - `agentDetail` (the blocked question shown on the card) is the ONE field still read from `jobs/<sid[:8]>/state.json`'s `needs` — `--json`'s `waitingFor` is almost always null.
  - `getDaemonRunningSessionIds()`: reads `~/.claude/daemon/roster.json` → active worker sessionIds (still used to detect a done-agent resumed as a normal CC session).
  - Agent status poll (`watcher.pollAgentStates`, every `AGENTS_POLL_INTERVAL_MS`): diffs `getAgentsJson()` vs `_jobsState`, pushes changed agents. Empty `_jobsState` on startup → first poll reports every agent (covers every version-update restart). Replaced the old `fs.watch(state.json)` (missed transitions since state.json lags).
  - Status paths that key off live CC processes (`checkStopped`) skip roster-active daemon
    agents and busy pool-owned sessions. Precedence: busy pool-owned > roster-active daemon >
    external/jsonl.
  - Worktree project-hash normalization: a session that `cd`s into `<proj>/.claude/worktrees/<name>` has its jsonl moved to a new project dir, which would list one sessionId twice. `normalizeProjectHash()` strips `--claude-worktrees-*` wherever a Session row is built (keeps real hash for on-disk reads) → one session, one row, under the parent project. See `docs/claude-code-bridge.md`.
  - Send to agent / new agent / reveal pending input: existing agents resume through headless `claude -p --resume <agentSessionId>`; new agents launch through `claude --bg`; pending `control_request` state is pushed again on every Bridge subscription.
  - Permissions are enforced by CC itself (bypass mode → no prompt); the bridge no longer reads settings — see the Permission Detection section.
- Slash commands are runtime-aware. Claude's primary catalog comes from the current CLI's
  no-persistence `initialize` control response, including environment-filtered commands, descriptions,
  argument hints and model choices. `commands.mjs` only scans custom commands and Skills as an
  old-version fallback; there is no static Claude built-in list. `/usage`, `/cost`, `/stats`, `/status`,
  and bare `/config` open the local four-tab Settings panel. Codex uses `codex-commands.mjs`: the mobile
  catalog starts from the complete 44-command popup observed in Codex 0.147, then preserves that
  presentation order while filtering only commands without a complete phone equivalent. The
  current macOS Bridge exposes 33 built-ins; Linux exposes 32 because `/app` is host-platform
  specific. IDE/TUI presentation commands, `/approve`, `/side`, and `/plugins` are filtered.
  `$CODEX_HOME/prompts/*.md` legacy prompts are appended in name order.
  Codex Skills come from app-server `skills/list`; selecting one composes `$name`, and
  `turn/start.input` carries the matching structured Skill item. The app preserves Bridge order
  and caches by device + runtime + project. Details: `docs/api.md` + `docs/codex.md`.
- Config: `~/.baton-bridge/config.json`, auto-created from CLI args. Without a `wsUrl` the Bridge
  asks `/devices` for it at start (every 10 s until it answers) and keeps it there.
  - Tool previews are always enabled; historical `toolPreviews` settings have no
    effect. Clients use `tool_details` to load full content from the original JSONL.
- Always-on: launchd (macOS), systemd user service + `loginctl enable-linger` (Linux), Task Scheduler (Windows)
- Deployed bridge runs from `~/.baton-bridge/` (copied), NOT the workspace `bridge/`. Local dev: `cp bridge/*.mjs ~/.baton-bridge/` + restart service.
- Auto-update: startup and WebSocket reconnect check `/api/version` once. Existing four-minute heartbeat replies include `bridgeVersion`; only a different non-dev version triggers another check, so normal heartbeats add no REST requests and there is no dedicated update timer. On change, Bridge resolves the S3 package through `/api/install`, stages and validates it, then restarts even with active terminal sessions. Existing terminal/agent processes may be interrupted; they do not defer updates. Checks never overlap and network requests have timeouts. `install.sh` uploads the Bridge package before exposing its version through CloudFormation; both API and WS Lambdas receive `AppVersion`. Bridge WS connections report `bridgeVersion` for fleet verification.
- `/api/version` reads `APP_VERSION` env (= semantic + git hash, set per build). Managed by CFN (`AppVersion` param in template, passed by install.sh). Lambda env overrides image ENV, so the CFN param MUST stay wired or the version freezes and auto-update silently stops.
- v2 lists (home, projects, sessions) are answered by `session-index.mjs` from memory, warmed at startup:
  2 workers read each JSONL's head and tail only (Codex back to its last turn
  start; Claude's last 1 MB, where CC re-stamps titles) (`session-summary.mjs`,
  `docs/v2-step2-lists-plan.md`). Watchers call `touch()`; appends read
  only the new bytes.
- Startup: merge all runtime catalogs, report every Session row (`reportSessions` in `sync.mjs`:
  status cache + notifier, nothing is sent to the server) and set each Session's in-memory cursor
  to the end of its file; history is read from the files on demand.
- Periodic check: `checkStopped()` runs once after the session index warms up, then every
  `CHECK_STOPPED_INTERVAL` (10 min). Candidates are running/needs_input entries in
  `lastKnownStatus`, matched to session-index roots; disappeared CC processes (`ps aux`) →
  `completed` (skips roster-active daemon agents + busy pool-owned sessions)
- Watcher: fs.watch detects jsonl changes → pushes new rows to subscribers; reports metadata only on status change, new session, or ai-title
- Status cache: `lastKnownStatus` holds the last reported status per Session (`checkStopped` candidates; changes invalidate list answers)
- Debounce: busy Map per session dedup fs.watch duplicate events
- Line-number tracking per session (not UUID set), lightweight
- Images: sharp compress 1280px JPEG (quality=90) → HEAD, then signed PUT to the transfer area
  (remembered per process for a day) → store key in message

### Server
- FastAPI in Docker Lambda, API Key auth. API Gateway checks `x-api-key` on `/api/*`; WS
  `$connect` compares `?apiKey=` with the deployment key, which both Lambdas read from API Gateway
  by name (`server/src/api_key.py`, cached 5 min; a failed lookup keeps the last value, and with no
  value REST/WS answer 503 rather than guess an account) — the key is
  never stored in a table. Their IAM `apigateway:GET /apikeys` can read every key in the region:
  the API key depends on the stage and so on the API Lambda, so the Lambdas cannot `Ref` its ID.
- `accountId` = SHA256(apiKey)[:16] — raw key never stored. `install.sh` pins it as the
  `AccountId` stack parameter (deploy stops if the key cannot be read), and only the current key
  maps to it; any other key still gets its own empty account. `install.sh --rotate-key` skips the
  build and keeps the deployed template and every other parameter, passing only a new
  `ApiKeyName` (`<stack>-api-key-<timestamp>`), so CloudFormation replaces the key (an API key's
  value cannot be changed in place) and the data stays; every device then signs
  in with the new Start URL. WebSockets opened with the old key are not closed (API Gateway ends
  them within 2h).
- Sign-in / install tokens: Setup's Start URL, QR code and install command
  (`/auth/install?t=…`) share one token from `/api/auth/start-token`, valid 10 minutes (deploy
  output: 12h) and reusable until then. Token rows name the key instead of holding it, so a rotated
  key retires them; `/auth/exchange-token` returns the current key.
- The key lives only in the Bridge's `~/.baton-bridge/config.json` (0600); service definitions no
  longer pass `--key`, and older ones are rewritten at startup.
- Removing a device (home long-press → `/api/bridge/delete-device`) sends `device_removed` and
  closes its Bridge sockets, then deletes its device row. The Bridge removes its
  launchd/systemd/Task Scheduler entry and `config.json`, then exits 0 (no restart). A Bridge that is
  offline at the time comes back and re-adds the device; remove it again.
- `install.sh`: ECR → S3 → CodeBuild (arm64) → CloudFormation
- Bridge install script (`/api/install`): exports `XDG_RUNTIME_DIR` for Ubuntu SSH compatibility (tmux auto-install removed in Phase 2E)
- File transfer area: files between App and Bridges travel through `t/<accountId>/<key>` in the
  attachment bucket, emptied by a 7-day lifecycle rule (`install.sh`; the pre-v2 prefixes
  `images/`, `files/`, `videos/`, `attachments/` expire after 1 day). It is a transfer channel, not
  storage: the Bridge can upload any object again from its own disk. App and Bridge sign their own
  S3 requests (SigV4 presigned URLs, `bridge/transfer-store.mjs`, imported by the App too) with the
  direct-channel STS credentials (1 h, reused while > 10 min left), whose session policy adds
  `s3:GetObject`/`s3:PutObject` on `t/<accountId>/*` only. `storage {bucket, region, accountId,
  accelerate}` comes with them: the App from `/devices` (always, with `wsUrl`), the Bridge from its
  control-socket `direct_rpc` `credentials` message; both renew on demand, and no URL outlives its
  credentials. The API Lambda only reads `install/*`. Attachment uploads use S3 transfer
  acceleration when enabled (accelerated URL + standard fallback).

### Message Flow (Bridge JSONL + direct channel)
- Watchers push new rows to the Session's subscribers over the direct channel; rows a live turn
  already pushed are not pushed again when the JSONL copy is written. History is read on demand.
- Bridge extracts: uuid, parentUuid, type, content, timestamp, toolUseResult
  (drops model/usage/cwd/version). Tool IN/OUT always keeps
  the first 500 Unicode characters per text field, Edit keeps paths and status,
  thinking signatures are omitted, and `toolUseResult` keeps only numeric Agent
  duration/tool-count statistics. Failed Edit results retain their error preview.
  This same prepared representation is reused for history, watcher pushes and live authority;
  a module-local WeakSet skips repeated processing of the same message object.
- Block-level `truncated` means on-demand tool content, independently of transport
  truncation/recovery. A final structured input event replaces any incomplete
  streamed JSON preview when its block stops. `tool_details` reads original JSONL
  in a worker with a single-file, file-version-keyed tool index and answers over the
  v2 direct RPC (`preview: true` returns the 500-character previews history pages omit). The frontend
  caches complete details per device/session/tool; missing expected output is
  retryable. Failed detail loads expand the available local preview. See
  `docs/tool-preview.md` for the rendering and rollout contract.
- Content blocks preserved: text, image (compressed), document, thinking, tool_use, tool_result
- App opens session → `history` from the Bridge (IndexedDB cache first) + a direct `subscribe`;
  `history {subscribe: true}` registers the caller before the file is read
- Pushes buffer during the history load → merge/dedup → resolve running state from newer applied
  lifecycle events or the history `status` → render → subsequent pushes append directly
- A history snapshot replaces the local tail, except live prompts (`live:user:` Claude,
  `codex:user:` Codex) newer than the snapshot's last non-metadata message and absent from it:
  those rows reach history only once the JSONL/rollout has them under the same
  identity, so dropping them made the sent message vanish mid-turn. Other live rows are not kept —
  e.g. `live_interrupt_*` persists under its native UUID after a Bridge restart and would
  duplicate (`history-snapshot.js` `replaceHistoryTail`). When a snapshot still drops live rows
  (e.g. refresh while the final reply is revealing, before the watcher persisted it), the
  existing turn-end recovery re-fetches; a merged `completed` with no outstanding turn clears
  the spinner.
- Claude's live interrupt is sent on ESC, but CC flushes the partial reply after acking it. A
  still-revealing block has no identity yet (`elementOrder` = newest), so an interrupt restored
  into a stream row is always appended last (`message-dom.js`), matching `createBlock`.
- The Bridge pushes to ALL app connections subscribed to a sessionId (multi-device)
- See `docs/claude-code-bridge.md` for full protocol and flow diagrams

## DynamoDB Tables

No Session or message data is stored server-side. DynamoDB holds only routing and account rows:

```
<stack>-connections  PK: connectionId — one row per WebSocket connection (role, accountId,
                     deviceName, …; GSI accountId-role-index) plus per-device Bridge owner rows
<stack>-system       PK: pk  SK: sk  (TTL: ttl)
  DEVICE#<accountId> / <deviceName>  — deviceName, deviceDisplayName, os, lastConnected
                                       (written by WS $connect once a Bridge claims its name;
                                       nothing is migrated: after the first v2 deploy a device
                                       is listed again once its Bridge reconnects, which the
                                       version update triggers within minutes for online ones)
  TOKEN / <token>                    — start/install tokens (name the key, never hold it)
  PUSH_DEVICE / <environment>:<token>, NOTIFICATIONS#<accountId> / <eventId> — notifications
```

## API Summary

### REST
```
GET  /api/bridge/devices                    — names, online, wsUrl, rpc routes + credentials + storage (counts come from each Bridge)
GET  /api/bridge/device-name/validate       — install-time device name check
GET  /api/install                           — bridge install script (sets up always-on service)
POST /api/auth/start-token                  — 10-minute token for Setup's Start URL / QR / install command
GET  /auth/install?t=…                      — install script for a token (public; the token stands in for the key)
POST /api/bridge/delete-device              — remove a device and make its Bridge uninstall itself
GET  /api/version                           — app and Bridge release versions
```

### Direct channel (v2, App ⇄ Bridge over the `app_data` / `bridge_data` sockets, no Lambda per frame)
```
home {revision?}              — devices' counts, active Sessions, 15 recent projects × 5 Sessions
projects {limit?, cursor?}    — project list page
sessions {project, limit?, cursor?} — session list page
history / threads / tool_details — Session view (`docs/v2-step3-session-plan.md`)
subscribe {sessionId, rootSessionId?, renew?} / unsubscribe — who receives a Session's pushes (150 s lease)
send_message {…}              — reply = send_message_result; `rpc_ack` on arrival is the receipt
interrupt, permission_reply   — reply {ok}
list_commands {projectHash, runtime, knownRevision} / list_command_options — catalog in the reply
project_files / git_status / delete_files — reply {frames} (the handlers' frames, collected)
rename_session, create_project — reply = the result
push: stream_*, messages, permission_request, permission_resolved, turn_replay,
      session_threads_changed (root subscribers), session_title_changed — to subscribers only
```
Shared request rules (`bridge/direct-rpc.mjs`): a request still running after 5 s sends
`rpc_progress` every 15 s (the App's deadline is 60 s after the last ack/progress); only
machine-heavy reads (`limitedRequest` in `ws.mjs`) count against 6 at once; a request carrying
`known` gets `fingerprint` (SHA-256 of the result, 16 hex) or `{notModified, fingerprint}`
(projects, sessions, threads, file list/browse, Git status/refs/history; `api.js` `requestFresh`,
`ws-rpc.js`). Tool details are kept in IndexedDB (`cache/tool-details-cache.js`, 20 MB LRU).
`api.js` calls them as `bridgeHome` / `bridgeDevices` / `bridgeList` / `bridgeHistory`; `direct-transport.js` owns the socket,
routes (`/devices`), retries, subscriptions and credentials. Frames are `action: rpc | push` with a
readable `method` / `event`. Full protocol: `docs/api.md`; design: `docs/v2-step3b-realtime-plan.md`.

### WebSocket (Bridge ⇄ server; the App opens no control socket since v2 stage 2a)
The Bridge's control socket carries only `heartbeat` and `direct_rpc` (data-socket binding); the
URL carries `device`, `name` (display) and `os`. Terminals and port previews are `stream` frames
on the App's one direct socket (`docs/terminal-direct-integration.md`), so opening one creates no
socket and calls no Lambda.
`device_removed` / `bridge_replaced` are pushed to it. No Session data passes through it.

Full protocol: `docs/api.md`

## Send Messages Architecture

Approach: **headless stream-json process pool** (`bridge/headless.mjs` `ClaudePool`). One
persistent `claude -p --input-format stream-json --output-format stream-json` process per
session, fed over a kept-open stdin. Single-writer per session → no jsonl double-write.
Replaced the old tmux send-keys approach (deleted in Phase 2E). Full design: `docs/headless-streaming.md`.

### Message Sending
- Viewer → direct `send_message` request → Bridge → `handleHeadlessSend` → `_pool.send` → CC stdin
- Streaming back: `stream_delta` (typewriter preview) + `stream_end`; full assistant/user
  lines arrive as authoritative `messages` (uuid-deduped against the jsonl copy)
- Optimistic rendering + dedup + timestamp update

### Reliable WS Delivery (app side, `web/js/ws.js`)
- **Sends must survive a dead socket.** A send is a direct request with a receipt (`sendToBridge`
  in `ws.js`): the Bridge's `rpc_ack` shows the bubble, the reply is the result. The transport
  (`direct-transport.js`) resends an unreceipted request every 3s, pings a socket that stayed
  silent for 3s after a request and rebuilds it after 3s more (iOS leaves suspended sockets OPEN
  but dead), and resends everything pending after the new `whoami`; the Bridge ignores a repeated
  `turnId`. A request that failed before its receipt is sent again on resync (socket or device
  back). The foreground history refresh is `fresh`:
  it replaces a still-open history barrier instead of reusing it, carrying its captured events
  over, because a request started before suspension may never settle.
- **Pushes are best effort; history is the truth.** The Bridge pushes Session events only to
  subscribed connections and neither queues nor confirms them. After a reconnect, a returning
  device or a restarted Bridge (`epoch` in the `subscribe` reply) the transport fires `onResync`
  and the Session reloads `history {after}`. A hidden page unsubscribes at once.
- **Lost app frames are recovered, not waited on.** One 60s tick while visible: the subscription
  renewal when a Session is open, else `{action:"realtime_ping"}` (answered by a MOCK route, no
  Lambda). A turn seq gap pings the direct socket; once its pong has arrived (socket alive and
  drained over the client link) and ≥3s passed, the frame is treated as lost and
  `refreshSessionMessages()` resumes the turn at the next checkpoint. A held `stream_end` keeps the
  gapped-end path. A running turn with no frame for 60s (no permission prompt) is checked against
  the history status; `completed` settles it and reloads the history as a snapshot, covering a lost
  tail or `stream_end` (the streamed blocks stopped where the frames were lost).
- **History rows rejoin their stream row by message order.** History rows carry no `turnId`, so
  untagged assistant rows between a turn's prompt and the next prompt belong to that turn's stream
  row; recovered children are inserted by message order, and class-only matching may reuse only a
  stream block without identity — in a turn that has not ended, only one whose text the history row
  continues, which the history then completes (`message-dom.js`).
- **No duplicate/stuck bubbles.** Each optimistic bubble carries a monotonic send `seq`. `reconcileEchoedPending()` (end of `updateLastTurn`) retires a pending when (1) its echo is present (covers echoes that arrived inside a history load, which `tryDedup` skips), or (2) `seq < lastDeliveredSeq` — a later send was already confirmed, so this earlier one was swallowed by a busy-CC send and never reached jsonl (echo never comes). `lastDeliveredSeq` is a persistent watermark bumped in `tryDedup`/`resolvePending(ok)`/echo-match, so orphan detection survives the confirmed pending being removed; reset with `pendingSentMessages` on every session switch. `isImage` bubbles are never auto-orphaned (attachments, no matchable text). Without this an orphan has no `data-ts` and sticks to the bottom forever. New-session banner: `body.new-session #content` is flex-centered, so `.ws-banner` is pinned `position:absolute; top:0` instead of being pulled to the middle.

### Scroll-to-bottom on session open (no flash / no "stopping short of the bottom")
- **Order matters: clamp BEFORE scroll.** `clampOverflow` collapses long messages (adds `.clamped` → max-height 4.5em), shrinking total height. Initial render clamps before scrolling. `state.stickBottom` is follow intent, not a near-bottom measurement: a real drag/wheel sequence clears it when the sequence starts. After the bottom button has been visible, its first visible→hidden transition immediately restores follow and scrolls to the physical bottom; later movement in that same gesture keeps following unless it leaves the hidden-button range again. Detect the transition inside the shared button updater because touch `pointermove` may observe the new `scrollTop` before `scroll`. A `ResizeObserver` on the current `.messages` container keeps real OUT/markdown/diff/image height changes pinned only while follow intent remains active, so deliberate upward scrolling is not overridden. Streaming never uses smooth scrolling because continuously arriving frames would compete with the animation.
- **diff2html is committed atomically.** `tool.js` renders and highlights each diff inside a detached staging element, then replaces the visible `.diff-container` children in one synchronous commit. The loading placeholder remains stable while the viewer module loads; users never see the zero-height/partially drawn diff, and no estimated height or resize observer is needed. After the commit and clamp, the view scrolls once only when `state.stickBottom` still records follow intent, so a user who scrolled upward during loading is not pulled back.

### Permission Detection + User Interaction (headless, bridge-driven)
- Bridge `onControlRequest` (CC's `control_request`, precise — no client-side heuristic) → app `permission_request {kind, requestId, questions?/plan?/input}`. App replies `permission_reply {requestId, decision:allow|deny|answer, answerText?}`.
- Ordinary tools (Bash/Edit/Write/MCP): allow → `control_response{allow, updatedInput}`; deny → `{deny, message}`. (`defaultMode:bypassPermissions` → CC never asks, no prompt.)
- AskUserQuestion/ExitPlanMode (`requires_user_interaction`): answer via **`{deny, message: answerText}`**, which every CC version understands (2.1.211 force-converted a structured answer to deny; 2.1.322 accepts `allow + updatedInput.answers`, not used yet). Multi-question wizard sends `question → answer` per line; a `multiSelect` question shows checkboxes + Submit and joins labels with `, ` (CC's own format). Every ask reply also carries structured `answers {questionId|question: [labels]}` (Codex `request_user_input` maps them per question). Cancel = `{deny, interrupt:true}` → `[Interrupted]`.
- "Yes, for this session": a Claude tool request with CC `permission_suggestions` (`addRules` allow) carries `sessionScope {label}`; the reply `{decision:'allow', scope:'session'}` answers with `updatedPermissions` destination `session` and stores the rules in `~/.baton-bridge/session-grants.json` (`session-grants.mjs`, dropped when the Session is deleted). CC keeps session rules only in memory, so every spawn passes them back as `--allowedTools`.
- Takeover (`writerConflict` in ws.mjs, Claude's from #205) also serves any adapter with `interaction.heldElsewhere`: `<rt>_active_writer {writer}` → confirm → SIGTERM only that pid; such adapters also refuse deleting a Session in use.
- Answer renders in the tool-card OUT (`toolState` treats it as non-error → green; cancel → yellow), not a separate bubble. A still-pending prompt is re-shown on refresh/reconnect (direct `subscribe` → bridge re-push; a prompt already on screen keeps its state).
- `web/js/components/permission.js` fully rewritten; old `arrow:`/`type:`/`escape` protocol + `checkPendingPrompts` client detection deleted.

### Image Sending
- Signed PUT to the transfer area + `![](baton-bridge:key)` protocol; attachments `[name](baton-file:key)`
- Bridge downloads with a signed GET → replaces with absolute path → CC Read tool reads it
- Multi-image staging + gallery + paste support

### File / Video Preview (click a file link in a message)
- Click file link → `openFile()` → direct `project_files {operation:'read'}` → Bridge reads from disk.
- Text ≤ 300 KB comes back inside the reply's frames; larger text (first 1 MB) is PUT to the transfer area and read with `transfer.text(key)`. Images go through `transfer.prepareUpload` (content-hash key) and are read with `transfer.fileInfo(key)`. Binary text files (NUL byte in first 8KB) → `binary file` error.
- **Video** (`.mp4/.m4v/.mov/.webm/.mkv/.avi`, ≤5GB): Bridge HEADs the key (path + mtime + size) and, when missing, pipes `fs.createReadStream` to a signed PUT (`fetch(PUT, {duplex:'half'})`, flat memory). Bridge replies `{video:true, key}`; the App plays a locally signed URL in a `<video>` element streaming directly from S3 (Range/seek supported) and re-signs at the current position when playback errors (expired URL).
- **Markdown documents** render like GitHub (`web/js/components/markdown-document.js`, lazy-loaded): raw HTML is kept and cleaned by bundled DOMPurify with GitHub's allowlist plus `picture/source`; `breaks:false`; `user-content-` heading anchors; `> [!NOTE]` alerts; `#gh-light-mode-only` images hidden and `prefers-color-scheme` fixed to dark. Baton's own markup (code, Mermaid, KaTeX, image placeholders) bypasses the sanitizer as nonce slots. Relative `img src` / `source srcset` / links resolve against the document directory; `/x` resolves like GitHub from the repository root: the nearest folder from the document upward (within the project) whose `.git` Bridge can read, probed only when the document uses `/` paths and cached per folder only on a definite answer; otherwise the project root (derived from the path + project hash). Real absolute paths (under the project/repository root, a common filesystem root such as `/Users/` or `/home/`, or any `/x` in a document outside the project) stay absolute, since agent-written documents use them. Links follow chat semantics: `file.ext:12` / `#L12` open at a line (DOMPurify's URI rule is extended to keep them), other schemes such as `tel:` are left to the browser, and `#user-content-x` and `#x` both reach the heading. SVGs whose own CSS uses `prefers-color-scheme` are fetched (`cache: 'no-store'`, since the `<img>` preload's cached copy lacks CORS headers) and rewritten to dark, because WebKit evaluates it against the OS appearance. Image URLs are kept for the open file, so Code/Preview toggles send no requests; pending images draw nothing until loaded. Markdown/HTML files open in Preview unless a line or tool location is targeted. ```` ```math ```` fences render through the shared KaTeX loader; Mermaid uses the chat component (blocks outside `#content` are observed against the viewport). `:shortcode:` emoji come from `emoji-shortcodes.js`, generated from gemoji by `scripts/generate-emoji-shortcodes.mjs` and loaded only when a document contains one. Folder links (`docs/`, or a link Bridge reports as a directory) open the project file browser when the path is inside the current project. Chat messages still escape raw HTML.
- **HTML documents**: relative CSS/JS/images are inlined, then rendered in a sandboxed opaque-origin iframe. In the iOS app they instead load into the native preview WKWebView through `navigate {url, html}` → `loadHTMLString(html, baseURL:)` (like SwiftChat's generated apps): the base URL is a virtual `https://<sha256(device, project, path)[:32]>.baton.local/<name>`, never fetched, so each file gets its own origin whose site storage persists across reopening. Native failure falls back to the iframe.
- **Office** (`.docx/.pptx/.xlsx`, plus legacy `.doc/.ppt/.xls`): rendered in the browser by `@silurus/ooxml` 0.89.0 (Rust/WASM, canvas), loaded on demand from jsDelivr like PDF.js/Mermaid (`web/js/components/office-preview.js`); no server conversion. The viewer module, the `transfer.fileInfo` HEAD and the download start together. Word uses the progressive scroll viewer, decks the scroll viewer, both with the shared two-finger zoom (`pdf-pinch.js`); Excel keeps the library's tabs and zoom bar. Legacy `.doc/.ppt/.xls` open in the same viewers through the experimental `@silurus/ooxml-legacy-office` readers (same version, loaded via jsDelivr `+esm` because its entry imports the viewer package by name; worker module + WASM URLs passed explicitly); unsupported content rejects and offers the download. Project files are uploaded through the existing `download` operation first, so Bridge is unchanged. The viewer is destroyed on close, including mid-load. Details: `docs/api.md`.
- **Attachment cache** (`web/js/components/attachment-cache.js`): Office files, images and PDFs fetched in one request (≤ 8 MB) are kept in IndexedDB by attachment key (account-scoped), so reopening one sends no request at all. Files uploaded from this device are stored at upload time. A key never changes content (see content IDs below), so entries never go stale. Images and other files have separate 500 MB budgets (kind by extension), so one large PDF cannot evict the images; oldest-opened evicted first within each. Every image shown through `getImageUrl` (chat, Markdown/file previews, the image viewer; cache key `images/<key>` for message images, the attachment key otherwise) is read from here as a Blob URL and stored after its single `fetch` download, so reopening or restarting sends no S3 request; if fetching or IndexedDB fails it falls back to the signed URL. Blob URLs are released when evicted from the 200-entry memory map unless still shown; HTML previews (opaque-origin iframe) get `data:` URLs instead; text previews uploaded to S3 (over 300 KB; their key is derived from path + content) count toward the file budget, while inline text, files over 100 MB, larger range-loaded PDFs, videos and audio are not cached. Any cache failure is a plain miss.
- **Content IDs / upload dedup** (`web/js/components/content-hash.js`, `bridge/content-hash.mjs`): like Git LFS and Docker registries, an upload's ID is the SHA-256 of the whole file and the storage verifies it. Key = first 32 hex digits + extension. `transfer.prepareUpload {contentHash}` (64 hex) HEADs `t/<accountId>/<key>` with `x-amz-checksum-mode: ENABLED`: only an object whose S3-verified `ChecksumSHA256` equals the hash (base64 vs hex) and whose size matches is reused → `{key, exists:true}`, nothing uploaded, the card simply reaches 100%. A missing object gets a PUT URL signed with `x-amz-checksum-sha256` (both the accelerated URL and `fallbackUrl`; the client must send exactly the returned headers), so S3 answers `400 BadDigest` to any other bytes and a content key always holds its content. Any other object at that key (prefix collision, no checksum) keeps a random key and is never overwritten. Uploads without `contentHash` (hashing unavailable) get random keys. The app hashes in 4 MB slices with hash-wasm, bundled as a 7 KB gzip SHA-256-only chunk (`web/js/components/sha256.js`) loaded on the first upload; WebCrypto has no streaming digest. Bridge streams the file and persists path + size + mtime + ctime + inode → hash in `~/.baton-bridge/file-hashes.json` (1000 entries; like Git's index, ctime catches copies that keep mtime, and files changed < 2 s ago are not remembered), so unchanged project files are neither re-read nor re-uploaded after a restart. On `BadDigest` (file edited while preparing) Bridge forgets that hash, skips the fallback URL and reports the file as changed. Shared content keeps the first uploader's S3 name, so `transfer.fileInfo(key, name)` passes the attachment link name (project files: the name from their path).

### Session Launch (headless)
- Existing session with no live CC process → `_pool.send` spawns a headless `claude -p --resume <id>`; the persistent process becomes the single writer. No tmux, no wait-for-ready, no trust-dialog handling (headless inherits the folder's trust state).
- Idle reap (10min) + LRU cap (16) manage the pool; a reaped session re-spawns with `--resume` on the next message, context intact and configuration reloaded. A process with background tasks (`background_tasks_changed`, CC ≥ 2.1.203) is neither reaped nor evicted, and the task ending restarts its idle clock; in `-p` mode `~/.claude/sessions/<pid>.json` reads `idle` while background work runs, and CC keeps running after EOF until that work ends. Once CC reports `user_message_uuids`, a `result` without them (a turn CC started itself) consumes no input. (No more `cleanStaleSessions` / `apeek_*` tmux naming — all deleted in Phase 2E.)
- New regular Session: Bridge mints a UUID, sends `send_message_result` first, then starts
  headless with `--session-id <id>` so the app subscribes before stream frames arrive.
- New Codex Session: Bridge calls `thread/start`, returns the storage Session ID, then starts the
  first turn on the same cwd-scoped app-server client.
- New background agent: Bridge launches `claude --bg`, resolves the full Session ID, and lets
  the agent poll/watcher publish metadata and messages.

### Device Routing
- Bridge WS connection includes `device` parameter
- Server stores `deviceName`, filters send_message/permission_reply forwarding by device
- Viewer sends messages with `device: appState.device`

## Web Deployment

### Web Pages (served from FastAPI Lambda)
- `web/landing.html` — API key input, URL `?key=` auto-login, localStorage (`_ak` btoa obfuscated)
- `web/index.html` — Session viewer (auth guard redirects to landing if no key)
- `web/setup.html` — Bridge install command + QR code + connected devices list
- Top bar: Baton logo + Setup gear icon
- Favicon: inline data:image/svg+xml (all pages unified)

### Auth Flow
- Key stored in localStorage (`_ak` = btoa, `_as` = server URL)
- No cookies, no server middleware — static files publicly accessible
- API calls use `x-api-key` header from localStorage
- API Gateway `ApiKeyRequired: false` — auth handled by FastAPI layer

### Deployment
- Dockerfile: `COPY web/ web/` → FastAPI `StaticFiles` mount
- `install.sh`: copies `web/` to Docker build context, deploys via CodeBuild
- Deploy output: single setup URL with embedded token (12h TTL, reusable until then)

### Three-State Session Status
- `running` → **Running** (green): a turn is generating (jsonl `stop_reason: tool_use`/`null`,
  or pool turn in flight, or agent `working`)
- `needs_input` → **Needs input** (amber, reuses `.badge.idle`): the ball is in the user's court
  (pool `control_request`, agent `blocked`, or terminal `AskUserQuestion`/`ExitPlanMode`).
- `completed` → **Done** (grey, reuses `.badge.stopped`): turn finished / no process / stale.
  Also the fallback for legacy `idle`/`stopped`/unknown values.
- Homepage: Active Sessions = running + needs_input (regular + agent); Completed Sessions =
  20 most-recent completed of any type. Device/Project rows show `N running · N needs input`
  (`needsInputCount`). `completed` is not shown on the device rows.

## Light / Dark Theme

- Two palettes with identical token names: `web/css/themes/dark.css` (`:root`, the default, values match the
  original dark UI) and `light.css` (`:root[data-theme="light"]`). Components reference semantic tokens
  (`--canvas`, `--surface`, `--surface-elevated`, `--text-secondary`, `--spinner`, ...), never raw colors; a
  value that only one theme needs still gets a token whose dark value is the old literal, so Dark stays
  pixel-identical.
- Light layering mirrors Dark: white page, `#f6f8fa` top bar/cards/inputs, `#eaeef2` raised headers. Secondary
  text is lighter than a straight mapping (`#6e7781`) and bold tool names lighter still (`--tool-label`),
  because mid-grey on white reads close to black.
- Settings → Appearance offers System / Light / Dark (default Dark). `web/public/theme-init.js` runs before
  first paint on every page: the preference is `localStorage['baton-theme']`, else the native copy
  (`window.__BATON_NATIVE_THEME__` / `BatonAndroid.getTheme()`), else dark; `system` resolves through
  `prefers-color-scheme` and follows its changes. `data-theme` is the resolved palette, `data-theme-preference`
  the choice. `theme.js`
  dispatches `themechange`; xterm, Mermaid, diff2html, Markdown theme images and file icons re-render on it.
  Switching never reloads the page.
- Native sync (`theme-native.js`): Android `BatonAndroid.setTheme` (system bar icons, app night mode,
  splash; `uiMode` is in `configChanges`, so no Activity restart), iOS `batonAppearance` message
  (window style, status bar, preview webviews), desktop `appearance_set` (`src-tauri/src/appearance.rs`:
  Tauri theme, window/webview backgrounds, macOS tab strip, saved to `appearance.json` for the next launch).
- Cold-start launch screens follow the app's choice, not the system's: Android 12+ uses the app night mode;
  iOS renders the LaunchScreen skeleton into light and dark snapshots per orientation
  (`Library/SplashBoard/Snapshots/<bundle> - {DEFAULT GROUP}/*.ktx`, Apple's `AAPL` container with ASTC,
  LZFSE-compressed on iOS 18). `main.mm` keeps the system's originals in `Application Support/BatonLaunchSnapshots`,
  classifies each by its first ASTC void-extent block, and on launch and every switch copies the chosen
  appearance's snapshot over the other one (System restores the originals). Unrecognised files leave the snapshots untouched; the first cold
  start after an app update still uses the freshly rendered system pair.
- The image viewer keeps a backdrop of its own (`--media-backdrop`); videos and QR codes stay black/white.

## Native App (Tauri v2)

Tauri v2 wraps web/ static frontend as native app, zero web code changes.

### Architecture
- `src-tauri/` at project root (sibling to web/, bridge/, server/)
- `frontendDist: "../web"` — directly serves static HTML/CSS/JS
- `withGlobalTauri: true` — JS accesses native API via `window.__TAURI__`
- Bundle identifier: `com.batonai.app`
- Built-in dev server (no http-server needed), hot-reload
- Android system Back: each page registers Tauri's `onBackButtonPress` (listeners survive page
  loads); at the root `MainActivity`'s `BatonAndroid.moveTaskToBack()` backgrounds the app.
- macOS tabs (`src-tauri/src/macos_tabs.rs`, Tauri `unstable` multi-webview, macOS target only):
  each Overlay-titlebar window has a 41pt `tabs.html` strip webview in the traffic-light row and
  one content webview per tab below it (own page, draft, WS), hidden when inactive. The frame
  view's `setCustomTitlebarHeight:` makes AppKit itself centre the traffic lights on the strip —
  never move the buttons afterwards; AppKit re-lays them out on every move/resize. A window's own
  webview needs `set_auto_resize(false)`, or Tauri stretches it under the strip on resize. Commands
  must take `Webview`, not `WebviewWindow` (that extractor fails once a window has children).
  Rust owns tab order/selection/titles and pushes `macos-tabs` to the strip; pages report titles
  from `updateBreadcrumb`. Preview tunnels and native preview views are owned per webview label.

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
npm run release:ios:cloud   — trigger Xcode Cloud archive → TestFlight (any OS, e.g. Linux)
npm run build:mac           — signed + notarized universal macOS DMG
npm run build:windows       — cross-compiled Windows NSIS installer (.exe)
npm run package             — Android/macOS/Windows into release/<version>/ (Linux uses GitHub Actions)
```

The local macOS release script reads signing values from `.env.local`
(gitignored). See `docs/package.md` for GitHub Actions secrets, the
pushed-commit requirement, and platform-specific outputs.

Xcode Cloud (iOS from Linux): product "Baton" is connected to `github.com/zhu-xiaowei/Baton`;
workflow "Default" is manual-start only, pinned to Xcode 26.6 (Xcode 27 rejects the iOS 14.0
deployment target), and archives `baton_iOS` for TestFlight. `src-tauri/gen/apple/ci_scripts/ci_post_clone.sh`
installs Node + Rust, builds `dist/`, and patches the Rust build phase PATH in the CI checkout.
`tauri-options.mjs` supplies the `tauri/custom-protocol` feature and `--lib`
argument that `tauri ios build` adds on macOS; without the feature, the archived
app attempts to load the `devUrl` at localhost:5173.
Push the current commit to the connected GitHub repository before triggering.
The cloud release script increments `CFBundleVersion` in `project.yml` and `Info.plist`,
commits and pushes the new version, then starts the workflow. If a version was
prepared but no cloud run started, retrying reuses it. Xcode Cloud assigns its own
build number during export. Use `node scripts/release-ios-cloud.mjs --dry-run`
to check the expected next number and align Xcode Cloud's Next Build Number
in App Store Connect if necessary. The post-clone script rejects a mismatch
before installing toolchains or archiving.

### Native Features (planned)
- QR scan login: `tauri-plugin-barcode-scanner`
- Biometric auth: `tauri-plugin-biometric`

## Live State (headless native — was "tmux capture-pane Live State")

CC has many intermediate states not written to jsonl (thinking animation/content, permission
waiting, tool progress). The old plan was to scrape them with `tmux capture-pane`. **Headless
delivers them natively** as stream events (`content_block_delta` text/thinking, `control_request`
for permissions, `result` for turn end) — no pane scraping needed. All wired: typewriter text +
thinking preview (`stream_delta`, per-tick thinking timer), permission `control_request` → app
prompt, turn-end (`stream_end`).

## Stall Rescue — REMOVED in Phase 2E (headless makes it unnecessary)

The old problem: a multi-question AskUserQuestion (tab-bar wizard `☐ header1  ☐ header2  ✔ Submit`)
held its entire tool_use in CC's memory and never wrote it to jsonl until Submit, so the bridge
saw nothing and the session looked permanently `running`. The tmux workaround (`stall.mjs`
`checkStalledSessions` + capture-pane wizard detection + Escape to force-flush + hiding the
synthetic rejection pair in `watcher.mjs`) is **deleted**.

Under headless this can't happen: CC pushes the full `questions[]` up front via a `control_request`
(`requires_user_interaction`), wired to the app prompt (permission bridge, DONE). `stall.mjs` and
`watcher.mjs`'s synthetic-pair filter / `stallRescued` tagging are **fully deleted**.

## Known Issues / TODO

- **Real-time Edit diff hydration lifecycle**: fixed the intermittent mobile state where an expanded `Edited` card showed only its border until session reload. Diff data now survives DOM replacement under a stable content key, initialization is tracked per element, visible tool nodes hydrate after every timeline mutation, and the registry is cleared at session boundaries. Keep regression coverage for replacement during lazy import, streaming adoption, fallback rendering, and session cleanup.
- **VS Code CC status precision**: VS Code extension launches CC without `--resume` flag. CC ≥ 2.1.269 is matched exactly through its `~/.claude/sessions/<pid>.json` record; older versions (and Windows) fall back to the mtime heuristic (5 min timeout → completed).
- **Unstructured terminal questions**: external terminal turns that end with plain assistant text do not expose a reliable waiting-for-input signal. Structured `AskUserQuestion` and `ExitPlanMode` are detected as `needs_input`.
- **Concurrent regular-session control**: Claude has no lock for a normal terminal or VS Code session. A send to a session another live CC process holds (its `~/.claude/sessions/<pid>.json`) returns `claude_active_writer`; the App's takeover modal SIGTERMs that pid and then resumes. An idle pooled process that missed another client's turn is resumed again first. A terminal that opens the session while a Baton turn runs still forks it (undetected). Daemon agents are safe because Web takeover stops the roster worker first.
