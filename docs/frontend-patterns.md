# Frontend Patterns (Web Viewer)

Verified frontend logic from the web viewer (`web/`).

Claude Code and Codex share the same Device → Project → Session navigation and message
components. Runtime differences stay in identity, icon, action labels, accent, and capability
checks; see [codex.md](codex.md).

---

## 0. iOS Keyboard / Viewport

iOS Safari does not shrink `window.innerHeight` when the keyboard appears — it only shrinks `visualViewport.height`, causing the input bar to be hidden behind the keyboard.

```javascript
// ws.js: listen to visualViewport resize, sync body height
if (/iPhone|iPad|iPod/.test(navigator.userAgent) && window.visualViewport) {
  window.visualViewport.addEventListener('resize', function () {
    document.body.style.height = window.visualViewport.height + 'px';
  });
}
```

Keyboard detection baseline: `_vpBaseHeight = visualViewport.height` (snapshot at page load). After sending a message, don't blur the input to keep the keyboard open.

## 1. Auth & Connection

```
localStorage: _ak (btoa API key), _as (server URL)
```

1. `initConnection()`: GET `/api/health` to verify connectivity
2. GET `/api/bridge/config` to get `wsUrl` (WebSocket endpoint)
3. All REST requests include `x-api-key` header

## 2. Navigation & State Restore

Hierarchy: **Devices → Projects → Sessions → Messages**

```
appState = { device, project: { hash, name }, session, sessionPreview }
```

- Each navigation updates `appState` and persists to `localStorage('baton-nav')`
- On startup, reads persisted state and jumps directly to the last page (skips intermediate hierarchy loading)
- When switching sessions: `disconnectWs()` first, then connect to new session

## 3. Entering a Session: Initial Message Load

**Key design: subscribe to WS first, then pull history from DDB, merge and deduplicate.** This ensures no real-time messages are lost during the loading period.

```
loadMessages(sessionId):
  1. wsAllMessages = [], wsMessageUuids = Set(), reset state
  2. startWs(sessionId) → subscribe → reveal_permission
  3. _wsBuffer = []          ← buffer no-seq JSONL/TUI messages
  4. GET /api/bridge/messages?session=X&device=D&project=P
                                ← pull history + current Session status
  5. merged = _wsBuffer.concat(ddbMessages)
  6. _wsBuffer = null         ← disable buffer, subsequent WS messages render directly
  7. Deduplicate by uuid/nativeId
  8. Sort by timestamp
  9. Resolve state: newer applied WS lifecycle → response status → message-tail fallback
  10. renderMessages(wsAllMessages)  ← full render
  11. Rebind any active strict-stream preview by turnId
  12. pinContentToBottom
```

No-seq `messages` are historical JSONL/TUI updates and use the REST buffer above. Events carrying
`turnId + seq` belong to a live turn: they immediately enter `TurnEventQueue`, remain strictly
ordered, and survive the first history render through DOM rebind. Authority and REST rows share the
same UUID/nativeId deduplication set.

`reveal_permission` is intentionally narrower than message replay. It asks the Bridge to resend only
the current pending permission state after entering or reconnecting to a Session. Existing CC hook
permissions are returned from the Bridge queue; Codex TUI permissions are discovered by attaching a
permission-only observer to the managed app-server. No text, tool, or delta history is replayed.

When a window joins an active turn, `seq=0` starts normal streaming and `seq=1 messages(user)` can
synthesize the payload-free start. If the first available seq is greater than 1, the frontend does
not display a block whose start is missing. Complete authority renders missed nodes, the next
`stream_block_start` resumes streaming, and `stream_end` supplies complete deduplicated authority
for any remaining nodes. No time-based grace is used to expose partial stream content.

**`needSync` handling**: If DDB has no messages and `needSync=true` (bridge is syncing), show
loading state. Wait for `sync_complete`, then use the same `bufferAndFetch` merge path without
resetting the live DOM or Session navigation state.

## 4. Real-time Message Handling (WS)

### 4.1 WS Message Types

| action | Direction | Handling |
|--------|-----------|----------|
| `messages` | Server → App | New messages arrived, incremental render |
| `permission_request` | Server → App | Permission confirmation popup (server-side detection) |
| `send_message_result` | Server → App | Send confirmation + new session's sessionId |
| `sync_complete` | Server → App | Bridge sync complete, re-run `bufferAndFetch` and incrementally reconcile |
| `interrupt` | App → Server → Bridge | Interrupt current run (equivalent to Ctrl+C) |

### 4.2 Message Classification

Each message is routed by type:

```
New message arrives:
  ├── isToolResultOnly?   → update corresponding tool node in-place by tool_use_id
  ├── strict user         → promote the exact optimistic bubble by turnId
  ├── no-seq user         → insert as a historical message
  ├── ai-title            → update breadcrumb title, don't render to message list
  ├── isInterrupt         → render as tl-item (type=interrupt), placed in assistant-turn
  └── assistant           → strict turn reconcile or historical insertion
```

### 4.3 tool_result In-place Update

tool_result messages don't create new DOM nodes. Find the already-rendered tool_use node by `tool_use_id` and replace its innerHTML:

```
container.querySelector('[data-tool-id="' + tool_use_id + '"]')
  → node.innerHTML = renderToolNode(toolUseBlock, resultBlock)
```

## 5. Message Ordering & Insertion

消息使用两条明确分离的插入路径：

- 带 `turnId + seq` 的 active turn 由 `TurnEventQueue` 排序，并按
  `data-anchor=turnId` 插入对应问题下方。
- 无 seq 的 REST 历史与外部 TUI/IDE JSONL 消息携带 `data-ts`，按 timestamp
  插入历史时间线。

timestamp 只用于历史展示顺序，不参与 active turn 的归属、传输排序或 DOM
接管。

### 5.1 Assistant Message Insertion

```
Render html (may contain multiple tl-items, each with data-ts)
  │
  ▼
Scan all .tl-item[data-ts] from back to front
Find first with data-ts > msg.timestamp → target
  │
  ├── Found → target.insertAdjacentHTML('beforebegin', html)
  │          (auto-inserts into the assistant-turn containing target)
  │
  └── Not found (latest message)
       ├── Last element is assistant-turn → append to end
       └── Otherwise → create new assistant-turn
```

### 5.2 User Message Insertion

```
findInsertBefore(container, timestamp):
  Scan container's direct children from back to front by data-ts
  Find first > timestamp → insert before it
  Not found → append to end (before pending messages)
```

### 5.3 DOM Structure

```
.messages (container)
  ├── .msg-user [data-ts]          ← user message (direct child of container)
  ├── .assistant-turn [data-ts]    ← assistant reply group
  │     ├── .tl-item [data-ts]     ← thinking / text / tool
  │     ├── .tl-item [data-ts]
  │     └── .tl-item [data-ts]
  ├── .msg-user [data-ts]
  └── .assistant-turn [data-ts]
        └── .tl-item [data-ts]
```

## 6. Auto-scroll

`state.stickBottom` records user intent. Opening a Session or sending a message enables it; manually
scrolling away from the bottom disables it. Every insertion uses the same bottom pin:

```javascript
function pinContentToBottom(force) {
  if (force) state.stickBottom = true;
  if (!state.stickBottom) return;
  content.scrollTop = content.scrollHeight;
  requestAnimationFrame(() => {
    if (state.stickBottom) content.scrollTop = content.scrollHeight;
  });
}
```

The immediate scroll follows the DOM mutation. The animation-frame scroll absorbs layout changes
from OUT replacement, markdown, and clamping. Streaming does not use smooth scrolling because it
races continuously arriving content. Permission prompts force-enable bottom following.

## 7. wsRunning State + Send/Stop Button

`wsRunning` controls the input bar button appearance:

```
wsRunning updates:
  initial/recovery REST status   → running=true; needs_input/completed=false
  stream_turn_start              → true
  stream_end                     → recompute from outstanding turns
  permission_request             → false, while preserving the live turn
  permission_resolved            → recompute from outstanding turns
  doSend()                       → true
```

During initial loading, only applied WS lifecycle events override the returned status. Fragments
such as deltas, tool input, or authority messages do not independently prove whether a turn ended.
The old message-tail `deriveRunning()` logic is used only when the REST response has no status.

### Button State Machine

```
Has text input              → show send arrow (↑), click sends message
No text + wsRunning         → show stop square (■), click interrupts session
No text + !wsRunning        → show send arrow, disabled
```

### Interrupt (Stop Running)

```
interruptSession():
  activeTurnId = activeTurnForInterrupt()
  wsSend({ action: 'interrupt', sessionId, device, turnId: activeTurnId })
```

Equivalent to Ctrl+C / Escape in the CC terminal. Bridge SIGINTs the session's headless Claude Code process.
Sending the request does not optimistically stop loading or create an Interrupted row: the runtime may reject
the interrupt or emit a few final deltas. The active turn remains running until its ordered `stream_end`.
Runtime authority emits the single Interrupted message before that end event.

Besides clicking the stop button, pressing `Esc` anywhere (input focused or not) interrupts the running turn, mirroring CC — but yields to overlays that own Esc (slash popup, permission prompt, file/image viewer, new-project modal) and ignores IME composition.

## 8. WS Disconnect & Reconnect

```
ws.onclose:
  1. Discard the old turn seq buffers, but keep the rendered DOM unchanged
  2. State changes to 'reconnecting'
  3. Reconnect via connectWs() after 3 seconds

ws.onopen (on reconnect):
  1. Re-subscribe to current sessionId
  2. Start one incremental REST request; the response includes Session status
  3. Buffer new strict turn events until REST completes
  4. Merge REST history, then release buffered WS events through the normal queue
  5. completed → settle recovered turns
  6. running → preserve outstanding turns and spinner
  7. needs_input → preserve the turn but hide spinner/Stop state
  8. Replace an old partial block in place when its authoritative messages arrive

recoverMissing():
  1. bufferAndFetch(sessionId, after=wsLastTimestamp)  ← only pull incremental during disconnect
  2. Merge and deduplicate into wsAllMessages
  3. If new messages exist → incrementally render only unseen history
```

**`wsLastTimestamp`**: Updated to the latest timestamp each time a new message is received. Used as the incremental query start point on reconnect.

Foreground restoration uses the same reconnect pipeline as an unexpected WS close.
The old socket is intentionally replaced, but its partial DOM remains visible until
the matching authoritative message replaces it. `stream_block_stop` only closes the
input stream; it does not contain full content. Navigation away from the detail page
still disconnects and clears the whole streaming state.

There is no online inactivity timer and no separate `reveal_turn_state` request. A healthy
connection trusts ordered WS lifecycle events; foreground/reconnect recovery uses the status
returned by the required incremental message request.

## 9. New Session Creation

```
startNewSession(projectHash):
  1. Read device runtimeCapabilities and keep entries with canCreate=true
  2. Auto-select a single runtime, or restore the last per-device choice
  3. appState.session = '__new__'
  4. Reset all message state
  5. connectWs(null, projectHash)  ← WS connection carries projectHash
  6. Show empty message page + input bar

User sends message:
  1. Create turnId and wsSend({ action: 'send_message', projectHash, runtime, requestId, turnId, text, device })
     (Note: no sessionId, projectHash tells bridge to create a new session)
  2. Optimistically render user message

Bridge handling:
  → Claude: mint sessionId, return send_message_result, then spawn headless with --session-id
  → Codex: thread/start, return codex:<threadId>, then turn/start on the same app-server client

On receiving sessionId:
  1. appState.session = msg.sessionId (replace '__new__')
  2. loadMessages(sessionId)  ← normal load flow
```

## 10. Sending Messages & Optimistic Rendering

```
sendMessage():
  1. Generate turnId
  2. WS send { action: 'send_message', sessionId, turnId, text, device }
  3. Record pendingSentMessages by turnId
  4. Insert optimistic message with data-anchor=turnId

WS returns send_message_result { ok: true }:
  → Find the exact pending turnId → mark delivered

WS receives real user message:
  → Match exact turnId → promote the same DOM node and apply authoritative uuid/timestamp
```

## 11. Permission Prompt

Claude headless sends a structured `permission_request` when it receives a `control_request`.
The frontend does not infer permission state from tool messages.

Live turn permission events carry the turn's normal `seq`. When a window enters while a live turn is
waiting for approval, Bridge re-emits the pending `permission_request` with a fresh `seq`. The
frontend treats that request as a safe resume checkpoint, so the subsequent
`permission_resolved`, tool result, and later nodes continue without waiting for the missed prefix.
External TUI permission state has no live turn and remains a standalone control event. Both paths
update the Session row to `needs_input` with the current permission detail.

Because permission is control-plane UI, a sequenced permission event blocked behind a missing
render seq gets a short idempotent fallback dispatch. This can show or dismiss the prompt without
advancing the strict stream queue; when the ordered copy is later consumed it is ignored as a
duplicate. Content deltas and tool nodes never use this fallback.

If a request arrives while the detail page still shows its skeleton, it stays deferred until
`.messages` exists. A matching resolution during loading cancels it. Once rendered, the prompt is
appended at the bottom and force-pinned in the current and next layout frame.

### 11.1 Request Types

- `kind=tool`: show allow/deny for Bash/Edit/Write/MCP and other tools.
- `kind=ask`: render all `questions[]` in order, preserving labels and descriptions.
- `kind=plan`: show accept or typed feedback.

### 11.2 Input Bar Disabled During Prompt

When showing a permission prompt, the bottom input bar and its buttons are disabled. They are
restored when the prompt is answered or dismissed.

### 11.3 User Actions

```
wsSend({
  action: 'permission_reply',
  sessionId,
  device,
  requestId,
  decision: 'allow' | 'deny' | 'answer',
  answerText
})
```

## 12. Image Handling

### Sending Images
```
Select/paste image → compress (720p JPEG) → upload to S3 → get key
On send: text + '\n![](baton-bridge:key)'
Bridge receives → download from S3 → replace with local path → CC Read tool reads it
```

### Displaying Images
```
Image block { type: 'image', key } in message → render as .img-placeholder[data-key]
IntersectionObserver (rootMargin 200px) → load via GET /api/bridge/image/:key when entering viewport
LRU cache (max 200)
```

## 13. User Message XML Tag Filtering

CC internally injects many XML tags into user messages (IDE context, system reminders, etc.) that must be filtered before display.

```
renderUserBubble(msg):
  1. Extract <command-name> → display as /slashCmd prefix
  2. Remove: <command-message>, <command-args>, <local-command-caveat>
  3. Remove: <ide_selection>, <system-reminder>, <task-notification>
  4. Extract <ide_opened_file> → render file path as file badge
  5. Extract plain text /command prefix → also display as slashCmd
  6. Extract ![](baton-bridge:key) → render as image
  7. Extract document content blocks → render as expandable file badge
```

**Consequence of not filtering**: user messages would display pages of XML noise (hundreds of lines of system-reminder, etc.).

## 14. Markdown Rendering

Assistant text blocks rendered to HTML via `renderMd(text)`:

```
marked.js (GFM + breaks) + highlight.js (code highlighting)
```

## 15. Thinking Block Rendering

`thinking` blocks in assistant messages rendered as collapsible regions:

```
{ type: 'thinking', thinking: '...', duration_ms: 5000 }
  → "Thought for 5s ›" (collapsed by default)
  → Click to expand and show thinking content (plain text)
```

## 16. Tool Rendering Categories

Each tool_use has a dedicated rendering mode. Common structure:

```
tool-node
  ├── tool-header: [tool-name] [tool-desc] [tool-status?]
  └── tool-body (collapsible)
       └── tool-body-content
```

### Tool Rendering Rules

| Tool | desc | body |
|------|------|------|
| **Bash** | `description` or first 60 chars of command | IN: `<code>command</code>` + OUT: result text |
| **Read** | file path + `(lines N-M)` | result text (hidden entirely if empty) |
| **Edit** | file path | **diff2html** render old_string→new_string (with syntax highlighting), auto-collapse if height >240px |
| **Write** | file path | result text |
| **Grep/Glob** | pattern + path | result text |
| **TodoWrite** | (empty) | checklist: ✓completed (gray+strikethrough), \*in_progress (white), ○pending (gray) |
| **Agent** | description or subagent_type | stats: `N tool calls, Ns`; running shows real-time timer; result text |
| **Other** | first 80 chars of JSON | IN/OUT grid |

### Error State

`result.is_error` or result text contains error/failed/permission denied → tool-node gets `.error` class (red border).

## 17. Clamp/Expand Long Content Folding

Must call `clampOverflow(container)` after every render (both full and incremental):

```
clampOverflow():
  ├── .msg-text: scrollHeight > 60px → add clamped + "Show more" button
  ├── .tool-value.clamp: overflow → "Show more"
  ├── .tool-body-content.collapsible: → "Show more"
  └── .tool-body-content with overflowing .tool-value → "Show more"

toggleExpand(el):
  ├── .msg-text → toggle clamped/expanded
  ├── .tool-body-content → toggle open
  └── .tool-value → toggle expanded
  → Update button text "Show more" ↔ "Show less"
```

## 18. Post-render Checklist

After every DOM update (full render / incremental updateLastTurn / reconnect recovery):

```
1. loadImages(container)    — register IntersectionObserver for lazy-loading images
2. clampOverflow(container) — detect overflow, add collapse buttons
3. pinContentToBottom       — immediate + next-frame pin when stickBottom=true
```

## 19. Runtime Presentation

- Missing or unknown runtime normalizes to `claude`; a `codex:` storage ID also identifies Codex.
- Claude displays the first 8 native ID characters; Codex displays the last 8.
- Runtime icons appear on Session cards and in the detail header without changing page hierarchy.
- Codex reuses the shared renderer with display-only names such as `Explored`, `Ran`, `Edited`,
  `Updated Plan`, and `Viewed Image`.
- Codex command presentation follows persisted lifecycle metadata instead of shell regexes:
  `parsed_cmd` controls `Explored`, independent `Ran` nodes use completion order, repeated empty
  `WriteStdin` calls collapse by process into one wait streak, and `CommandExecution` replaces
  wrapper output without renaming the original command.
- Codex MCP calls use persisted `McpToolCall.server/tool` metadata: pending calls display `Calling`,
  completed calls display `Called`, and the summary keeps `server.tool`. Claude generic tool names
  do not enter this runtime-specific path.
- Codex Bash IN keeps the original command. OUT uses finalized aggregate output; transport wrapper
  fields are superseded and exit codes render as status rather than being appended to output text.
- Codex changes only runtime accent positions to `#13A7CD`; tool titles remain shared white.
- Full load, pagination, WS insertion, and result updates pass runtime explicitly to one renderer.
- Codex Phase 2 keeps the input layout; Bridge capabilities reject unsupported interaction.
