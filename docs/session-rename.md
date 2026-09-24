# Native session rename

## Official interfaces

Verified on 2026-09-24 with Claude Code 2.1.280 and Codex CLI 0.155.1.

- Claude Code: reuse the existing `ClaudePool` / CLI stream-json control channel.
  Its native request is `{ subtype: 'rename_session', title, source: 'host',
  session_id }`, inside the existing `control_request` envelope. The CLI persists
  its own `custom-title` metadata; Baton does not write it directly. The session ID
  guard prevents renaming a different conversation if the process changes session.
  The CLI request has been verified against the installed version; it is not a
  new standalone `claude rename` shell command. `/rename` is the native interactive
  command documented at https://code.claude.com/docs/en/interactive-mode and CLI
  options are documented at https://code.claude.com/docs/en/cli-reference.
- Codex: the official app-server JSON-RPC method
  `thread/name/set` accepts `{ threadId, name }`. It supports loaded threads and
  persisted rollouts and emits `thread/name/updated`. `thread/read` returns
  `thread.name`; the native session index also reflects the change.
  Official reference: https://developers.openai.com/codex/app-server

The new UI does not submit `/rename` through the message composer. In particular,
the existing Codex slash-command handler resumes a thread before handling commands;
the Codex metadata-only path below does not resume or take over a running thread.
For Claude, an already-owned process receives only the control request. Otherwise,
a temporary CLI process loads the existing session using `--resume <id> --bare`,
initializes the control channel, renames, and exits cleanly. `--bare` skips project
hooks and plugin initialization; no user message or model turn is submitted. This
path never calls `stopDaemon` or interrupts an existing task. If the native CLI
refuses a locked session or does not support the request, the UI reports failure.

No SDK or new npm dependency is required. The initially added Agent SDK and its
transitive dependencies have been removed; both manifests match the original
dependency set.

## Implementation path

1. `web/js/app.js`: the edit button is visible by default alongside the Claude/Codex
   badges, with the same overflow behavior. New-session drafts have no edit button.
   The displayed root session is
   the rename target, including when viewing one of its subagents.
2. `web/js/components/session-rename.js`: opens an initially empty input on every
   invocation; trims the submitted name, rejects empty input, and disables repeat
   submissions while saving. Uses the existing `requestWsRpc()` with
   `action: 'rename_session'`. The shared `components/modal-viewport.js` helper
   centers form/confirmation dialogs above the keyboard, outside the transformed
   page, and releases viewport listeners when they close.
3. `server/src/bridge_ws.py` → `server/src/project/session_ws.py`: validates the
   request and routes it only to the selected device's Bridge. Responses must
   target an app connection in the same account. Other app connections receive a
   `session_title_changed` notification after native success.
4. `bridge/ws.mjs` → `bridge/session-rename.mjs`: validates the native UUID, title,
   local session file and project ownership, then invokes the official operation.
   Claude calls `ClaudePool.renameSession()` in `bridge/headless.mjs`; Codex
   prefers the owning home's managed app-server socket
   and falls back to an isolated stdio client using that same `CODEX_HOME`.
   No `thread/resume`, `turn/start`, writer takeover, or hand-written native
   metadata mutation is used by the rename implementation.
5. `POST /api/bridge/session-title` in `server/src/bridge_sync.py`: patches only
   `preview` on the existing device/project/session row. It does not recreate
   deleted sessions, update activity timestamps, or overwrite running status.
6. The response updates the visible title and saved navigation, invalidates the
   session-list/home caches, and updates thread metadata. A short-lived title
   guard prevents older Claude title messages from undoing the acknowledged name
   while the native history watcher catches up. Existing watchers continue to
   read Claude custom titles and the Codex native title index.

Names are limited to 200 characters and a single line. Native failure leaves the
current title unchanged. If native rename succeeds but the cloud metadata update
fails, the dialog explicitly reports partial success and permits retrying Save;
it does not claim synchronization succeeded or roll back the native name.

The native persisted name is synchronized. An already-open native TUI may need
to refresh/reopen its session picker to display externally changed metadata;
instant repaint of every native client is not assumed.

## Local verification

```sh
node --test test/bridge/session-rename.test.mjs test/codex/phase3/app-server.test.mjs
python3 -m pytest test/server/test_session_rename.py -q
BATON_TEST_NATIVE_RENAME=1 node --test test/frontend/session-toolbar.test.mjs
npm run build
```

The opt-in native test creates temporary Claude/Codex homes and synthetic history
fixtures, clicks the real title/edit/dialog controls in JSDOM, and submits through
the real frontend RPC and Bridge rename handler. Each runtime is renamed twice.
It checks the updated UI and Claude's CLI-written title via the existing history
reader, plus a fresh Codex app-server client and Codex's history scanner. Temporary files and
processes are cleaned up. Existing personal sessions are not renamed, and no
model turn is started.

AWS transport and the catalog POST are stubbed in this local UI/native test;
server routing, account/device isolation and the conditional preview-only update
are covered separately with local server tests. This is not a deployed AWS
end-to-end verification or a manual native-TUI repaint test.

Existing-session verification also confirmed native metadata, local history
readers and both real server list/detail endpoints agreed after rename and after
restoring the original display names. Conversation-record hashes were unchanged.
This does not verify immediate repaint of an already-open native terminal.

To use the new edit-button/RPC feature outside these tests, release the frontend,
Bridge, HTTP server and WebSocket Lambda together. The WebSocket
module lives under the already-packaged `project/` directory. No table migration
or new WebSocket IAM permissions are required.
