# Project Shared Terminals and Stream Channels

Terminals and port previews travel as **stream frames** on the App's one direct socket — the
same `app_data` connection that carries RPC and pushes (`docs/v2-architecture.md`). Opening a
terminal or a preview creates no WebSocket, no join token and no Lambda call: API Gateway's HTTP
integration forwards every signed frame straight to `@connections/{target}`.

## Stream frames

```text
{ v: 2, kind: 'stream', ch: 'terminal' | 'preview', id, from, m, inflate? }
```

- `id` is the page's terminalId / tunnelId (≤64 chars); `from` is the sender's connection ID (the
  Bridge writes `bridge`); `m` is one channel message.
- The frame goes through the existing `push` route, signed like RPC frames (SigV4 header signing,
  about 1.5 KB overhead, the signed frame ≤28 KiB).
- `m.data` (base64) is deflated when that saves at least 10% and is at least 512 characters, and
  marked `z: 1` (`packStreamMessage` / `unpackStreamMessage` in `bridge/direct-rpc-protocol.mjs`).
  Pages send `inflate: 1` when they have `DecompressionStream`; the Bridge sends compressed data
  only to such pages (iOS 14 WebViews have none).
- The Bridge follows each page's latest connection ID (`channel.follow(frame)` in `bridge/ws.mjs`),
  so a page whose socket was rebuilt keeps its terminal and tunnel.
- There is no per-session HMAC. The account's STS credentials can post to any connection on the
  data API (IAM cannot scope `@connections` to one ID), so the boundary is the account, as for RPC;
  end-to-end encryption is the later fix (`docs/v2-architecture.md`).

## Pages and Sessions

The user chose that all pages can type, with no single-writer lock, takeover button, or input
prediction. If two pages type at the same time, the Bridge applies each page's input in its own
sequence order, without cross-device command transactions.

- A Terminal icon on each project's session list lazily loads `web/js/terminal.js` and xterm.
- One Bridge keeps at most 5 Shells per normalized project directory. All pages selecting the same
  `sessionId` type into and see the same Shell. Names are Terminal 1–5 (smallest free number);
  `sessionId` and `epoch` are never reused.
- First entry with no terminal creates one atomically; otherwise the page's sessionStorage
  selection, else the first one. Close terminates the selected terminal and moves its viewers to the
  first remaining one; with one left, close becomes restart (the new Shell starts before the old one
  is stopped).
- Leaving the page keeps a valid instance for 60 seconds; leaving only detaches, never ends the
  Shell. A later page restores the screen, then receives live output.
- Input is bound to `sessionId` + `epoch`, so old input never reaches another Shell. Management
  operations with an uncertain result are not resent; the page reconnects and reloads the list.
- A joining page does not change the shared size until it types, focuses or resizes.
- macOS / Linux only. A Bridge restart ends the PTYs.
- The Bridge answers OSC 10/11/12 color queries from the latest page's `light`/`dark` theme
  (`open.theme` or a `theme` event). Browsers suppress automatic DA, DSR, DECRQM and DECRQSS replies,
  which Vim would otherwise read as keystrokes from every page.

## Terminal channel messages

- Page → Bridge: `open {projectHash, sessionId?, cols, rows, theme}`, `input`, `resize`,
  `heartbeat`, `render_ack`, `theme`, `detach`, `create_session`, `select_session`,
  `close_session`. Every message carries `clientSeq` (`open` = 0).
- Bridge → page: `ready`, `snapshot`, `synced`, `output`, `resized`, `peers`, `exit`, `error`,
  `ack`, `sessions {limit, sessions:[{id,name,exited}]}`, `session_result {requestId, error?}`.
  Every message carries `eventSeq`; `ack` and connection errors use `eventSeq: 0`.
- The page resends unacknowledged input every 1.5 s; the Bridge acknowledges a duplicate without
  applying it. Output is reordered by `eventSeq`; a gap not filled within 3 s ends the stream and the
  page reconnects with a fresh snapshot.
- A frame for a terminalId the Bridge does not know (it restarted, or the page was dropped) is
  answered with an error, and the page reconnects with `open`.

## Bridge screen, limits and flow control

`bridge/terminal-shared.mjs` uses node-pty 1.1.0, @xterm/headless 6.0.0, @xterm/addon-serialize 0.14.0.

| Item | Current limit / behavior |
|---|---|
| Per project | 5 terminals (including exited, not yet closed) |
| Same Bridge | 20 terminals and 16 page attachments |
| Input | ≤4 KiB raw per frame; one input / paste ≤64 KiB, rejected entirely if larger |
| Output batching | Output is written to the mirror immediately and sent every 16 ms (about 60 updates a second), up to 64 KiB raw per message; packed output over 20000 characters is sent as plain 16 KiB chunks |
| Snapshot | ≤4 MiB in 16 KiB chunks with a 4-chunk window; output already in the mirror but not yet sent is flushed to the other pages first, so the joining page never receives it twice |
| Slow page | 512 KiB unacknowledged output per page; overflow drops only that page |
| Mirror backpressure | PTY reads pause above 256 KiB queued, resume below 64 KiB, 1 MiB hard cap |
| Lifecycle | Page heartbeat 30 s, page gives up after 90 s silent; the Bridge drops an attachment after 90 s without messages; PTYs are kept |

## EC2 real PTY echo measurement (2026-09-16)

Measured through the header-signed HTTP integration (the same forwarding path as today) between a
client and a Bridge on `test-ec2-ap`, with `cat` in a real PTY:

| Scenario | Samples | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: |
| In-process PTY write / read baseline | 60 | 0.064ms | 0.103ms | 0.248ms |
| EC2 → cloud forwarding → EC2 PTY → cloud forwarding → EC2 | 180 | 34.10ms | 56.59ms | 142.76ms |
| Same, one character every 8 ms | 186 | 38.13ms | 133.68ms | 157.04ms |

## Measured API Gateway constraints

- `@connections` cannot be scoped by IAM to one connection ID (`/POST/@connections/<id>` in a session
  policy returns 403); the resource is `/POST/@connections/{connectionId}`.
- Header signing with `UNSIGNED-PAYLOAD` does not fix the body; the body is signed.
- Raw HARs and WS frames from tests contain API keys and short-lived credentials: keep them outside
  the repository.
