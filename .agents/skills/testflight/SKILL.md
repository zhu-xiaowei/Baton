---
name: testflight
description: Publish a new Baton iOS TestFlight build when asked, using the macOS release script or Xcode Cloud with a release branch and PR on Linux. Check readiness without publishing when the user only asks a question.
---

# Baton TestFlight

Follow `.claude/commands/testflight.md`. Before publishing, inspect
`git status --short`, including untracked files. If there are changes, list the
files to include and ask whether to commit them and continue. Wait for an
explicit answer; commit only agreed files. If the user declines, stop.

On macOS, run `npm run release:ios`.

On Linux, run the release from an unprotected release branch, not `main`:

- Reuse the current release branch, or obtain approval to create one such as
  `release/testflight-<build-number>` if branch creation is not already authorized.
- Push the agreed source commit to Xcode Cloud's connected GitHub repository.
  Run `node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then run
  `npm run release:ios:cloud` on that same branch in the same invocation.
  The cloud script commits and pushes its build-number bump before starting
  Xcode Cloud; a protected branch would reject that push.
- Create or reuse a PR targeting `main` for the release branch, including the
  build-number bump. Do not bypass branch protection. Creating the PR does not
  mean a build has been packaged or uploaded; verify the cloud run separately.

If a protected-branch push fails after the script creates its bump commit,
preserve that commit. With approval, move it onto an unprotected release branch,
push the branch, and create or reuse its PR. Rerun the dry-run and release on
that branch; let the script decide whether the prepared build number is reusable
instead of manually bumping again. No cloud run starts when that push fails.

For readiness questions, only inspect state and use the dry-run on Linux.
Report the final build number and upload status. The cloud script adds valid
builds to the internal **Test** group; confirm that state before saying testers
can install the build. If group assignment fails after upload, report the
existing build instead of starting another release.
