---
name: testflight
description: Automatically publish a Baton iOS TestFlight build, create or reuse a PR from release/testflight, merge after required checks pass, and delete the branch after merge. Use the macOS release script or Xcode Cloud on Linux. Check readiness without publishing when the user only asks a question.
---

# Baton TestFlight

Follow `.claude/commands/testflight.md`. A request to publish authorizes the
release's source commits, branch creation, pushes, build-number bump, cloud run,
TestFlight group assignment, the PR and merge after a successful release,
and deletion of the release branch after the merge is confirmed.
Perform these steps without asking for additional approval. Before publishing,
inspect `git status --short`, including untracked
files. Commit changes within the requested release scope automatically;
preserve unrelated work, using an isolated checkout when needed.

On macOS, run `npm run release:ios`.

On Linux, publish from the fixed, unprotected `release/testflight` branch,
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

Wait until the TestFlight upload finishes, App Store Connect marks the build
`VALID`, and the internal **Test** group is `IN_BETA_TESTING`. Only then
automatically create or reuse a PR from the existing
`release/testflight` branch to `main`, including the build-number bump and
release changes. Do not create a temporary PR branch or ask for separate approval.
Wait for its required CI checks and repository review requirements, resolve
relevant failures within the release scope, and merge automatically when
allowed. Use the repository's supported merge method and never bypass branch
protection. Continue monitoring until the PR is actually merged and branch
cleanup below is complete; starting an upload, opening a PR, or enabling
auto-merge is not completion. Report the build number, upload and group status,
PR URL, and merge result. Do not merge a PR whose release failed.

After confirming the PR is merged, delete `release/testflight` remotely and
locally. If GitHub already deleted the remote branch, verify that it is gone.
Switch the working tree to `main` before deleting the local branch. Do not
restore the branch after merge; the next release recreates the same fixed
branch name from the latest `origin/main`. Keep the branch if publication or
merge fails so the release can be resumed.
