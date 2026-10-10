# Git Graph / History Mobile Design

Status: Phase 1 (read-only Graph) and Phase 2 (Commit/Push) are implemented end to end on the `git-graph` branch: frontend, Bridge, and Server are all done,
and browse → stage → commit → push has been run locally against a real repository; not yet deployed. Branch switching/Stash & Switch/Pull remain Phase 3.
Recorded: 2026-09-27. For the implemented Changes baseline, see [git-status-plan.md](git-status-plan.md).

## 1. Conclusion

Close the review loop on the phone:

```text
See current working branch and ↑↓ → expand Graph → see forks/merges → expand commit → file list → reuse existing Diff page
```

- Read-only browsing: no checkout, no fetch, no repository writes; branch selection only changes the Graph's browsing scope.
- Keep using the `git_status` action; add three read-only operations `refs / history / commit_files` and extend `diff` with historical targets.
- Real topology graph in the first version: the data only needs `parents` + `--topo-order`; the lane layout is computed incrementally on the frontend, with no new dependencies.
- Reuse the existing file detail page; historical diffs hide Code/Preview/download so the current working-tree file is never misread.

## 2. Page Structure

```text
┌──────────────────────────────────────────┐
│ ‹ (gitflow) › ⑂ develop ↑1            📁 │  ← project name chip = refresh; branch is display-only
├──────────────────────────────────────────┤
│ ▾ Staged Changes                  1   −  │
│ ▾ Changes                         2  ↶ + │
│ ▸ Graph                      [develop ⌄] │  ← collapsed by default; scope selector on the right
│ ◉  WIP: local commit not yet pushed  10m │
│ │  [develop] demo · 0a30453              │
│ ●  Clean up README by removi…  2025-10-14│
│ │  [origin/develop] Vincent D… · d2eee63 │
│ ○╮ Merge pull request #235 fr… 2012-07-10│
│ │● Prevent error message on…   2012-07-10│
│ ○╯ Be git-describe friendly.   2012-07-09│
└──────────────────────────────────────────┘
```

### 2.1 Header

- Drop the fixed `Git Changes` title; the project name chip keeps "tap to refresh" and refreshes both Changes and an expanded Graph.
- Branch text comes from status: `develop ↑1 ↓2`; detached shows `HEAD @ <sha7>`; no arrows when there is no upstream.
- **The branch text is not clickable**: it always represents the real working branch. The entry for browsing other branches lives in the Graph section header, as in VS Code,
  avoiding the context confusion of "Header shows main while the list below shows xterm", and removing the need for an extra "history only" hint line.
- `↑/↓` come from porcelain's existing `# branch.upstream` / `# branch.ab`, adding no Git queries.

### 2.2 Graph Section

- Order: `Merge Changes → Staged Changes → Changes → Graph`; Graph does not depend on whether the working tree is clean.
- Collapsed on first entry, with no history request. Expanded state, browsing scope, the first history page per scope, and the branch list reuse the Changes IndexedDB project cache
  (`type: git-history / git-history-page / git-refs`, cleaned up together with project deletion and bound by the same LRU cap).
- On entering the page or expanding Graph, show the cache first while requesting the first page for refresh (stale-while-revalidate): a small spinner shows to the right of the title;
  on return, replace the list and update the cache, keeping still-existing expanded commits expanded; only show loading at the bottom when there is no cache. On refresh failure, keep cached content; Retry retries the refresh.
- The branch selector likewise shows the cached list first with a spinner next to the title, and only redraws when the background refresh changes something.
- Shares vertical page scrolling with Changes; no nested scroll box. 50 items per page, consistent with the Session/Project lists: auto-load the next page when < 1200px from the bottom,
  then check again after appending to fill the viewport; show a bottom spinner while loading; on failure, stop auto-loading and show the error with `Retry`, with no background retries.
- The scroll container extends to the screen bottom without reserving bottom padding on the container; as in the Project List, the end of the inner list uses `--sab / safe-area-inset-bottom` for a safe area that scrolls with the content. Graph adds no extra bottom border or trailing spacing.
- Right-side scope chip: `develop` (Auto) / `All branches` / a single branch short name; reuses `path-breadcrumb-item`, with height matching the top project chip on both Web and native (23.8 / 29.4px), and a 44px hit area.

### 2.3 Commit Row (collapsed: 34px single line; expanded: adaptive multi-line)

| Area | Content |
| --- | --- |
| Left graph column | Lane lines + nodes; width adapts to the max lane count of loaded rows, capped at about 84px; nodes are fixed-aligned to the first line |
| Title area (always) | Collapsed: single-line ellipsized title + gray author name + 1 ref badge (the rest folded into `+N`) + right-aligned date (within 7 days `m/h/d`, otherwise `MM-DD` / `YYYY-MM-DD`); expanded: title wraps naturally, date fixed top-right; on phones author and badges do not occupy the title area, while desktop still shows them to the right of the title |
| Author and refs area (expanded only) | Shows the author and the full names of all branches and tags, without `+N`; only on mobile is it shown on its own below the title, while desktop browsers keep the title-left, author-and-refs-right layout and do not force a new line on expand; pills wrap automatically when space is short, and overly long names wrap inside the pill without being ellipsized |
| Stats area (expanded only) | sha7 (tap to copy) · `N files +31 −8` (+ green, − red, matching A/D status colors) + right-aligned local time `HH:MM:SS` |

- The sha7 in an expanded row is the copy target: tapping (same on phone and desktop) copies the displayed 7-char hash, flashes `Copied` in place for about 1.2s, and does not toggle expand/collapse;
  the whole row is a button with no text selection, so single-tap copy replaces selection; uses the project's existing `navigator.clipboard.writeText`.
- First-line space allocation priority when collapsed: full date > author name (no shrink, max 100px, about 16 chars) > title at least 52px > badge may shrink to 24px.
  Measured on gitflow (51 authors) and all commits of this repository at 390/360px with no overflow; only names of 17+ characters are ellipsized (11 of 425 rows in gitflow).
- The collapsed `+N` means the other N branches or tags pointing at the same commit, not a commit count or added lines; expanding shows these refs one by one.
- When all history is loaded (no `hasMore`), the last node terminates the line without extending downward; branch tip nodes have no line above them (a head).
- Collapsed rows are a single line, giving list density close to VS Code; 34px still keeps a tappable area and is not reduced further. Expanded rows grow automatically, and the lower lane lines extend with them.
- Stats come from the same `git log --shortstat --diff-merges=first-parent` call; merges, like the expanded file list, use the first parent as the baseline;
  measured over 945 commits across gitflow and this repository, the stats file count matched the `commit_files` count in every case.
- Nodes: regular commits filled; merges hollow; current HEAD is a ring with an inner dot.
- Ref badges: local blue, current HEAD branch blue background and bold, remote purple, tag yellow; from the same `git log`'s `%D`, zero extra queries.
  Local `develop` and `origin/develop` sit on separate rows, making unpushed commits obvious at a glance.
- Fixed row height ensures each row's SVG can be drawn independently and aligns strictly with its neighbors.

### 2.4 Expanding a Commit

- Multiple commits can be expanded at once (as in VS Code), tap again to collapse; `commit_files` is requested only on first expand, and results are cached in memory per commit.
- As in VS Code, the expanded item is distinguished by **highlighting the current commit row** (blue selected background, brighter title and metadata), with no extra detail bar;
  low-value information such as the full commit message and merge comparison basis is not shown, and the time is already on the row's second line.
- The left side of the expanded area draws "through lanes" (rail) so the graph is not broken; the right side is the file list directly.
- File rows directly reuse Changes' `gitFileRowHtml()` (same icon, file name + directory, status letter), with row height matching collapsed commit rows at 34px (Changes stays at 40px),
  just without stage/discard buttons, and file icons left-aligned with the commit title; files at the repository root show no directory, same as Changes; renames show `old → dir`.
- Tapping a file opens the existing full-screen Diff: title `name @ sha7`, with Code/Preview tabs and download hidden (`diffOnly + canRead:false`).

### 2.5 Scope Selector

Reuses the `modal-viewport.js` centered overlay, single-select, closes on tap; 15px title, the close button reuses the file detail page's × button (`CLOSE_ICON_SVG` + `file-modal-close`),
36px option rows, and the selected item uses an SVG checkmark:

```text
Show history                           ⊗
✓ Auto              develop + origin/develop
  All branches
  LOCAL BRANCHES
    develop                          current
    feature/implement-hooks
  REMOTE BRANCHES
    origin/develop …
```

- `Auto` = current HEAD + its upstream (VS Code's default basis), showing the fork between local and remote.
- `All branches` = `--branches --remotes --tags`, for viewing the full multi-branch merge picture.
- Single local/remote branch; a filter box only appears with more than 10 refs, to avoid popping up the phone keyboard.
- No tags listed and no multi-select; symrefs such as `refs/remotes/*/HEAD` are deduplicated.
- The branch list is cached in memory per project: reopening shows the cache immediately while requesting `refs` in the background, redrawing only on change; only the first open shows loading.
- No hint such as "will not switch the working tree": the `Show history` title and the unchanged working branch in the Header already convey read-only semantics.

## 3. Lane Layout (`web/js/git/graph-layout.js`)

Input is the `--topo-order` commit sequence (guaranteeing children before parents), computed incrementally row by row, with `layout` state carried across pages:

1. If the current commit is already awaited by a lane, it occupies the first lane awaiting it; otherwise a new lane (new color) is allocated.
2. Other lanes awaiting the same commit converge into the node on this row (converging).
3. First parent: if already awaited by another lane, the node connects directly to it and releases this lane; otherwise this lane keeps awaiting it (color inherited).
4. Other parents (merge): if already awaited, connect to that lane; otherwise allocate a new lane.
5. At the end of each row, compact gaps; shifts are drawn as Bezier curves in the lower half of the row.

Step 3 is the key: measured on the gitflow repository, without merging awaiting lanes the All view peaks at 11 lanes; with merging it drops to 6 (Auto is also 6, master is 5).
Each row only outputs `col / converging / through / bottom / after`, rendered as a small 52px-tall SVG; when a new page keeps the same width it is appended directly,
otherwise the whole section is redrawn (pure string concatenation, milliseconds for hundreds of rows).

Subdirectory projects: `git log -- <prefix>` rewrites parents (measured: `9612a11`'s parent changes from `6a68f66` to `3acd70e`),
so the graph here is simplified history and serves only as the basis for the list display; the diff baseline still uses the commit object's real first parent.

## 4. Protocol (`git_status` action)

| operation | Request fields | Response fields |
| --- | --- | --- |
| `status` | Existing | `repository` adds `headOid, upstream, ahead, behind`; top-level `capabilities: { history: 1 }` |
| `refs` | — | `refs[]: { ref, name, kind: local\|remote, oid }` (multi-frame concatenation) |
| `history` | `scope: auto\|all\|ref`, `ref?`, `heads?`, `skip?`, `limit?` | `heads[]`, `commits[]`, `hasMore` (multi-frame concatenation of commits) |
| `commit_files` | `commitOid` | `commitOid, baseOid, merge, files[]: { path, status, previousPath? }` (multi-frame concatenation of files) |
| `diff` | Existing `group + path`, or `commitOid + path` | Unchanged: text framing + `diffToken/cursor` paging |

Commit item: `{ oid, parents[], subject (≤ 300 chars), authorName, authorTime, refs[]: { name, kind: local|remote|tag|head, head? }, stats?: { files, insertions, deletions } }`.
`stats` is best-effort: when a page's stats exceed the time budget (about 3s), Bridge reruns without `--shortstat` and omits the field, and the frontend shows no stats.

Paging: the first page resolves the scope into fixed `heads[]` (OIDs); later requests carry `heads + skip`, and Bridge runs
`git log --topo-order <heads...> --skip=N -n limit`. Paging over fixed OIDs means commits added in the meantime cause no duplicates or omissions;
refresh re-resolves the first page. No opaque cursor is needed, and Server can validate directly with regexes.

`commit_files` is not paged: it returns all files at once (capped at 3000, with `truncated` beyond that), handed to the existing multi-frame assembly.

## 5. Bridge Implementation Notes (`bridge/project/git-history.mjs`, new)

The commands Bridge actually runs (`bridge/project/git-history.mjs`, `git-diff.mjs`):

```bash
git for-each-ref --format=%(refname)%00%(objectname)%00%(symref) refs/heads refs/remotes
git log --topo-order --decorate=full --shortstat --diff-merges=first-parent -n<limit> [--skip=N] \
  --format=%x1e%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1f <heads...> -- [.]   # shortstat follows the last %x1f
git diff-tree -r -M -z --name-status --no-commit-id <firstParent> <oid>   # root commit uses --root <oid>
git diff-tree -p -M --no-ext-diff --no-color --no-commit-id <firstParent> <oid> -- <path> [<oldPath>]
```

- **Merges must pass the first parent explicitly**: `git diff-tree <merge>` outputs 0 lines by default (measured on `4c380be`).
- The file list and single-file diff use the same `<base> <oid>` pair and the same `-M` strategy; renames pass both new and old paths.
- `--decorate=full` distinguishes local/remote/tag by full ref name, and discards `refs/remotes/*/HEAD`.
- `status` parsing adds `branch.oid / branch.upstream / branch.ab`, in the same call as the existing porcelain.
- Keep using `runGit` argument arrays, `GIT_TERMINAL_PROMPT=0`, timeouts, and output caps; arbitrary revision expressions are not accepted,
  `ref` must be a full name listed by `for-each-ref`, and `heads/commitOid` must be commit objects in this repository.
- Historical diff token identity extends to `projectHash + commitOid + path`; working-tree diffs keep `projectHash + group + path`.
- Historical diffs do not go through `readGitSnapshot → targetFor`; instead they verify the path belongs to that commit's file list.
- Performance: `--topo-order -n 30 --all` takes 0.16s on this repository; with `--shortstat`, 50 items take about 0.05s and 300 items about 1.2s (about 4ms/commit, only counting output commits); with commit-graph, large repositories also stream output incrementally.
  `skip` paging re-walks the prefix on each page; total history is capped at 2000 rows, beyond which the user is prompted to use a single-branch scope.

## 6. Server (`server/src/project/git_ws.py`)

- `ALLOWED_OPERATIONS` adds `refs / history / commit_files`; forwarded fields add `commitOid, scope, ref, heads, skip, limit`.
- `history`: `scope ∈ {auto, all, ref}`; `ref` starts with `refs/heads/` or `refs/remotes/` and has no `..`/null bytes;
  `heads` is ≤ 256 entries of `^[0-9a-f]{40}([0-9a-f]{24})?$`; `skip ≤ 2000`, `limit ≤ 100`.
  When the All view has more than 256 refs, Bridge returns empty `heads`, and later pages re-resolve with `--branches --remotes --tags` (sacrificing paging stability for a very small number of repositories).
- `diff`: exactly one of `group + path` and `commitOid + path`, not mixed; `commitOid` accepts no mutation.
- Other auth, device routing, and targeted replies are unchanged. Web and Server ship in the same image; old Bridges already return
  `invalid_request` for unknown operations, and the frontend additionally checks `capabilities.history`, showing "Update the Bridge…" in Graph for old Bridges.

## 7. Frontend Files

| File | Change |
| --- | --- |
| `web/js/git/page.js` | Remove fixed title; project chip › branch ↑↓; two independent containers `git-status-groups` and `git-history` |
| `web/js/git/status.js` | Each snapshot updates the Header and history; project chip/reconnect also refreshes history; mutations do not trigger history |
| `web/js/git/graph-layout.js` (new) | Incremental lane layout |
| `web/js/git/history-render.js` (new) | Section, commit row SVG, expanded-area rail, reuse of Changes file rows |
| `web/js/git/status-render.js` | Extract `gitFileRowHtml(entry, attrs, actions)` for shared use by Changes and history |
| `web/js/git/history.js` (new) | Scope, paging, expansion, file cache, generation guard against stale responses overwriting |
| `web/js/git/ref-picker.js` (new) | Scope selector overlay |
| `web/js/git/rpc.js` | New fields and refs/commits/files array concatenation |
| `web/js/git/diff-viewer.js` | `openGitCommitDiff(commitOid, file)` |
| `web/js/git/commit-bar.js` (new) | Phase 2 commit bar: Commit / Push / Publish primary button and push confirmation |
| `web/js/project/file-viewer.js` | Hide the tab bar when `diffOnly` (one line) |
| `web/css/git-status.css` | Header branch, Graph rows, badges, selector styles |

Changes' renderer, mutations, IndexedDB cache, and diff behavior are unchanged. Refresh restoration (view-state) for historical Diff is deferred to the formal implementation.

## 8. Verification Record

- The UI phase used fixtures generated by real `git` commands (nvie/gitflow: 424 commits / 72 merges / multiple branches, plus this repository) to drive the real frontend modules;
  after confirmation, the mock page, fixtures, and generation scripts were all deleted and not committed to the repository.
- End to end: real frontend → real `handleGitStatusMessage` → real repository (origin is a local bare repository),
  running browse → expand merge → Diff → stage → commit → push at 390px / 360px phone viewports, with the remote HEAD matching local.
- Automated: `test/bridge/git-history.test.mjs` (paging stability, merge/root/rename, subdirectories, commit, push/publish/rejected) and
  `test/server/test_git_status_ws.py` (new operation field allowlist and format validation).

## 9. Phase 2: Commit and Push

### 9.1 Interaction: One Primary Button That Changes With State

```text
┌──────────────────────────────────────────┐
│ ‹ (gitflow) › ⑂ develop ↑1            📁 │ ← ↑N display only
├──────────────────────────────────────────┤
│ [Message (commit to develop)          ]  │ ← appears only with staged changes; 16px prevents iOS zoom
│ [          Commit 1 file             ]   │ ← after commit becomes [↑ Push 2 commits]
│ ▾ Staged Changes / Changes / Graph …     │
└──────────────────────────────────────────┘
```

| State | Commit bar |
| --- | --- |
| Has staged changes | Input box + green `Commit N files` (disabled on conflicts or empty message) |
| Nothing staged and `↑N` | Blue `↑ Push N commits` |
| Nothing staged and no upstream | Blue `Publish <branch>` |
| Other / detached / old Bridge | Hidden |

- Only staged files are committed; Enter inserts a newline, and committing is only via the button; drafts are kept in memory per project and cleared after a successful commit.
- Commit has no confirmation; Push/Publish are outward-facing operations and show one confirmation dialog, with failure messages kept inside the dialog.
- The commit bar is an independent persistent container (`git-commit-bar`) that is not redrawn with Changes' innerHTML, so input content and focus are not lost.
- On success, the returned snapshot refreshes Changes, the Header, and the commit bar; an expanded Graph reloads automatically when HEAD changes, and Graph is actively refreshed after Push.

### 9.2 Protocol

| operation | Request | Response |
| --- | --- | --- |
| `commit` | `message` (non-empty, ≤ 64KB), `stagedId` | snapshot + `commit: { oid, subject }` |
| `push` | None | snapshot + `push: { remote, branch, published }` |

- `status` adds `stagedId` (a digest of the staged list only) and `capabilities: { commit: 1, push: 1 }`.
- Failures uniformly return `ok:false + errorCode + error` with the latest snapshot attached, which the frontend uses to refresh.

### 9.3 Bridge Notes

- Commit: `git commit -F -` (message via stdin), `GIT_EDITOR=true`, no `--no-verify`, 120s timeout;
  compares `stagedId` first and returns `target_changed` on mismatch.
- Push: with an upstream, runs `git push --porcelain`; without an upstream, runs `git push --porcelain -u origin HEAD:refs/heads/<branch>`;
  never `--force`; when no custom ssh command is set, adds `ssh -o BatchMode=yes`, keeping `GIT_TERMINAL_PROMPT=0`; 120s timeout.
- Error codes: `commit_failed` (including the last ~4KB of hook output), `git_identity`, `git_locked`, `conflicts`, `nothing_staged`,
  `target_changed`, `outside_staged` (staged files outside a subdirectory project), `no_remote`, `push_auth`, `push_rejected`, `push_failed`.

## 10. Explicitly Deferred

- checkout / create and delete branches (Phase 3, including Stash & Switch), pull (Phase 3, `--ff-only` only), fetch, reset, rebase, cherry-pick, revert.
- Tags and multi-select scopes, comparing arbitrary two commits, comparing a merge against each parent separately, long-term file history across renames.
- Code/Preview/download of historical versions, image diffs, commit stats, persistent history watcher.
