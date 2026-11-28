# v2 Phase 1, Step 2: Project and Session Lists Served by Each Bridge

Status: implemented on branch `v2/lists` (PR into `feat/v2`), verified on `BatonV2`.
Context: `docs/v2-architecture.md` §5, §9; step 1: `docs/v2-step1-home-plan.md`.

## Scope

- The project list and the session list are answered by the Bridge over the step-1 `app_data`
  socket, like the home page. Their pages, caches, paging, pull-to-refresh and rendering are
  unchanged: `api.js` maps `/api/bridge/projects|sessions` to the Bridge methods `projects` /
  `sessions`, which return the former REST responses.
- One Bridge index (`session-index.mjs`) answers home, projects and sessions; `home-index.mjs` is gone.
- Removed with the lists: REST `/projects`, `/sessions`, `/reconcile`, `/create-project`; `PROJ#`
  rows; device counters (`sessionCount`, `projectCount`, …) and `runtimeCapabilities` on `DEV#`;
  `statusDelta` counters; the `listPk-listSk-index` GSI, its backfill script and the Codex
  worktree migration script; the recent-project part of `/active-sessions`. Removing a device
  still deletes `PROJ#` rows left by older releases.
- Kept until M2 (they still feed notifications and the Session view): `SESS#` rows, the message
  table, the startup DDB sync, `checkStopped` and the slimmed `/active-sessions` it reads.
- A created project shows in the list with its first Session; its directory stays selectable.
- Deleting Sessions or projects always deletes their history on the device (the list is read
  from it), then their Session rows; the dialog keeps its 5 s countdown. Project folders stay.

## Transport

`direct-transport.js` owns everything below `request()`: it derives the data URL from the server,
and a page that did not load the home (reload, link) fetches `/devices` once in the background
for current routes and credentials; requests leave with the cached routes meanwhile and are
resent when routes change. Callers never connect or route.

## Bridge index

Per file the index keeps a small summary, equal field for field to `getSessionMetadata` (Claude)
and `scanCodexRollout` (Codex), as needed by the lists:

| Summary | Claude | Codex |
|---|---|---|
| validity, project | first prompt or title, else subagents | `session_meta` cwd + first prompt |
| preview | custom-title > ai-title > summary > history first prompt > first prompt > last-prompt | thread name > first prompt |
| model | last assistant `message.model` | last `turn_context` with a model |
| status input | — (candidates read the tail) | turn opened by the last `task_started` |

`session-summary.mjs` reads each line's first bytes (1 KB Claude, 256 B Codex): a line is parsed
only if its type can change the result, and a line whose type is not recognised is parsed in full.
Lines longer than a chunk are never accumulated. A summary is a plain state that resumes at a
byte offset, so a watcher append reads only the new bytes.

Warm-up (2 workers, newest files first) reads each file's **head and tail**, never its middle:
- Head: from the first line until the leading fields are known (most files stop within a few KB).
- Tail, Codex: backwards to the last top-level `task_started` and the last `turn_context` with a
  model. Everything after those lines decides the model and turn state, so this equals a full read.
- Tail, Claude: the last 1 MB. CC re-stamps a session's metadata (titles, last prompt) at the end
  of its file (`reAppendSessionMetadata`, also on exit), and its own resume list reads only head
  and tail (`readHeadAndTail`). Status never comes from this summary (see Requests).

CC re-stamps titles often but not on every MB: 7 of this machine's 33 titled transcripts went
1.3–7.2 MB between title lines. A running session can therefore hold its latest title in the
skipped middle, so after warm-up the running Claude sessions (live process or written within
5 minutes) are read backwards, a block at a time, until their latest title (`titlesBefore`;
85 MB worst case: 44 ms in 1 MB steps). A rename while the Bridge runs is read as an append.

A Codex title is its first prompt; once known, later prompt events are ignored, so an append after
a skipped middle cannot replace it. What the middle could still hold, never seen in 3263 files: a
second Codex `session_meta` with the same id; a legacy `user_message` event that differs from its
prompt.

A Session started from the App may not have a prompt in its transcript yet (a forked Skill writes
none until it finishes): the Bridge passes the prompt it sent (`notePrompt`) and the row shows it,
as v1 did; a daemon agent is listed before its first prompt as well.

Afterwards: watchers call `touch(file)` → stat, then continue from the offset (inode change or a
smaller file: read in full). Subagent files only recount their root; the subagent statuses of a
running root are kept for 15 s, as they read every subagent transcript. Deletions rescan the
directories. No disk cache: a restart warms again (fast while the files are in the page cache).

Requests: `projects` / `sessions` page with a keyset cursor (`[lastActive ms, id]`, opaque), 50 per
page, ≤100. Status follows the home rules: `lastKnownStatus` first, else computed for candidates
(live process, daemon agent, recent file, fresh subagent); process lists are refreshed after an
answer that found them stale, so no request waits for `ps`. One session in two project directories
(worktree) is shown from the newer file, then the larger one (v1 kept whichever the scan wrote last).

## Results

Consistency (field by field, every page, cursors of 7 rows):
- Dev machine, 3263 files: head + tail summaries equal `getSessionMetadata` / `scanCodexRollout`
  for every file, even without the full reads of active sessions; lists vs the v1 full discovery:
  28/28 projects, 2882 Sessions equal except the one worktree duplicate rule above.
- `BatonV2`, `test-ec2-ap` (83 files): Bridge answers = v1 REST before the deploy = full discovery
  after it (10 projects, 66 Sessions, 0 differences). New file listed 78 ms after it was written,
  an appended title 463 ms (watcher debounce), a deleted file gone after 200 ms.

Speed (dev machine, 3263 files / 2.2 GB; v1 full scan 8.9 s):

| | page cache warm | cold (EBS gp3) |
|---|---|---|
| warm-up, then every answer is ready | 0.52 s | 3.09 s |
| projects page / sessions page / home, computed | 0.05 / 0.07 / 0.09 ms | same |
| rebuild after a change | 3 ms | same |

Round trips on `BatonV2` (medians, through CloudFront, 1 frame each: projects 756 B, sessions
2 KB, home 5 KB):

| | Tokyo | US East |
|---|---|---|
| v2 projects / sessions page | 52 / 45 ms | 197 / 196 ms |
| v1 REST, same pages, before the deploy | 88 / 83 ms | 525 / 521 ms |

Memory: the index holds ~1.8 KB per file (5.7 MB heap for 3263 files); the warm-up workers add
RSS only while they run. `test-ec2-ap` Bridge RSS after restart: 117 MB (v1: 122 MB), of which
~41 MB is Node itself, ~27 MB Bridge modules, ~33 MB the v1 startup scan's high-water mark.

Known limitation (M1): the v1 startup scan still runs synchronously on the main thread
(8.9 s on the dev machine). Worker results are applied only after it, so right after a restart
requests wait for it; M2 removes the scan.
