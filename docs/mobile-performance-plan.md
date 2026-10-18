# Mobile Performance Plan

Measured on 2026-10-18 with the production build against the deployed API and real
Sessions, in Chromium with Pixel 7 emulation and 4x CPU throttling (close to a mid-range
Android phone). Metrics come from CDP after forced GC: JS heap, DOM nodes, listeners,
long tasks, heap snapshots and CPU profiles.

No persistent leak was found. Session switching (55 opens: 20.0 → 20.6 MB), history
paging, Files, Git, Terminal, PDF, HTML, image and Markdown viewers all return to their
baseline after closing. The problems are CPU work that grows with content, and caches
without a byte budget.

Each fix is a separate, minimal change. Every fix is verified for unchanged user-visible
behavior and measured before and after with the same harness.

Status: fixes 1, 4, 5 and 6 are implemented. Fixes 2 and 3 are deferred (see their
Status notes).

## 1. Remove `highlightAuto`, load highlight.js languages on demand

**Problem.** Code without a language falls back to `hljs.highlightAuto`, which tries all
192 bundled languages.

- First call: 965 ms (4x throttle) and +13.7 MB of permanent heap, two thirds of the
  app heap.
- Every later call on 2 KB of code: about 233 ms.
- The file viewer runs it on every file with an unknown extension below 300 KB. A
  287 KB `.log` file blocks the main thread for 5.5 s on a desktop CPU.
- Detection is wrong for real content. Of 22 unlabeled fences sampled from about 175
  Sessions, highlightAuto classified all of them as unrelated languages (awk, mipsasm,
  abnf, routeros, ...) and colored 21 of them.

**Change.**

- Load `highlight.js/lib/common` (36 languages chosen by highlight.js) instead of the
  full bundle.
- Load any other language on first use by canonical name through
  `window.loadHljsLanguage`. Code rendered before the language arrives is
  re-highlighted in place.
- Render unlabeled fences and files with unknown extensions as plain text. This is the
  same as GitHub and VS Code: map label, extension or file name to a language, and
  never guess.
- Diff2Html uses the shared `hljs` instance through `diff2html-ui-base`, so the full
  bundle is no longer pulled in by the diff viewer.

**Impact.** Labeled code keeps its current highlighting. Every label seen in real data
(bash, toml, markdown, css, json, swift, diff, kotlin, zsh, js, sh, text) is in the
common set. Rare languages highlight after a few-KB lazy load. Aliases of languages
outside the common set (for example `docker` for `dockerfile`) are not known until the
language is loaded, so they render as plain text. Unlabeled code is no longer randomly
colored.

## 2. Incremental streaming Markdown

**Problem.** Each animation frame re-parses the whole visible block with `marked` and
re-highlights every code block in it (`revealFrame` → `renderStreamMd`).

- During a 23 s turn there were about 140 long tasks, script used 55% of CPU, and p95
  frame time was 67–83 ms.
- This path was 42% of wall time in the profile.
- The un-collected heap peaked at about 150 MB per turn from garbage.

**Change.** Split the streamed text into top-level Markdown blocks. Reuse the HTML of
stable blocks and re-render only the last one or two. Render the full text once when the
block stops.

**Impact.** The final DOM is identical, because of the full render at block stop.
Intermediate frames look the same as today: setext headings, tables before their
delimiter row, and list continuation stay in the unstable tail.

**Status: deferred.** After fix 1 the same synthetic turn streams at about 58 fps (p95
frame 16.8 ms, 3 frames over 50 ms, versus 113 before). The change would touch the
streaming renderer's core, so it is not worth the regression risk now. `blockViews`
pruning (see fix 4) belongs with it.

## 3. Stop re-rendering the whole history on each full commit

**Problem.** Send, refresh, WS reconnect, foreground resume and late join run a full
commit:

- It re-renders all of `wsAllMessages` to HTML (marked and hljs for every message).
- It compares every node through a deep `cloneNode` and `outerHTML`.

Decorations added after render make most nodes compare as changed, so they are
replaced.

The pause when a turn starts grew from 107 ms to 1017 ms over 10 turns in one Session
(desktop CPU, no throttle). In the profile, `renderMessages` was about 500 ms of a
roughly 800 ms task.

**Change.**

- Memoize `renderMd` by text. Its output depends only on its input.
- Compare top-level nodes by a fingerprint of their source data instead of their
  markup.

**Impact.** Content-identical nodes keep their DOM and decorations. Expanded diffs,
Mermaid diagrams, visualization iframes and Agent timers no longer reset on send. The
static review reported these resets; reproduce them from captured frames before
changing the code, and run the ordering, dedup and recovery suites.

**Status: deferred.** After fix 1 the turn-start task grows by about 12 ms per turn
instead of about 100 ms (88 → 170 ms over 8 turns, desktop CPU). The remaining
185 ms splits into:

- reconciler compare: about 32%
- forced layout surfaced inside `clampOverflow`: about 23%. `clampOverflow` itself takes
  under 2 ms.
- `renderMessages`: about 17%

Changing the merge or reconcile logic risks ordering, dedup and recovery regressions, and
the `renderMd` memo alone saves about 30 ms. Neither is done. If needed later, render and
compare only the turns a merge touched, and fall back to the full commit otherwise.

## 4. Move the file text cache out of memory

**Problem.** `state.fileCache` is an in-memory `Map` that holds up to 50 full file texts.
It survives project switches and has no byte budget. It measured 14 MB, and a heap
snapshot showed 12.5 MB still held after closing a 3.9 MB and a 7.9 MB file.

Text fetched with `fetch` is stored outside the V8 heap, so the JS heap metric does not
show it, but it still counts toward the WebView process memory.

For files up to 300 KB the cache saves nothing: Bridge sends the full content over WS on
every open, before the cache is checked. It only saves the S3 download for larger files.

**Change.**

- Remove `state.fileCache`.
- Store uploaded text (the `/api/bridge/file/{key}` path) in the shared IndexedDB
  attachment cache.
- The key is derived from path and content hash, so an entry never goes stale. This is
  the same rule the attachment cache already relies on.

**Impact.** No file text stays in memory after the viewer closes. Cached large files also
survive app restarts. Inline files behave as before.

`StreamingDomRenderer.blockViews` pruning (about 1600 detached nodes per turn, freed when
the Session is left) moves into fix 2. Its views are still used by `discardTurn`,
authority patches and interrupt restore after a turn completes.

## 5. Text files above 300 KB open blank

**Problem.**

- For text files above `TEXT_WS_MAX_BYTES` (300 KB), Bridge uploads the file and replies
  with only a `key`.
- `assembleTextFrames` always sets `content` to `''`, so `handleFileResponse` renders
  that empty string and never downloads the key.

**Change.** Set `content` only when content frames were received.

**Impact.** Large files display again, without highlighting. A 1.1 MB log file opens in
about 2 s at 4x throttle.

Separate, pre-existing limit: Bridge uploads these files as base64 through `/upload-file`.
Above about 4.4 MB the request exceeds the 6 MB Lambda payload limit and the viewer shows
"upload failed", so the 5 MB read limit is never reached. Fix 6 removes this by capping
previews at 1 MB.

## 6. Cap text previews at 1 MB

**Problem.**

- A 3.9 MB text file blocks the main thread for 2.2 s at 4x throttle and scrolls at about
  10 fps; 7.9 MB blocks for 4.3 s and scrolls at about 4 fps.
- Files above about 4.4 MB fail to upload (see fix 5).

**Change.**

- Bridge reads at most 1 MB for previews and marks the result `truncated`.
- The viewer says it shows the first 1 MB. The existing Download action, which uses a
  presigned upload, fetches the full file.

**Impact.** 99.78% of the 105,771 local source and text files are at most 1 MB. The
larger ones are mostly data JSON, logs and generated bundles.

## Order

1. Done: fix 1, fix 5, fix 4, fix 6.
2. Deferred: fix 2 and fix 3, revisit if sends or streaming feel slow on devices.
3. Optional: `content-visibility: auto` on history turns to cut forced layout during
   streaming (about 5% of the profile). Validate scroll anchoring separately.
