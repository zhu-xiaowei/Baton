# Codex Integration Design and Implementation Status

> Last updated: 2026-08-12
> Current status: Phase 1 and Phase 2 are complete; Phase 3 has completed Session creation and the main interaction path
> Full API and WS contract: [api.md](api.md)

## 1. Goals and Scope

Baton integrates Codex as a second local agent runtime and keeps using the unified
Device → Project → Session information architecture.

Completed:

- Automatically discover Claude Code and Codex history Sessions.
- Both runtimes with the same cwd are grouped into the same Project.
- Sync Codex Session metadata and history messages into the existing DynamoDB tables.
- Existing users run the Codex initial sync automatically after upgrading the Bridge.
- When DDB has no messages, old Sessions are backfilled on demand through REST → WS → Bridge.
- Watch every Codex Session storage directory and sync in real time over WS after a rollout append.
- WS ack, HTTP fallback, oversized frames, failure retry, and watermark commit use the same reliable delivery semantics as Claude.
- Update new Session metadata and `running/completed` status in real time.
- Lists and detail views reuse the unified UI, distinguished by runtime icon, short ID, and local presentation differences.
- Bridge install, startup, and upgrade on macOS, Linux, and native Windows.
- Existing Codex Sessions send messages through app-server `thread/resume` + `turn/start`.
- New Codex Sessions run `thread/start` and the first `turn/start` back to back on the same
  cwd-scoped app-server client.
- When a Codex managed daemon is detected, the Bridge reuses the same app-server through its
  Unix WebSocket socket; it only falls back to a standalone `app-server --stdio` when there is no daemon or the connection fails.
- After reusing the daemon, an already loaded active turn is adopted as the current stream and its pending approvals are replayed;
  newly sent messages are queued to start after that turn completes, and later deltas still use the full streaming path.
- When an existing Codex Session is opened, the Bridge runs a passive `thread/resume` on threads
  still loaded in the managed daemon: it only subscribes to the existing turn and replays TUI pending approvals, does not call `turn/start`,
  and does not terminate the writer. After either Web or TUI answers, the other side's prompt closes or shows the next queued item.
- app-server deltas reuse Claude's immediate first frame, 50ms batching, turn-level `seq`, frontend reordering, and catch-up rendering.
- Complete app-server user/assistant items are the live authority rows; the rollout watcher only persists matching rows and covers missed events.
- interrupt and command/file/permissions/MCP elicitation/user-input are wired into the existing WS
  control protocol. Command approvals pass through App Server `availableDecisions` in original order; permissions
  only return a semantic action and the Bridge builds the grant from the original request; MCP supports ordinary approval, session/always
  persistent grants, and the string/boolean/enum forms supported by the TUI.
- Form schemas MCP does not support degrade to three ordinary approval options, as in the TUI; Baton has not implemented AppLink
  install/auth UI, so `openai/form`, URL, and tool suggestion are safely `decline`d.
- Each active thread uses a temporary app-server client lease; managed daemon mode only closes that connection,
  and only the stdio fallback exits the standalone process and releases the writer.
- When an external standalone Codex TUI holds the writer with an unfinished turn, after explicit Web confirmation the Bridge can safely terminate that
  holder, retry resume, and send; when the TUI only holds the lock while idle it is terminated and resumed automatically; cancel neither terminates the running
  process nor sends the message.
- Project creation is already a runtime-independent directory and metadata operation; Claude/Codex can reuse the same entry point.
- The full scrolling popup of the local Codex 0.147 TUI was measured at 44 items, not the 8 on the first screen. The phone menu uses these 44
  items as the baseline and keeps the original order; the macOS Bridge returns 33 items, and Linux returns 32 because it does not support `/app`.
- The 11 filtered items are `ide`, `keymap`, `vim`, `approve`, `side`, `raw`, `title`,
  `statusline`, `theme`, `pets`, `plugins`. The first 10 depend on IDE/TUI rendering, TUI in-memory state, or
  an ephemeral side surface; `plugins` needs a full install, uninstall, and App auth flow that is not yet implemented.
- The remaining commands reuse app-server RPC or existing phone navigation/clipboard. `model`, `permissions`,
  `experimental`, `memories`, `hooks`, `feedback`, `personality`, etc. run through a second-level picker;
  `hooks` supports enable, disable, and trust. `app` is only shown on macOS/Windows Bridges.
- `$CODEX_HOME/prompts/*.md` is added as a deprecated compatibility layer under `/prompts:<name>`, supporting the old TUI's
  frontmatter, positional arguments, `$ARGUMENTS`, and named argument expansion.
- Skills are fetched with app-server `skills/list(forceReload)`; `/skills` and `$` open the picker, and
  the final `turn/start.input` sends a structured `{type:"skill", name, path}` without reading or concatenating the Skill body.
- `/review`, `/compact`, Session lifecycle, Plan/Goal, status, MCP, background terminals, etc. run through the current
  Session's app-server client; `/init` expands to the same prompt as the TUI; `/copy` uses the phone
  clipboard.

Not yet complete:

- `turn/steer`, and recovery across Bridge restarts of standalone pending requests without a managed daemon.
- Whether app-server tool output should become the live authority; final tool cards currently keep reusing the Phase 2 watcher.

Therefore, Codex Sessions already support creation, history reading, real-time observation, and Web interaction. The New Session page shows
runtimes according to the device's `canCreate` capability; with only one runtime it is selected automatically, with several the user can switch and the
last choice on that device is remembered.

## 2. Phases and Completion Criteria

| Phase | Status | Scope | Completion criteria |
|---|---|---|---|
| Phase 1 | Complete | Initial discovery, metadata, history messages, on-demand backfill, unified UI, cross-platform install and upgrade | Local/DDB/REST/UI counts match; no new duplicates after restart or repeated opening; no Claude behavior regressions |
| Phase 2 | Complete | Codex watcher, incremental reads, status updates, real-time observation | New lines on macOS/Linux/Windows are neither missed nor duplicated; disconnect, restart, half-written line, and watermark recovery pass |
| Phase 3 | In progress | app-server, creation, sending, streaming, interrupt, permissions | Main path, all approval types, daemon reuse, and explicit TUI takeover are complete; automatic recovery across Bridge restarts is still pending |
| Phase 4 | Not started | Performance, diagnostics, gradual rollout, rollback, and UX polish | Large Sessions, weak networks, failed upgrades, and multi-device scenarios all have executable acceptance and rollback procedures |

### 2.1 Implementation Rules

- Runtime differences are implemented through adapter/controller interfaces, with one file per runtime.
- The shared coordinator only handles orchestration, identity, upload, and routing; it does not parse runtime-private formats.
- Refactoring the Claude Code adapter may only change code organization; path, status, watermark, message, send, and permission semantics stay unchanged.
- The UI reuses unified components by default, with local differences only at the runtime/capability layer.
- New methods keep a single responsibility; each method keeps at most one line of necessary comment.
- Test coverage matches the change risk; a completed status must have automated or real-environment verification evidence.

## 3. Runtime Adapter

The Phase 1 initial read path consists of the following files:

| File | Responsibility |
|---|---|
| `bridge/runtime-adapter.mjs` | Defines and validates the runtime public interface and feature flags |
| `bridge/runtime-registry.mjs` | Registers runtimes, looks up adapters, unified capability detection |
| `bridge/claude-runtime.mjs` | Claude discovery, reading, status, deletion, and capabilities |
| `bridge/codex-runtime.mjs` | Codex discovery, reading, and status polling capabilities |
| `bridge/codex-commands.mjs` | Phone command capability matrix, TUI order, legacy prompt scanning, and argument expansion |
| `bridge/sync.mjs` | Merges catalogs, aggregates, filters, and uploads |
| `bridge/ws.mjs` | Generic WS routing; runs `sync_session` through the adapter |

Phase 2 real-time path:

| File | Responsibility |
|---|---|
| `bridge/watcher-adapter.mjs` | Defines the runtime watcher interface |
| `bridge/runtime-watcher-registry.mjs` | Registers and starts the Claude/Codex watchers |
| `bridge/watcher.mjs` | Claude JSONL watcher |
| `bridge/codex-watcher.mjs` | Codex multi-Home rollout watcher, watermark, and status updates |
| `bridge/realtime-delivery.mjs` | WS ack, HTTP fallback, and large-frame policy shared by both runtimes |

Phase 3 existing-Session interaction path:

| File | Responsibility |
|---|---|
| `bridge/interaction-adapter.mjs` | Defines and validates the runtime interaction interface |
| `bridge/codex-app-server.mjs` | managed Unix WebSocket/stdio app-server transport, handshake, request pairing, and reverse requests |
| `bridge/codex-interaction.mjs` | daemon reuse, writer lease, turn, structured Skills, native commands, interrupt, approvals, and per-Session queueing |
| `bridge/codex-writer.mjs` | active-writer detection, standalone TUI holder validation, and safe termination after confirmation |
| `bridge/stream-framer.mjs` | Immediate first frame, 50ms batching, and turn-level `seq` shared by Claude/Codex |
| `bridge/codex-live.mjs` | Maps app-server items to unified previews/complete messages |
| `bridge/live-message-registry.mjs` | Short-term dedup between live complete rows and the rollout watcher |
| `bridge/ws.mjs` | Enters the existing unified WS streaming contract through the interaction adapter |

Adapters must implement:

```text
discover
detectCapability
findSessionFile
shouldSkipInitial
baselineToEnd
syncInitialMessages
syncAllMessages
```

Optional capabilities are declared through `features`, currently including:

```text
read
create
send
interrupt
deleteHistory
statusPolling
```

The Phase 2 Claude/Codex watchers already use separate adapters + a registry; the Phase 3
send/streaming/permission controllers must keep the same structure and must not pile up runtime
conditional branches in shared implementations.

## 4. Identity and Paths

### 4.1 Session ID

Unified runtime values:

```text
claude
codex
```

Claude's historical IDs and DDB keys are completely unchanged. Codex uses:

```text
nativeSessionId = Codex rollout UUID
sessionId       = codex:<nativeSessionId>
```

`sessionId` is used for the DDB message partition, Session row, WS subscription, and local watermark;
`nativeSessionId` is used to locate the local rollout and for future app-server calls. The frontend shows the last 8 characters of the Codex native ID,
because UUIDv7 prefixes lack distinctiveness among Sessions created around the same time.

The Server treats old payloads and old DDB items that lack `runtime` as Claude by default.

### 4.2 Project Hash

Codex's `session_meta.cwd` computes `projectHash` with the existing Claude-compatible rule. No second hash scheme is introduced,
and paths are not passed through `realpath` or lowercased.

```text
macOS/Linux cwd → Claude-compatible path hash
Windows C:\...  → compatible with existing C--Users-* / C-Users-* candidates
worktree        → verify Git repository identity, normalize to the original project hash by primaryRoot / relativeCwd
```

Claude/Codex Sessions with the same cwd must land in the same Device → Project. Native Windows has been verified compatible with drive letters,
spaces, Chinese paths, and existing Claude project hashes; Codex does not depend on WSL.

The actual session cwd of a Codex worktree stays unchanged. Existing standalone projects have their metadata migrated by a one-time script, with no compatibility layer for old hash lookups; see the [worktree migration notes](codex-worktree-migration.md).

## 5. DynamoDB Data Model

The Codex integration adds no tables and does not change primary keys, GSIs, or TTL.

### 5.1 BridgeSessions

```text
PK = accountId

SK = DEV#<deviceName>
SK = PROJ#<deviceName>#<projectHash>
SK = SESS#<deviceName>#<projectHash>#<sessionId>
```

Session items add or standardize the following fields:

```text
sessionId
nativeSessionId
runtime
modelProvider
clientSource
cliVersion
```

A missing `runtime` is read as `claude`. Status is unified as:

```text
running
needs_input
completed
```

Codex JSONL can currently only reliably yield `running` or `completed`; persisted history alone cannot tell whether an external
Codex process is waiting for approval, so the JSONL watcher does not produce Codex `needs_input`.

### 5.2 Device Runtime Capabilities

Each account and `deviceName` has exactly one DEV item. Capabilities are a nested map on that item, not a separate row
per runtime:

```json
{
  "runtimeCapabilities": {
    "claude": {
      "installed": true,
      "historyAvailable": true,
      "canRead": true,
      "canCreate": true,
      "canSend": true,
      "version": "..."
    },
    "codex": {
      "installed": true,
      "historyAvailable": true,
      "canRead": true,
      "canCreate": true,
      "canSend": true,
      "version": "..."
    }
  }
}
```

`installed` is separate from `historyAvailable` because local history may still be readable after the CLI is uninstalled.
These capabilities are stored in the device aggregate for Bridge/diagnostic use and are not returned with the homepage `/devices` list.

### 5.3 BridgeMessages

```text
PK = sessionId
SK = timestamp#uuid
TTL = 90 days
```

Repeated extraction uses the same `uuid` and sort key, so DDB `PutItem` overwrites the same row and copies do not accumulate. Message items
keep a unified structure: `uuid`, `type`, `content`, `timestamp`, plus optional `nativeId`,
`stopReason`, `toolUseResult`. `nativeId` is the stable identity shared by live and watcher/DDB rows;
the frontend dedups through the same identity set as Claude.

## 6. Codex Discovery and Status

The Bridge scans recursively:

```text
<CODEX_HOME>/sessions/**/*.jsonl
```

When `CODEX_HOME` is not set, the default `~/.codex` is used. Discovery rules:

- The native ID is the UUID at the end of the rollout file name.
- When there are multiple `session_meta` entries, metadata whose ID matches the file name is preferred.
- cwd, provider, originator/source, and CLI version come from `session_meta`.
- preview prefers the last `thread_name` for the thread in `<CODEX_HOME>/session_index.jsonl`,
  consistent with Codex `/resume`; without an indexed title it falls back to the first
  `event_msg/user_message`. Automatic titles and user `/rename` both update the same
  `thread_name`, so the source does not need to be distinguished.
- model is the latest valid `turn_context.model`.
- lastActive and size come from the file stat.
- Empty files, files without user messages, or files missing required metadata produce no Session.
- Corrupt middle lines are skipped; a half-written tail line does not block other Sessions.
- When discovery hits unreadable files or missing key metadata, it does not overwrite the authoritative DEV/PROJ aggregates.

`running` requires an unclosed task plus at least one of: the file is still fresh, a matching Session process, or a matching
Project process; otherwise it is `completed`. Windows does not enumerate Codex processes and only uses file lifecycle
and freshness, so its status precision is lower than for interaction processes managed by the Bridge itself.

Page status polling and writer takeover checks both obtain this status through `inspectCodexSession()`. The writer has already
obtained process evidence for the current Session from the lock holder, so it only supplies that extra context rather than maintaining a separate
`running` check.

## 7. Phase 1 Data Flow

### 7.1 Bridge Initialization

```text
Bridge starts or restarts after upgrade
→ restore synced.json watermark
→ Claude/Codex adapters run discovery separately
→ merge into a unified catalog
→ compute Device/Project aggregates once
→ upload all Session metadata
→ select running, needs_input, or last-24h Sessions
→ extract and upload messages for 2 Sessions concurrently
→ commit watermark after a successful upload
→ start Claude/Codex watchers through the watcher registry
```

Startup sync closes the gap from while the Bridge was offline; at runtime the Codex watcher continues reading from the same watermark.
Both paths only commit the watermark after messages are written successfully.

Messages backfilled during a Bridge restart are written to DDB over HTTP and do not go through the real-time message broadcast. If startup sync actually
backfilled messages, the Bridge sends one device-level recovery-complete notification after the WS connects; the App on the current device then merges
the current Session from DDB, so intermediate tool results do not require a manual refresh to appear. No notification is sent when nothing was backfilled.

`--skip-init` uploads no messages but establishes end-of-file watermarks for both runtimes. When the catalog exceeds 5000
Sessions it is uploaded in batches, and only the first batch carries the authoritative DEV/PROJ aggregates.

### 7.2 On-Demand Backfill of Old Sessions

Sessions older than 24 hours with no messages in DDB yet go through this path when the detail page opens:

```text
App GET /api/bridge/messages
→ Server returns needSync=true
→ Server WS sync_session
   { sessionId, runtime, nativeSessionId }
→ Bridge selects the runtime adapter and extracts from line 0
→ Bridge POST /api/bridge/sync-messages
→ Bridge WS sync_complete
→ Server broadcasts sync_complete to the account's Apps
→ App GETs /messages again
```

Default message reads use consistent reads, shortening the window where an immediate refresh after `sync_complete` misses just-written rows.
Repeated opening, repeated syncs, and Bridge restarts all rely on deterministic UUIDs + DDB keys to stay idempotent.

### 7.3 Phase 2 Real-Time Reads

```text
Parcel native directory subscription discovers a rollout
or an active/recent file watcher receives an append
→ same busy/pending coalescing as Claude
→ process serially by nativeSessionId immediately
→ extract complete JSON lines from the watermark
→ WS messages and wait for messages_ack
→ no WS / ack timeout → HTTP write to DDB
→ commit watermark on success
→ sync Session metadata/status
```

- Each `CODEX_HOME/sessions` uses one `@parcel/watcher` native recursive subscription, responsible for discovering new directories,
  new rollouts, renames, and large history directories.
- All `running` rollouts and the 64 most recent completed rollouts use direct file watchers for real-time
  appends. This bounded set avoids macOS FSEvents missing events for files Codex keeps appending to over long periods, without
  creating 10,000 handles for 10,000 history Sessions.
- Normal events enter the `busy/pending` serial loop immediately, as with Claude; every root directory gets a low-frequency
  safety rescan every 5 minutes to fill in missed low-level file events.
- File events may be coalesced by the OS; any single event reads complete lines from the watermark to EOF, and after delivery
  compares the file size/mtime again. If the file keeps growing during processing, the next round starts immediately without relying on a second file event.
- A half-written tail line does not advance the watermark; once complete, it produces the same deterministic UUID from its original line number.
- Each Session has only one processing loop; bursts of events only set one pending flag.
- Small WS messages are batched in order within the frame budget; the Server only acks after DDB persistence succeeds, and disconnects, write failures,
  or ack timeouts all go through the strict HTTP fallback.
- Messages exceeding the WS frame budget send a truncated `noCache` copy in real time, and the full copy is saved over HTTP.
- Any delivery failure keeps the watermark and retries on a timer; on restart `synced.json` backfills again.
- `task_started/task_complete/turn_aborted` drive real-time status; ordinary assistant/tool appends do not rescan
  rollout status. Long-unclosed turns are rechecked by a stale timer and the existing `checkStopped` adapter.

## 8. Message Normalization and UI

### 8.1 Supported Mappings

| Codex raw node | Unified model / UI |
|---|---|
| `event_msg/user_message` | `user` |
| `response_item/message(role=assistant)` | `assistant` text |
| `event_msg/task_complete` | Invisible `assistant/end_turn` lifecycle, used to end the current spinner |
| `exec_command` | `Bash` |
| `update_plan` | `TodoWrite` |
| app-server `turn/plan/updated` | Real-time `TodoWrite`, `inProgress` normalized to `in_progress` |
| app-server `item/plan/delta` | Legacy/experimental plan text stream, not concatenated with the structured checklist |
| `apply_patch` | One or more `Edit`; pre-validation failures without a `FileChange/PatchApply` lifecycle are not shown |
| `write_stdin` | `WriteStdin` |
| `item_completed/CommandExecution` | Updates the original `Bash` with authoritative output, exit status, command classification, and completion time |
| `item_completed/McpToolCall` | Updates the original MCP call with server/tool, final result, and `Calling/Called` status |
| `view_image` | `ViewImage` |
| `tool_search_call` | `ToolSearch` |
| `item_completed/WebSearch`, `web_search_call` | Deduplicated `WebSearch` |
| Other tools | generic tool card |
| `compacted` (with non-empty `message`) | Markdown summary, collapsed by default |
| `item_completed/ContextCompaction`, `context_compacted` | `Context compacted` system event |
| `entered_review_mode` | `Review started` system event |
| `exited_review_mode` | `Review completed` system event |
| `thread_rolled_back` | rollback system event |
| `turn_aborted` | interrupt |

Developer messages, duplicate `agent_message`, and encrypted reasoning without plaintext are not shown. Within a Review
scope, adjacent prompts with identical content in the same turn are kept only once; ordinary repeated user
messages are not deduplicated globally.

Codex intermediate progress and final body text both use `response_item/message(role=assistant)`;
`phase=final_answer` only marks the body phase and does not mean the turn has completed. After these texts arrive the frontend keeps
showing running until the separate, later `event_msg/task_complete` is normalized into an invisible
`stopReason=end_turn` lifecycle. That lifecycle takes part in status computation but produces no extra timeline node.
Frontend status decisions are separated through a runtime status adapter: Claude keeps its existing error-result/interactive-tool rules;
an ordinary Codex tool failure still belongs to a running turn, and only `task_complete` or `turn_aborted` ends it.
On first entry and on foreground/reconnect recovery, `/api/bridge/messages` also returns the Session status; if a newer
`stream_turn_start/end` or permission lifecycle event was applied during the request, the WS status takes precedence. The runtime status
adapter is only a fallback when the API lacks status or when handling the tail of ordinary real-time messages.

Tools are paired by `call_id + occurrence`, supporting call ID reuse within the same Session; message UUIDs are separate from tool
pairing IDs. Unfinished or interrupted tools may have only an IN; a nonexistent OUT must not be fabricated.

When patch syntax or context pre-validation fails, Codex only writes `custom_tool_call_output` and does not produce
`FileChange` or legacy `patch_apply_begin/end`, so the TUI does not create an `Edited` node. The Bridge
likewise skips these transient failures; once a patch has entered the FileChange/PatchApply lifecycle, even if it ultimately fails,
the Edit and its error result are kept.

### 8.2 ViewImage

Codex `ViewImage` is the agent viewing a local image, not the user sending an image. The Bridge keeps the local path and does not
upload base64 during initialization. When the user clicks, the existing `request_file` flow is reused: the Bridge uploads to S3 on demand,
and the existing preview component displays it.

### 8.3 Runtime Presentation Differences

Both runtimes reuse the list, detail, message, tool, diff, todo, and file preview components. Codex only adds:

- A runtime icon on the homepage, Session list, and top-right of the detail view.
- The last 8 characters of the native ID.
- Display names such as `Explored`, `Ran`, `Edited`, `Updated Plan`, `Viewed Image`.
- Only a `Bash` whose Codex `parsed_cmd` entries all belong to `Read/ListFiles/Search` and whose source is not `UserShell`
  is `Explored`; consecutive calls form one group following TUI `ExecCell` semantics, keeping call order within the group.
  Children use `Read/Search/List` structured summaries; on history load the group is collapsed to one line by default, showing the first child's summary and
  the call count, with later children hidden entirely. Real-time groups are expanded by default; clicking the group-head arrow expands or collapses all IN/OUT,
  and after a manual collapse newly arriving children keep it collapsed and only update the call count. Underlying call IDs, IN, OUT, results, and UUIDs
  are still kept separately.
- Other `Bash` is shown as `Ran`, with the final position determined by the `CommandExecution` completion time. Consecutive `Ran`
  reuse the tool grouping component: history is collapsed to the first command's summary by default, real-time is expanded by default; failed or warning commands still take part in
  grouping, and the collapsed summary dot uses the status of the last command in the group.
  The frontend regex previously used to guess read-only commands has been removed, so compound commands are no longer misgrouped because they contain
  fragments like `git diff` or `find`.
- An empty-input `WriteStdin` is background terminal polling: a waiting real-time node shows `Waiting for background
  terminal`; consecutive polls are not distinguished by process and only the last node is kept, and any other timeline node ends
  the current consecutive run. Longer commands are truncated to a single line by default; clicking the title expands the full content. Polls that directly end the process do not create
  an extra Waited. Non-empty terminal input is still shown as `Ran`.
- The aggregated output of `CommandExecution` is the authoritative OUT; `Chunk ID`, `Wall time`, token count, and other
  wrapper results are marked superseded when the final event exists. The exit code is shown as node status, not concatenated into OUT.
- MCP calls use `McpToolCall.server/tool` as the authoritative identity: `Calling` while running, `Called` after completion,
  with the summary keeping `server.tool`; the generic `function_call_output` wrapper is not shown again.
- Tool details use a unified runtime policy: history loads show only the title by default, new real-time WS nodes are expanded by default;
  clicking the title or arrow toggles details. `Explored`, `Ran`, and Claude `Bash` use the same consecutive tool grouping component,
  where the group head controls all members at once, and the inner `Show more` remains a second-level expansion for long content.
- A collapsed history `Edit` does not download or run Diff2Html; it is loaded and rendered dynamically on first expand, and later expands reuse the result.
- Codex local accent color `#13A7CD`; tool titles still use the unified white.
- The bottom running text is a fixed character-by-character looping `Working...`.

Review JSON is shown as a structured result; ordinary standalone JSON uses a formatted code block. Summaries are collapsed by default
and rendered as Markdown when expanded. Review lifecycle and rollback use the unified system event timeline row.

### 8.4 Large Message Boundaries

- A generic tool IN shows a preview of the first 1500 characters in the UI.
- Tool OUT is no longer truncated by character count on the frontend; it is only visually collapsed.
- The API Gateway WS frame budget is about 31 KB; oversized real-time messages send a reduced preview marked `noCache`.
- The full copy is written to DDB over HTTP, with a per-normalized-message limit of about 360 KB.
- After the user re-enters the Session, the available full version is read from REST/DDB.
- Content Codex itself already wrote as `Warning: truncated output` cannot be recovered by Baton.

## 9. Codex Data Not Added to the Timeline

The following nodes are mainly Session/turn global context and should not be shown one by one in the message timeline:

```text
session_meta
token_count
turn_context
world_state
thread_settings_applied
```

A unified Session metadata modal could be implemented later: clicking the runtime icon at the top-right of the detail view would show on demand the runtime,
full native ID, model/provider, source, CLI version, and last activity time. Codex could add bounded
token, thread settings, and turn context summaries, but would not upload the full world state, base/developer
instructions, skills, or permission path lists.

The Codex TUI's `N background terminal(s) running` is in-memory state not written to JSONL; Phase 1
does not rebuild that running count. When a background command completes it writes `item_completed/CommandExecution`; the Bridge
uses that event to update the original Bash node's final output, exit status, and completion position, and the node is still shown as `Ran` or
`Explored`. `Waited for background terminal` only represents a waiting streak formed by empty-stdin polling
and does not replace the original Bash node.

## 10. Verification Evidence

### 10.1 Local and Mixed Data

| Check | Result |
|---|---:|
| Codex rollout / SQLite thread comparison | 17 / 17 |
| Mixed catalog | 2403 Claude + 17 Codex = 2420 |
| Initialization dry-run final messages | about 4095 |
| metadata/message key conflicts | 0 |
| Bridge tests | 37 passed |
| Codex tests | 52 passed |
| Server tests | 22 passed |
| Frontend regression | 60 passed |
| Packaging boundary tests | 4 passed |
| Production build | passed |

175 local automated checks in total.

After Baton was actually upgraded it discovered 18 Codex Sessions, and recent or running Sessions wrote 4281
unique messages in total; REST pagination returned 4281, with 0 missing and 0 duplicates.

Phase 2 real-path verification used an isolated `CODEX_HOME` and started 2 Codex Sessions concurrently:

- rollout tool output and final replies all reached the App WS in real time.
- WS UUID duplicates 0, DDB UUID duplicates 0.
- Final metadata for both Sessions was `runtime=codex/status=completed`.
- Maximum observed latency from rollout to final-reply WS was 1363ms.
- The largest existing rollout is 22.4MB / 9072 lines. The ordinary append path dropped from about 207.7ms to
  138.4ms, with CPU time reduced by about 33.4%; the fixed safety scan changed from 30 seconds to 5 minutes, reducing scan frequency by 90%.

Phase 2 verification version `0.2.0-codex-p2-20260810-13` was deployed to `MacBook-Pro`, `baton_test`,
`test-ec2`, and `test-ec2-ap`; all four self-reported the same `bridgeVersion` in their WS connection records and were online.
For a real Codex turn on the Mac, the final assistant rollout reached the App WS in 1359ms, with 0 DDB UUID duplicates;
a real turn on Tokyo Linux produced 4 rows in total (user message, tool call, tool result, and final reply), with status
`completed` and no duplicates.

After removing the Codex WSL/polling branch, Codex uses a Parcel root subscription for discovery and bounded direct file watchers for active/recent
rollouts; Claude's existing WSL fallback stays unchanged. On the production Mac, a pure
assistant message took about 0.56 seconds from rollout timestamp to the real App WS, and the same UUID had only
1 row in DDB. Checking the local extractor against the DDB UUID set using the committed watermark showed 0 missing and 0 duplicates.

The Parcel 10,000-Session stress tests all used the real `CodexWatcher`, updating 100 different Sessions at once:

| Platform | Root subscriptions | Direct watchers | Initialization | RSS increase | Total FDs | 100 updates |
|---|---:|---:|---:|---:|---:|---:|
| macOS arm64 | 1 | 64 | 843.6ms | 39.6MB | 93 | 665.1ms |
| Linux x64 | 1 | 64 | 249.8ms | 41.4MB | 47 | 803.0ms |
| Windows x64 | 1 | 64 | 1812.0ms | 37.6MB | N/A | 1229.4ms |

All three runs had 100/100 arrivals, 100 unique UUIDs, 0 missing, and 0 duplicates. The Windows initial install script explicitly adds the
Node directory to PATH so the Parcel native package install script can find `node.exe`.

The Codex TUI also has a rollout variant that only writes `response_item role=user` and not `event_msg user_message`.
The scanner and extractor support both sources: the old format dedups identical content by count, and the new format fills in
preview, Session metadata, and user messages, while filtering `environment_context`/`turn_aborted`
internal context.

### 10.2 Native Windows

Tokyo `baton_test` Windows Server 2025 EC2 verification:

- Claude 2.1.148 and Codex 0.147.0 were both detected.
- The native Bridge runs without depending on WSL or tmux.
- Initialization produced 6 Sessions / 5 Projects.
- An old Codex Session backfilled 11 messages through the full on-demand path.
- Three samples were 11/11, 11/11, 10/10; message counts matched unique UUID counts.
- Counts did not increase after repeated opening, Bridge restart, reinstall, and auto-upgrade.
- PowerShell install, Task Scheduler auto-start, and commit-version upgrade passed.
- Phase 2 temporary source ran via SSM in a native Windows Node 22 environment; 4/4 watcher tests passed.
- A controlled rollout append to the deployed watcher was verified end to end through App WS, DDB, and `completed` metadata;
  a real model turn was not run because that machine's Codex credentials returned 401.
- The install script uses an `S4U` task, so the Bridge starts without an interactive user login.

### 10.3 Linux

Tokyo Linux EC2 ran the Phase 2 watcher tests with temporary source and a separate dependency install, 4/4 passed; the deployed
Bridge then completed WS/DDB/status verification of a real Codex turn.

## 11. Follow-Up Tasks

### Phase 3: Interaction

Completed:

1. app-server managed Unix WebSocket + stdio fallback client, initialize handshake, request pairing,
   notifications, and ServerRequest.
2. `thread/resume`, `turn/start`, same-Session queueing, interrupt, and all approval types for existing Sessions.
3. Codex deltas reuse Claude's `StreamFramer`, unified WS events, and the existing frontend streaming rendering.
4. Live-first, file-fallback semantics between complete app-server user/assistant rows and the rollout watcher.
5. Temporary app-server client lease per active thread; managed daemon closes the connection, stdio
   fallback exits the standalone process and releases the writer.
6. Structured conflicts with an external standalone Codex TUI, Web confirmation while running, automatic termination when idle, retry resume,
   and the cancel path.
7. Capability/UI entry point, `thread/start`, and first `turn/start` for new Codex Sessions.
8. managed daemon reuse, active turn/approval recovery, and new-message queueing; without a daemon the standalone
   stdio app-server lease is kept.
9. Passive subscription to managed TUI threads when a Session opens, pending approval replay, and
   two-sided prompt sync on `serverRequest/resolved`.
10. Runtime-aware `/` menu, legacy prompts, native Skills discovery/execution, and mobile command filtering.

Pending:

1. `turn/steer` and reconnect recovery of standalone pending approvals.
2. Remaining ServerRequest variants.
3. Linux/Windows explicit TUI takeover smoke tests and production gradual rollout.

### UX and Coverage

- Verify mobile expand performance for tool output near 360 KB.
- Decide whether to show a Thinking placeholder without body text.
- Define the upload and display contract for real multimedia input.
- Implement the Session metadata modal opened by clicking the runtime icon.
