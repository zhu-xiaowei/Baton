# Tool previews and on-demand details

Newly synchronized tool data always keeps the first 500 Unicode characters of each
large text field in IN/OUT. Object structure, tool IDs, paths and status metadata
are preserved. Truncated `tool_use` or `tool_result` blocks carry
`truncated: true` inside `content`; `thinking.signature` is omitted.
The original JSONL is never changed. There is no opt-in or compatibility switch;
any historical `toolPreviews` configuration value is ignored. Clients must support
`tool_details` to load complete content.

`toolUseResult` is omitted unless it contains the numeric Agent statistics
`totalDurationMs` or `totalToolUseCount`. Only those two fields are retained.
This also applies to on-demand detail replies; output text remains in `content`.

Bash input omits `cmd` only when it is identical to the retained `command`.
`codexCommandActions` omits each action's unused `cmd`, retaining its type and
summary fields. This applies to synchronization, realtime delivery and detail
replies; original JSONL data is unchanged.

Edit is loaded on demand: only its file path and status are synchronized, with
`truncated: true`. Old/new code, the original file and structured patch metadata
are omitted. Failed Edit output preserves its error preview rather than replacing
the reason with a generic message; successful create-style edits retain Created.
Failed output is marked truncated only when it exceeds the preview limit, so a
short failure does not offer redundant Show more. Codex identifies Edit results
with an internal tool-name marker; Claude uses its existing edit-result metadata.
Its live input deltas carry no code, while preserving event sequence.

Messages are prepared once and reused for HTTP persistence, watcher delivery and
live authoritative messages. A module-local WeakSet recognizes already prepared
message objects. Streaming input keeps its first 500 characters;
later events retain their sequence numbers with empty text and
`previewTruncated: true`. At block stop, a `replaceInput` event supplies valid JSON
containing the structured preview (including Edit paths), replacing the partial
JSON prefix. Authority preserves block-level flags. Assistant text and permission
events are unaffected.

These content flags are separate from the existing event/message-level
transport `truncated` flag. Existing frame-size protection, `stream_end`,
`recoveryRequired` and REST recovery behavior are unchanged.

## Details RPC

The tool header opens the local preview without a request, keeping the same
default height of about three lines per IN/OUT value as other tools.
Other truncated tools display Show more, even when their preview does not overflow.
Show more expands available complete content locally. If the content is truncated
and not cached, that same control shows a loading spinner and requests full details
before expanding. Clicking the IN/OUT content area uses the same behavior; selecting
text for copying does not expand or request data:

```json
{
  "action": "tool_details",
  "requestId": "uuid",
  "sessionId": "session uuid or codex:uuid",
  "device": "device name",
  "toolUseIds": ["tool id"]
}
```

Opening a group only exposes its local previews. Show more requests its own tool,
not the whole group. The server routes to that device and returns replies only to
the requesting app.
The Bridge locates the native session file and matches the normalized tool IDs.
Reading and parsing happen in a worker so they do not block streaming or heartbeats.
The worker retains one file's tool index, keyed by path, runtime, session and file
stat version; an unchanged file is indexed once across detail requests. File changes
invalidate the index. This is not an incremental parser.
It returns full `toolUse` / `toolResult` pairs using the existing text-frame RPC:
`sequence`, `content`, and a final `complete: true`.
Frame limits are checked after JSON encoding, including multibyte text.

The browser keeps the preview visible while loading and assembles all frames before
rendering the full details. It caches details for the
current device/session and reuses them while their preview data is unchanged.
If an expected tool result is not persisted yet, the response is not cached as
complete and can be retried. Input-only tools can load before a result exists;
the later result invalidates that cache.
Failed requests expand the available local preview and can be retried. A late response cannot
update a different session. Details are never sent through the normal history
write path or persisted back to DynamoDB.

Clicking an Edit header requests its full details and shows only a spinner
at the right of that same row. The body stays collapsed until the existing diff
renderer finishes. The complete diff stays in the current device/session's
memory cache, so collapsing and reopening does not request it again. Changed
preview data invalidates that cache. No OLD/NEW preview or redundant Modified
status is rendered. Historical full Edit records without a preview marker
continue to use their existing local rendering.
Opening the complete file from a loaded Edit resolves separate changed blocks
with nearby context and highlights their line ranges. File reads include a content
hash, so an unchanged version reuses cached ranges and a changed version is
matched again. Missing or ambiguous blocks are not highlighted. Opening the file
before loading the Edit does not request its details. These locations and versions
stay in memory and are never written to DynamoDB.

Historical DynamoDB records are not rewritten by this feature. An unavailable
Bridge or missing source file leaves the preview readable but prevents loading
the full details.
