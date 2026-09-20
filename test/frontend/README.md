# Frontend streaming tests

The streaming suite drives the real `web/js/ws.js` dispatcher in jsdom.

The live protocol has one ordering rule:

```text
turnId identifies the turn
seq orders every shared event in that turn
```

`TurnEventQueue` receives all live `stream_*`, strict `messages`, and permission
events before the renderer sees them. Tests cover:

- all permutations of a complete turn;
- duplicate and conflicting sequence numbers;
- stop, authority, and end arriving before missing deltas;
- `seq=1` recovery, missed-node authority, and next-block late-join recovery;
- one latest-200 REST loader for initial entry, foregrounding, reconnect and end recovery;
- single-boundary tail replacement, preserving older pages only when the boundary matches;
- raw strict and no-seq WS events buffered during REST and replayed after rendering;
- old previews and optimistic bubbles discarded on successful refresh, not on failure;
- sends created during loading still matched by turn ID, including five reversed completions;
- sequential block reveal;
- rapid identical prompts remaining attached to their own `turnId` anchors;
- authoritative content patching an existing node without replacing it;
- permission recovery without replaying ordinary streaming nodes;
- interruption placement, observer delivery, history persistence, and end-authority
  deduplication.

Run:

```bash
npm run test:frontend
```

## Snapshot refresh

`loadLatestMessages` is shared by initial entry, foreground refresh, WS reconnect,
bridge sync and compact stream-end recovery. It buffers raw WS events, requests the
latest 200 records, replaces the old tail at the first returned message's unique
ID, renders once, then replays the buffered events. A missing or ambiguous boundary
replaces the entire window. Older pagination retains its own `before` cursor.

A successful refresh drops pre-request optimistic bubbles and old stream previews.
New sends created during the request still retain their turn-ID anchors. A failed
refresh does not clear the existing view. Sending timeout/retry checks share the
same latest-200 fetch, but only confirm the matching send rather than reset the view.

## Live message updates

`message-state.js` owns ID deduplication, incremental message merging, the shared
message index and exact-ID pending-send confirmation. `message-dom.js` updates
live DOM nodes while preserving user anchors, tool expansion and streamed blocks.
`ws.js` commits these live updates directly; there is no separate recovery adapter
or callback-based commit layer. REST snapshot refresh uses `history-snapshot.js`
instead of per-message reconciliation. Tests cover these production paths rather
than legacy adapter stubs.

## Chrome verification

```bash
node test/browser/history-snapshot-chrome.mjs --headed
```

This opens an isolated Chrome profile and a temporary Vite server, loads the real
application, and substitutes REST/WS fixtures before page startup. No test messages
are sent to a real session. It exercises real tab visibility, composer clicks,
reconnect, stream-end recovery, reading position and lazy Edit diffs. The script
prints the temporary screenshot/results directory. Omit `--headed` for headless
Chrome, or set `CHROME_BIN` when Chrome is installed at a non-default location.
