# Git Changes Complete Design

This document records the implemented Git Changes baseline. The next phase's branch display, Git Graph, commit history, and historical Diff are covered in
[Git Graph / History Mobile Design](git-history-design.md); that phase is still being confirmed and does not change the scope of the completed phases described here.

## 1. Goals

Provide Git Changes capabilities on the AgentPeek mobile client, close to VS Code Source Control, so that after
Claude Code or Codex modifies a project, the user can:

- View the real Git changes inside the current `projectPath`.
- View `Merge Changes`, `Staged Changes`, and `Changes`.
- Stage a single file or an entire Section.
- Unstage a single file or an entire Section.
- Discard a single file or the entire `Changes` Section.
- Tap a file to view a standard unified diff.
- Switch between Diff and full Code.
- Navigate to and from the existing Project Files page.

Not implemented in this phase:

- Git Graph / Commit History.
- Commit, Push, Pull, Fetch.
- Multi-select batch file operations.
- Partial staging (stage hunk).
- Line-level Diff markers within full code; recorded only as a future enhancement.

## 2. Settled Core Principles

- Git status covers only the current `projectPath`; other directories in the same repository are not touched.
- Use one WS action: `git_status`.
- Use five operations:
  - `status`
  - `stage`
  - `unstage`
  - `discard`
  - `diff`
- Mutations support only:
  - Single file: `path`
  - Entire Section: `all: true`
- No separate operations such as `stage_all`, `unstage_all`, or `discard_all`.
- A successful mutation directly returns the latest grouped snapshot.
- The frontend does no optimistic list updates and does not send a second `status`.
- Bridge does not cache Git status; every request runs a real `git status`.
- The frontend keeps the last successful result in memory + IndexedDB; on entering or returning to the page it shows the cache first,
  always requests fresh data at the same time, and replaces the content once the full response arrives.
- Bridge caches only the `projectHash → projectPath/repoRoot/prefix` mapping.
- Server only authenticates, validates, and routes; it does not run Git.
- Git commands run only on the Bridge of the specified device.
- All Git commands use argument arrays; no shell string concatenation.

## 3. Code Organization and File Size

### 3.1 File Responsibilities

The Project Files list and the Git Changes list must stay independent:

```text
web/js/project/browser.js
  Only handles the Project Files directory list and directory navigation.

web/js/git/status.js
  Only handles Git Changes state, refresh, and mutation control.

web/js/git/status-render.js
  Only handles rendering of the three Git Sections and file rows.

web/js/cache/project-data-cache*.js
  Unified IndexedDB, LRU, and transaction wrapper for Git snapshots and Project Files.
```

They share only the Header/Back component, file icons, edge-back, and WS RPC; no list business code is shared.

### 3.2 Per-File Size

- New files target around 300 lines.
- A single file should preferably not exceed 500 lines.
- When approaching 500 lines, split by responsibility instead of piling on.
- Existing large files only gain the necessary import, route, entry point, or dispatch.

### 3.3 Bridge Files

```text
bridge/project/git.mjs
  git_status action dispatcher; no concrete Git business logic.

bridge/project/git-context.mjs
  projectPath, repoRoot, prefix resolution and mapping cache.

bridge/project/git-status.mjs
  porcelain v2 execution, parsing, grouping, and snapshotId.

bridge/project/git-mutations.mjs
  stage, unstage, discard.

bridge/project/git-diff.mjs
  unified diff, Diff pagination, and temporary cache.

bridge/project/ws-frames.mjs
  Generic 31 KB safe framing; shared by Project Files and Git.
```

### 3.4 Server Files

```text
server/src/project/git_ws.py
  Request validation, targeted Bridge routing, targeted App connection response.
```

Only an action route is added in `server/src/bridge_ws.py`.

### 3.5 Frontend Files

```text
web/js/ws-rpc.js
  Generic requestId, pending Promise, timeout, multi-frame assembly, and error handling.

web/js/project/page.js
  Project Files full-screen page and Header.

web/js/project/browser.js
  Directory navigation, in-memory cache, IndexedDB restore, and refresh on return.

web/js/git/rpc.js
  Git request fields and Git snapshot/diff assembler.

web/js/git/status.js
  Status loading, refresh, single-file and all operations.

web/js/git/status-render.js
  Sections, file rows, collapsing, and action buttons.

web/js/git/diff-viewer.js
  Hooks into the full Project File Viewer, provides Git Diff loading and refresh-restore state.

web/js/project/file-viewer.js
  Shared file detail page, download, Code/Preview, and optional Diff rendering.

web/js/git/discard-confirm.js
  Discard single-file/all confirmation.

web/js/git/view-state.js
  Refresh-restore state for Git List and Diff/Code.

web/js/project/source-view.js
  Source, line-number, and highlighting renderer shared by Project File Viewer and Git Code.

web/js/cache/project-data-cache-core.js
  Business core for unified cache records, LRU, Quota retry, and an injectable backend.

web/js/cache/project-data-cache-idb.js
  Native IndexedDB Object Store, indexes, transactions, and cursor deletion.

web/js/cache/project-data-cache.js
  Thin production wrapper.

web/css/git-status.css
  Git Changes and Diff/Code styles.
```

## 4. UI and Project Files Integration

### 4.1 Entry Points

- Project's Session list:
  - Keep the Folder icon.
  - Tap to enter Files.
- Session detail:
  - The top shows three entry points in the order `Git / Runtime / New Session`.
  - Git uses the unified Source Control SVG.
  - The Codex icon uses the same neutral gray as Git and New Session, brightening on desktop hover.
  - Tap to enter Changes.
- Top right of the Files page:
  - Git icon, switches to Changes.
- Top right of the Changes page:
  - Folder icon, switches to Files.

The Git page Header does not use a clickable breadcrumb:

```text
[Back] Git Changes [project-name] [Folder]
```

- `Git Changes` is the static main title.
- The project name is a trailing pill; long names are truncated.
- Tapping the project pill manually refreshes Git status without changing scroll position or clearing the old list.
- While status loads, reuse the existing breadcrumb pill rotating-border animation.
- Do not use the Header line breathing animation.

The main page does not stack Folder and Git together, keeping mobile simple.

### 4.2 Workspace and Back Navigation

Files and Changes use full-screen pages with independent responsibilities, but share:

- Back SVG and tap-area logic.
- Header height, safe area, and left/right entry layout.
- edge-back gesture framework.
- Project Files / Git Changes caching and the stale-while-revalidate experience.

- The DOM, path, and scroll position of each page are kept separately.
- Back closes the whole Workspace and returns to the underlying Session list or detail.
- Back and left-edge swipe from a Git file Diff/Code first return to Git Changes.
- Back and left-edge swipe from Git Changes then return to Session detail.
- The two layers use independent edge-back layers; a single gesture never exits two layers in a row.
- For Session → Git → Files, Files Back/swipe first returns to Git, then Git returns to Session.
- For Session list → Files → Git, Git Back/swipe first returns to Files.
- Files/Git store only one level of origin and never form a circular back stack.
- Files → Changes first shows the Git cache and requests status live.
- Changes → Files first shows the directory cache and refreshes the current directory.
- The swipe preview clones the real previous page, so the wrong Session layer is never exposed.

### 4.3 Sections

Fixed order:

```text
Merge Changes
Staged Changes
Changes
```

Display rules:

- `Merge Changes`: shown when there are conflicts.
- `Staged Changes`: shown when there are staged files.
- `Changes`: always shown.
- The count on the right is shown only when greater than 0.
- A count of 0 does not show `0`.
- Do not show `No changes` or `No unstaged changes`.
- Each Section is expanded by default; tapping the title collapses it.
- Every entry into Git Changes restores all Sections to expanded; the previous collapsed state is not saved.
- Section Headers support sequential sticky positioning; the next Section replaces the previous one when it arrives.
- Collapsed Sections use a distinct border color between them, and Headers use a separate bright background.

When a file is modified again after being staged, the same file appears in both:

- `Staged Changes`
- `Changes`

### 4.4 Row Actions

Normal mode:

- `Changes` files:
  - Stage
  - Discard
- `Staged Changes` files:
  - Unstage
- `Merge Changes` files:
  - Stage, meaning mark the conflict as resolved

Section Header:

- `Changes`:
  - Stage All
  - Discard All
- `Staged Changes`:
  - Unstage All
- `Merge Changes`:
  - Stage All Resolved

The first version has no long-press multi-select.

## 5. Generic WS RPC

The common request logic for Project Files and Git is unified into:

```text
web/js/ws-rpc.js
```

`web/js/project/rpc.js` and `web/js/git/rpc.js` only handle business fields and assemblers.
Callers only care about the final result:

```js
const snapshot = await requestGitStatus(projectHash);
renderGitSnapshot(snapshot);
```

Callers do not handle:

- requestId.
- WS events.
- sequence.
- chunkCount.
- complete.
- Out-of-order and duplicate frames.
- timeout.

The common layer calls the business assembler after receiving all frames:

```js
assembleTextFrames(frames)
assembleGitSnapshotFrames(frames)
assembleSingleFrame(frames)
```

`web/js/ws.js` calls uniformly:

```js
if (handleWsRpcMessage(message)) return;
```

Project Files and Git no longer each write their own pending/sequence logic.

## 6. Git Context

App requests pass only `projectHash`; Bridge converts it to the full `projectPath`.

A project may be a monorepo subdirectory:

```text
repoRoot:    /workspace/monorepo
projectPath: /workspace/monorepo/packages/app
prefix:      packages/app/
```

Git porcelain paths are relative to repoRoot:

```text
packages/app/src/index.js
```

The frontend and Project Files use project-relative paths:

```text
src/index.js
```

On the first request, Bridge runs in parallel:

```bash
git -C <projectPath> rev-parse --show-toplevel --show-prefix
```

```bash
git --no-optional-locks \
  -C <projectPath> \
  status \
  --porcelain=v2 \
  -z \
  --branch \
  --untracked-files=all \
  -- .
```

Bridge caches only:

```js
projectHash → {
  projectPath,
  repoRoot,
  prefix
}
```

Subsequent requests only run `git status`.

Not cached:

- Raw Git status output.
- groups.
- snapshotId.

Simple invalidation rules:

- Delete the context cache when a Git command fails.
- The in-memory cache is naturally cleared when Bridge restarts.
- `not_git_repository` is not cached.

## 7. Status API

### 7.1 App Request

Real `test4` request example:

```json
{
  "action": "git_status",
  "operation": "status",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "projectHash": "-Users-xiaoweii-workspace-demo-test4",
  "device": "MacBook-Pro"
}
```

Not sent:

- sessionId
- projectPath
- repoRoot
- path

### 7.2 Server → Bridge

Server uses `device` to select the Bridge and adds:

```json
{
  "replyConnectionId": "<app-connection-id>"
}
```

`replyConnectionId`:

- Is passed only between Server and Bridge.
- Bridge returns it unchanged.
- Server removes it before forwarding to the App.

### 7.3 Success Response

```json
{
  "action": "git_status",
  "operation": "status",
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "ok": true,
  "sequence": 0,
  "chunkCount": 1,
  "complete": true,
  "snapshotId": "e0b54455dbe1862e9942d877eab1ba7111e6a60a97101107544d1f6574f44811",
  "repository": {
    "branch": "main",
    "detached": false,
    "unborn": false
  },
  "groups": {
    "conflicts": [
      {
        "path": "git-fixture/conflict.txt",
        "status": "conflicted",
        "conflictCode": "UU"
      }
    ],
    "staged": [
      {
        "path": "git-fixture/added-staged.txt",
        "status": "added"
      },
      {
        "path": "git-fixture/both.txt",
        "status": "modified"
      },
      {
        "path": "git-fixture/renamed.txt",
        "previousPath": "git-fixture/rename-old.txt",
        "status": "renamed"
      }
    ],
    "changes": [
      {
        "path": "git-fixture/both.txt",
        "status": "modified"
      },
      {
        "path": "git-fixture/deleted.txt",
        "status": "deleted"
      },
      {
        "path": "git-fixture/untracked.txt",
        "status": "untracked"
      }
    ]
  }
}
```

### 7.4 Status Values

```text
added
modified
deleted
renamed
copied
type_changed
untracked
conflicted
```

UI letters:

```text
A M D R C T U !
```

### 7.5 Framing

When the response is no larger than 31 KB:

```json
{
  "sequence": 0,
  "chunkCount": 1,
  "complete": true
}
```

When it exceeds 31 KB, the same logical request returns multiple WS events:

- Same requestId.
- Same snapshotId.
- Same chunkCount.
- Each frame's groups may contain only some of the array items.
- The frontend assembles by sequence.
- Rendering happens once after all frames arrive.

Verified locally with 1200 status items:

```text
frameCount: 4
largestFrameBytes: 30991
reconstructed: true
```

## 8. snapshotId

`snapshotId` is not a value returned by a Git command.

Bridge computes SHA-256 over the sorted, normalized full state:

```js
sha256(JSON.stringify({
  conflicts,
  staged,
  changes
}));
```

Purpose:

- Prevents Codex from producing new files after the user confirms an All action.
- Verifies before an All operation runs that the state the user saw is still valid.
- Not used for caching.
- Single-file operations do not require the full snapshot to match; they only verify the target's current state.

## 9. Mutation API

### 9.1 Three Operations

```text
stage
unstage
discard
```

### 9.2 Single File

```json
{
  "action": "git_status",
  "operation": "stage",
  "requestId": "uuid",
  "projectHash": "-Users-xiaoweii-workspace-demo-test4",
  "device": "MacBook-Pro",
  "group": "changes",
  "path": "git-fixture/modified.txt"
}
```

Bridge obtains the rename/copy previousPath from the live status; the frontend does not send it.

### 9.3 Entire Section

```json
{
  "action": "git_status",
  "operation": "stage",
  "requestId": "uuid",
  "projectHash": "-Users-xiaoweii-workspace-demo-test4",
  "device": "MacBook-Pro",
  "group": "changes",
  "all": true,
  "snapshotId": "current-snapshot-id"
}
```

Exactly one of `path` and `all` must be provided.

### 9.4 Operation/Group Combinations

| operation | group | Behavior |
|---|---|---|
| `stage` | `changes` | Stage the file |
| `stage` | `conflicts` | Mark the conflict resolved and stage |
| `unstage` | `staged` | Unstage, keep the working tree |
| `discard` | `changes` | Discard working-tree changes |

Other combinations return `invalid_request`.

### 9.5 Git Commands

Stage:

```text
git --literal-pathspecs add -A
```

Unstage:

```text
git --literal-pathspecs reset -q
```

Discard tracked:

```text
git --literal-pathspecs restore --worktree
```

Paths are passed via NUL-separated stdin:

```text
--pathspec-from-file=-
--pathspec-file-nul
```

Verified support for:

- Spaces
- Unicode
- Newlines
- `*`
- `[`
- Leading `-`

### 9.6 Discard

- tracked modified: restore to the index content.
- tracked deleted: restore from the index.
- Modified again after staging: discard only the later changes, keeping the staged content.
- untracked: delete exactly the current file.
- conflicted: discard is forbidden.
- submodule: discard is forbidden in the first version.
- Never run `git clean`.
- A confirmation must be shown before deleting untracked files.
- Discard All shows the file count and untracked count and requires strong confirmation.

### 9.7 Mutation Response

On success, immediately read the latest Git status and return the same grouped snapshot as `status`:

```json
{
  "action": "git_status",
  "operation": "stage",
  "requestId": "uuid",
  "ok": true,
  "sequence": 0,
  "chunkCount": 1,
  "complete": true,
  "snapshotId": "new-snapshot-id",
  "repository": {
    "branch": "main",
    "detached": false,
    "unborn": false
  },
  "groups": {
    "conflicts": [],
    "staged": [],
    "changes": []
  }
}
```

operation keeps the original mutation name, but the snapshot structure is the same.

## 10. Diff API

### 10.1 Request

```json
{
  "action": "git_status",
  "operation": "diff",
  "requestId": "uuid",
  "projectHash": "-Users-xiaoweii-workspace-demo-test4",
  "device": "MacBook-Pro",
  "group": "changes",
  "path": "git-fixture/modified.txt"
}
```

Allowed groups:

```text
changes
staged
conflicts
```

### 10.2 Git Commands

```text
changes:
  git diff --no-ext-diff --no-color -- <path>

staged:
  git diff --cached --no-ext-diff --no-color -- <path>

conflicts:
  git diff --cc --no-ext-diff --no-color -- <path>
```

Untracked files use a cross-platform temporary empty file:

```text
git diff --no-index --no-ext-diff --no-color -- <empty-file> <path>
```

Exit code `1` from `git diff --no-index` means differences were found, not an error.

Diff returns a standard unified diff that can be handed directly to the existing Diff2Html.

### 10.3 Large Diffs

- No S3.
- Each batch targets about 256 KB.
- Each batch is further split into WS frames of no more than 31 KB.
- At most 20 batches are fetched automatically, about 5 MB.
- The first batch generates a `diffToken`; later requests carry the token and cursor.
- Bridge caches this Diff's content so multi-batch content stays stable.
- Diff cache TTL is 2 minutes.
- At most 4 Diffs, about 20 MB in total.
- Exceeding the limits returns `truncated: true`.

On the Bridge side only Diff needs a temporary content cache; Git status runs the real command every time.
The frontend separately keeps the last successful Git snapshot for instant page restore, without changing Bridge's real-time semantics.

### 10.4 Diff/Code Viewer

Tapping a file from Git Changes:

```text
Open the full file Viewer
→ Show Diff by default
→ Share the file detail page Header, download, Code/Preview, and back logic, plus an extra Diff option
```

- Diff: standard unified diff + Diff2Html line-by-line.
- Code/Preview: uses the full Project File Viewer directly, fetching the current working-tree file via `project_files.read`,
  sharing line numbers, syntax highlighting, truncation notice, and HTML/Markdown preview.
- Download: reuses the file detail page download button and native/browser download flow, downloading the current working-tree file rather than a patch.
- In the first version, Code for staged files shows the current working-tree content.
- Deleted files with no current content disable Code/Preview and download, but Diff remains viewable.
- The first version does not duplicate stage/unstage in the Viewer.
- The Git entry no longer creates a separate detail page; it shares the same file detail page DOM and swipe-back layer.
- Both Diff and Code loading use the unified centered loading spinner.
- Diff dual line numbers support four digits; line numbers and code use a single shared scroll container.
- Diff2Html inner overflow is disabled so a single horizontal swipe is not contested by two containers.
- A browser refresh restores the current file and Diff/Code mode.

Future enhancement:

```text
Full-file Diff
```

Show the full code and mark added, deleted, and modified lines within the full file.

## 11. Error Format

```json
{
  "action": "git_status",
  "operation": "status",
  "requestId": "uuid",
  "ok": false,
  "sequence": 0,
  "chunkCount": 1,
  "complete": true,
  "errorCode": "not_git_repository",
  "error": "This project is not inside a Git repository."
}
```

Error codes:

```text
invalid_request
bridge_offline
project_not_found
not_git_repository
git_unavailable
status_changed
target_changed
conflict_not_supported
submodule_not_supported
diff_expired
git_failed
partial_failure
request_timeout
```

When an All action fails because snapshotId changed, the latest grouped snapshot may be returned as well; the frontend refreshes and prompts the user to confirm again.

## 12. Lifecycle

- Open Changes: show the in-memory or IndexedDB snapshot first, then request status live.
- Files → Changes: show the cache first, then request status live.
- Diff/Code back to Changes: keep the existing list and refresh status in the background.
- File Viewer back to Files: keep the current directory and scroll position, replacing everything once the full response arrives.
- Breadcrumb back to a parent directory: prefer showing the cached visited directory, then refresh in the background.
- App returns to foreground with Changes visible: request status again.
- WS reconnects with Changes visible: request status again.
- Mutation success: use the snapshot returned by the mutation; do not request again.
- No polling.
- Keep the old list while refreshing; replace everything after receiving the full snapshot.
- Browser-refresh state for Git List, Diff/Code, and Project Files is all restorable.
- Refresh on every entry and return; no TTL.

WS keep-alive condition:

```js
state.appState.session || state.projectFilesOpen || state.gitStatusOpen
```

Disconnecting is allowed when Files/Git are closed and no Session is using WS.

### 12.1 Frontend Persistent Cache

Project/Session List keeps using the existing localStorage logic, with no migration.

Git snapshots and Project Files use one native IndexedDB:

```text
Database: agentpeek-project-data-v1
Object Store: project-data
Indexes:
  byLastAccess
  byProject
```

Unified key:

```text
[server, device, projectHash, type, path]
```

Cache scope:

- The most recent Git snapshot for each Project.
- The full root directory listing for each Project.
- Full paginated results for every subdirectory actually visited.
- No directory preloading.

Read strategy:

1. Show immediately on an in-memory hit.
2. On an in-memory miss, read IndexedDB.
3. Request fresh data on every entry or return.
4. On success, update the page, memory, and IndexedDB.
5. On request failure, keep the old content.

LRU:

- When total records exceed 2048, delete the oldest 512 by `lastAccessAt`.
- The first trigger at 2049 records leaves 1537 records.
- The same key is overwritten with `put`, not increasing the record count.
- On QuotaExceeded, clean one batch and retry only once.
- Deleting a Project cleans up via `byProject`.
- Clear this cache when the account or Server changes.
- No third-party IndexedDB library.

## 13. Security

- projectHash may only map to an existing projectPath.
- Confirm projectPath is inside a Git worktree.
- Git status and operations are restricted to the current projectPath.
- Paths must come from the live status re-read by Bridge.
- Reject absolute paths, NUL, and paths outside the project.
- Use literal pathspec.
- Untracked deletion uses `lstat` and does not follow symlinks.
- Never run `git clean`.
- Never run generic reset/checkout that would overwrite staged content.
- Server whitelist-validates operation, group, UUID, and field combinations.
- Server sends Bridge responses only back to the originating App connection.
- Never return absolute device paths or full Git stderr to the frontend.

## 14. Two-Phase Implementation Status

### Phase 1: Bridge, Server, and Five APIs (Completed)

Implemented:

- context.
- status parser.
- grouped snapshot.
- snapshotId.
- stage.
- unstage.
- discard.
- standard unified diff.
- WS framing.
- Server targeted routing.

Main test files:

```text
test/bridge/git-status.test.mjs
test/server/test_git_status_ws.py
```

Automated tests use temporary Git repositories and do not modify fixed fixtures.

Manual real fixture:

```text
/Users/xiaoweii/workspace/demo/test4
```

Currently verified:

```text
Merge Changes:  1
Staged Changes: 5
Changes:        5
GROUPED_STATUS_REAL_REPO=PASS
DIFF_COMMANDS=PASS
```

Results:

- Unit tests for all five operations pass.
- Server routing tests pass.
- 31 KB framing and out-of-order assembly data tests pass.
- Real `test4` results match expectations.

### Phase 2: Frontend (Completed)

Implemented:

- Generic `ws-rpc.js`.
- Independent Files / Git full-screen pages with a shared Header.
- Git entry in Session detail.
- Files/Changes switching.
- Three Sections.
- Collapsing.
- Single-file and all operations.
- Discard confirmation.
- Automatic refresh from mutation snapshots.
- Diff/Code Viewer.
- Foreground/background and reconnect refresh.
- Safe area, landscape, and swipe-back.
- IndexedDB cache and LRU.
- Page refresh restore.
- stale-while-revalidate on page return.
- Sections expanded by default, collapsing, and sticky headers.

Main test files:

```text
test/frontend/git-status.test.mjs
test/frontend/project-files-refresh.test.mjs
test/frontend/project-data-cache.test.mjs
test/frontend/source-view.test.mjs
test/frontend/edge-back-click.test.mjs
test/frontend/edge-back-layers.test.mjs
test/browser/fixtures/project-data-cache.html
```

Results:

- Full Frontend test suite passes.
- Packaging boundary tests pass.
- Production build passes.
- Real Chrome IndexedDB smoke test passes for insert, overwrite, close-and-reopen read, single delete, delete by Project,
  clear, and cursor LRU.
- All new responsibility files are under 500 lines.

Final local verification (2026-09-07):

```text
Frontend:   330 passed
Packaging:  5 passed
Build:      PASS
IndexedDB:  CRUD / reopen / project delete / clear / LRU PASS
```

## 15. Git Graph

Git Graph / Commit History was not part of the two completed implementation phases above and is still not implemented.
The recommended plan for the next phase is in [Git Graph / History Mobile Design](git-history-design.md).

- The Header shows the working branch and ↑↓; the Graph, collapsed by default, draws branches and merges from real parents.
- Browsing scope supports Auto (HEAD + upstream), All branches, and a single branch; commits can expand to files and reuse the existing Diff page.
- Branch selection is only for history browsing and never runs checkout.
- Instead of the earlier idea of a separate `git_history` action, the recommendation is to add read-only operations under `git_status`, compatible with existing routing.
- The history list is still requested independently on demand, is not mixed into status change groups, and does not change existing mutation behavior.
