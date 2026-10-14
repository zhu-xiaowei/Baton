---
name: testflight
description: Automatically publish a new Baton iOS TestFlight build, then create or reuse a PR and merge after required checks pass. Use the macOS release script or an Xcode Cloud release branch on Linux. Check readiness without publishing when the user only asks a question.
---

# Baton TestFlight

Follow `.claude/commands/testflight.md`. A request to publish authorizes the
release's source commits, branch creation, pushes, build-number bump, cloud run,
TestFlight group assignment, and the PR and merge after a successful release.
Perform these steps without asking for additional approval. Before publishing,
inspect `git status --short`, including untracked
files. Commit changes within the requested release scope automatically;
preserve unrelated work, using an isolated checkout when needed.

On macOS, run `npm run release:ios`.

On Linux, publish from the persistent, unprotected `release/testflight` branch,
not `main`:

- Reuse `release/testflight` for every release. Fetch and merge the latest
  `origin/main` into it while preserving its release commits. If it does not
  exist, create it from the prepared release commit or latest `origin/main`.
  Do not create a new branch for each build number or force-push this branch.
- Push the release source commit to Xcode Cloud's connected GitHub repository.
  Run `node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then run
  `npm run release:ios:cloud` on that same branch in the same invocation.
  The cloud script commits and pushes its build-number bump before starting
  Xcode Cloud; a protected branch would reject that push.
- Finish and verify the release before the automatic PR workflow below.
  Preserve branch protection.

If a protected-branch push fails after the script creates its bump commit,
preserve that commit. Move it onto `release/testflight` automatically
and push the branch. Rerun the dry-run and release on
that branch; let the script decide whether the prepared build number is reusable
instead of manually bumping again. No cloud run starts when that push fails.

For readiness questions, only inspect state and use the dry-run on Linux.
Report the final build number, cloud run ID, and upload status; include a PR URL
only if one exists. The cloud script adds valid
builds to the internal **Test** group; confirm that state before saying testers
can install the build. If group assignment fails after upload, report the
existing build instead of starting another release.

After a successful release, confirm the upload and internal **Test** group
status, then automatically create or reuse a PR to `main`, including the
build-number bump and release changes. Do not ask for separate approval.
Wait for its required CI checks and repository review requirements, resolve
relevant failures within the release scope, and merge automatically when
allowed. Use the repository's supported merge method and never bypass branch
protection. Confirm the merge result; do not treat enabling auto-merge as a
completed merge. Report the build number, upload and group status, PR URL,
and merge result. Do not merge a PR whose release failed.

Keep `release/testflight` after publishing and merging. If the repository
automatically deletes merged PR branches, create the PR from a
temporary branch at the same release commit instead.
