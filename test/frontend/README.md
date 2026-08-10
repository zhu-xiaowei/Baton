# Stream-render test harness

Reproduce and verify **stream-rendering** bugs — duplicate replies, out-of-order
turns, back-to-back sends — by replaying a WS event sequence through the **real**
`web/js/ws.js` render code inside jsdom, then asserting the resulting DOM.

This is the method that actually pins these bugs down (a reimplementation would just
re-encode the assumption that's wrong). It drives the same `pushStreamFrame` /
`updateLastTurn` / `handleStreamEnd` / reorder-buffer code the browser runs.

The harness is committed with the other tests under `test/`, but is not packaged:
Tauri builds `dist/`, and the Server image copies only `web/` build output.
The `__APEEK_TEST__`-gated hook block at the bottom of `ws.js` is a no-op in production.

## Run

```bash
npm run test:frontend
node test/frontend/run.mjs <scenario>   # one scenario, in-process (for debugging)
```

Each scenario runs in a child process because `ws.js` is a module singleton (one
import binds to one jsdom window); the dispatcher in `run.mjs` handles this.

## Files

- `harness.mjs` — builds a jsdom window, mocks the render/util globals `ws.js` calls,
  loads real `ws.js` + `state.js`, exposes `window.__wsTest` hooks. `resetSession()`
  sets up a `new` (optimistic bubble) or `existing` session view.
- `replay.mjs` — `replay(h, events)` feeds a compact event sequence through the real
  code; `assertTurns(h, expected)` checks DOM order / attribution / no-dup / no-omit.
- `run.mjs` — scenario definitions + dispatcher.
- `collect-fixture.mjs` — (optional) run real CC via the bridge pool to capture an
  actual WS sequence into JSON, for wire-format-faithful fixtures.

## Event shorthand (replay.mjs)

```
{ u: 'text' }                     optimistic user bubble (self-send)
{ authUser: 'text' }              authoritative user row (watcher/jsonl)
{ authAsst: 'text' | [blocks] }   authoritative assistant row
{ start, block, kind }            stream_block_start
{ delta, block, text }            stream_delta chunk
{ stop, block }                   stream_block_stop
{ end }                           stream_end (resets seq for next turn)
```

Headless splits one turn's thinking/text into **separate** authoritative rows — model
that with `splitTurn()` in `run.mjs` (block 0 thinking, block 1 text). This shape
caused the duplicate-reply bug (a per-batch supersede count stranded block 1).

## Add a scenario

Add an entry to `SCENARIOS` in `run.mjs`:

```js
'my-case': async (h) => {
  resetSession(h, { mode: 'new', firstText: 'hi' });
  await replay(h, [{ authUser: 'hi' }, ...splitTurn('REPLY')]);
  return assertTurns(h, [{ u: 'hi', a: 'REPLY' }]);
},
```
