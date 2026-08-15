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
  2. startWs(sessionId) → subscribe
  3. _wsBuffer = []          ← enable buffer mode, WS messages stored without rendering
  4. GET /api/bridge/messages?session=X  ← pull history from DDB
  5. merged = ddbMessages.concat(_wsBuffer)
  6. _wsBuffer = null         ← disable buffer, subsequent WS messages render directly
  7. Deduplicate through the current Session's persistent UUID Set
  8. Sort by timestamp
  9. renderMessages(wsAllMessages)  ← full render
  10. scrollToBottom
```

The UUID Set is maintained alongside `wsAllMessages` for initial load, pagination, reconnect
recovery, and final `messages` frames. This makes final-message deduplication O(1) per row.
`stream_delta` and `stream_tool_input` bypass the Set and render immediately; no event window,
debounce, or batch delay is introduced.

**`needSync` handling**: If DDB has no messages and `needSync=true` (bridge is syncing), show loading state. Wait for `sync_complete` WS event, then re-run loadMessages.

## 4. Real-time Message Handling (WS)

### 4.1 WS Message Types

| action | Direction | Handling |
|--------|-----------|----------|
| `messages` | Server → App | New messages arrived, incremental render |
| `permission_request` | Server → App | Permission confirmation popup (server-side detection) |
| `send_message_result` | Server → App | Send confirmation + new session's sessionId |
| `sync_complete` | Server → App | Bridge sync complete, re-run loadMessages |
| `interrupt` | App → Server → Bridge | Interrupt current run (equivalent to Ctrl+C) |

### 4.2 Message Classification

Each message is routed by type:

```
New message arrives:
  ├── isToolResultOnly?   → update corresponding tool node in-place by tool_use_id
  ├── user + !isInterrupt → tryDedup first (match against sent optimistic messages), then insert by timestamp
  ├── ai-title            → update breadcrumb title, don't render to message list
  ├── isInterrupt         → render as tl-item (type=interrupt), placed in assistant-turn
  └── assistant           → update wsRunning state, insert by timestamp (see next section)
```

### 4.3 tool_result In-place Update

tool_result messages don't create new DOM nodes. Find the already-rendered tool_use node by `tool_use_id` and replace its innerHTML:

```
container.querySelector('[data-tool-id="' + tool_use_id + '"]')
  → node.innerHTML = renderToolNode(toolUseBlock, resultBlock)
```

## 5. Message Ordering & Insertion

**Core principle: all elements (tl-item, user-msg) carry `data-ts`, inserted by scanning for timestamp position.**

WS message arrival order != timestamp order (bridge push has varying delays), so must insert by timestamp.

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

**Check before DOM insertion** whether near-bottom, then decide whether to scroll after insertion:

```javascript
// Before insertion
var wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 300;

// ... DOM insertion ...

// After insertion
if (wasNearBottom) {
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  setTimeout(() => el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }), 150); // compensate after clampOverflow
}
```

**Why not check after insertion**: large messages (e.g. CC final result 10+ lines) increase scrollHeight beyond the threshold, causing a false "user is not at bottom" judgment that prevents scrolling.

## 7. wsRunning State + Send/Stop Button

`wsRunning` controls the input bar button appearance, updated from 4 sources:

```
wsRunning updates:
  loadMessages(_, _, status)     → wsRunning = (status === 'running')
  Receive assistant message      → wsRunning = (stopReason !== 'end_turn')
  doSend()                       → wsRunning = true
  interruptSession()             → wsRunning = false
```

### Button State Machine

```
Has text input              → show send arrow (↑), click sends message
No text + wsRunning         → show stop square (■), click interrupts session
No text + !wsRunning        → show send arrow, disabled
```

### Interrupt (Stop Running)

```
interruptSession():
  wsSend({ action: 'interrupt', sessionId, device })
  wsRunning = false
  updateSendBtn()
```

Equivalent to Ctrl+C / Escape in the CC terminal. Bridge SIGINTs the session's headless Claude Code process.

Besides clicking the stop button, pressing `Esc` anywhere (input focused or not) interrupts the running turn, mirroring CC — but yields to overlays that own Esc (slash popup, permission prompt, file/image viewer, new-project modal) and ignores IME composition.

## 8. WS Disconnect & Reconnect

```
ws.onclose:
  1. State changes to 'reconnecting'
  2. Reconnect via connectWs() after 3 seconds

ws.onopen (on reconnect):
  1. Re-subscribe to current sessionId
  2. If wsLastTimestamp exists → recoverMissing()

recoverMissing():
  1. bufferAndFetch(sessionId, after=wsLastTimestamp)  ← only pull incremental during disconnect
  2. Merge and deduplicate into wsAllMessages
  3. If new messages exist → full re-render (container.innerHTML = renderMessages)
```

**`wsLastTimestamp`**: Updated to the latest timestamp each time a new message is received. Used as the incremental query start point on reconnect.

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
  1. wsSend({ action: 'send_message', projectHash, runtime, requestId, text, device })
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
  1. WS send { action: 'send_message', sessionId, text, device }
  2. Record in pendingSentMessages { id, text }
  3. Insert optimistic message at DOM end (with data-pending, shows "sending...")

WS returns send_message_result { ok: true }:
  → Find first unconfirmed pending → mark delivered, update status to ✓ + time

WS receives real user message:
  → tryDedup: match text against pendingSentMessages
  → Matched → promote the optimistic DOM node in place and apply the authoritative timestamp
```

## 11. Permission Prompt

Claude headless sends a structured `permission_request` when it receives a `control_request`.
The frontend does not infer permission state from tool messages.

### 11.1 Request Types

- `kind=tool`: show allow/deny for Bash/Edit/Write/MCP and other tools.
- `kind=ask`: render all `questions[]` in order, preserving labels and descriptions.
- `kind=plan`: show accept or typed feedback.
- Bridge can resend a pending request after reconnect through `reveal_agent`.

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
3. auto-scroll judgment     — wasNearBottom → scrollToBottom
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
