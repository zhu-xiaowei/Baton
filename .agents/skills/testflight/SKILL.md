---
name: testflight
description: Automatically publish a new Baton iOS TestFlight build when asked, using the macOS release script or an Xcode Cloud release branch on Linux. Check readiness without publishing when the user only asks a question.
---

# Baton TestFlight

Follow `.claude/commands/testflight.md`. A request to publish authorizes the
release's source commits, branch creation, pushes, build-number bump, cloud run,
and TestFlight group assignment. Perform these steps without asking for routine
approval. Before publishing, inspect `git status --short`, including untracked
files. Commit changes within the requested release scope automatically;
preserve unrelated work, using an isolated checkout when needed.

On macOS, run `npm run release:ios`.

On Linux, run the release from an unprotected release branch, not `main`:

- Reuse the current unprotected release branch, or automatically create one such
  as `release/testflight-<build-number>`.
- Push the release source commit to Xcode Cloud's connected GitHub repository.
  Run `node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then run
  `npm run release:ios:cloud` on that same branch in the same invocation.
  The cloud script commits and pushes its build-number bump before starting
  Xcode Cloud; a protected branch would reject that push.
- A PR is not required to publish. Finish and verify the release before the
  optional PR workflow below. Preserve branch protection.

If a protected-branch push fails after the script creates its bump commit,
preserve that commit. Move it onto an unprotected release branch automatically
and push the branch. Rerun the dry-run and release on
that branch; let the script decide whether the prepared build number is reusable
instead of manually bumping again. No cloud run starts when that push fails.

For readiness questions, only inspect state and use the dry-run on Linux.
Report the final build number, cloud run ID, and upload status; include a PR URL
only if one exists. The cloud script adds valid
builds to the internal **Test** group; confirm that state before saying testers
can install the build. If group assignment fails after upload, report the
existing build instead of starting another release.

After a successful release, summarize the build number, upload status, and
internal **Test** group status, then ask whether to create a PR and automatically
merge it after CI passes. Do not create a PR or enable auto-merge before the user
agrees. If a PR already exists, ask whether to reuse it and merge after CI.

On approval, create or reuse a PR from the release branch to `main`, including
the build-number bump and release changes. Wait for its required CI checks and
repository review requirements, resolve relevant failures within the approved
scope, and merge automatically when allowed. Use the repository's supported
merge method and never bypass branch protection. Confirm the merge result;
do not treat enabling auto-merge as a completed merge.
