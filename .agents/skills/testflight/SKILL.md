---
name: testflight
description: Publish a new Baton iOS TestFlight build when asked, using the macOS release script or Xcode Cloud on Linux. Check readiness without publishing when the user only asks a question.
---

# Baton TestFlight

Follow `.claude/commands/testflight.md`. Before publishing, inspect
`git status --short`, including untracked files. If there are changes, list the
files to include and ask whether to commit them and continue. Wait for an
explicit answer; commit only agreed files. If the user declines, stop.

On macOS, run `npm run release:ios`. On Linux, push the agreed source commit to
Xcode Cloud's connected GitHub repository, run
`node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then run
`npm run release:ios:cloud` in the same invocation. The cloud script commits
and pushes its build-number bump.

For readiness questions, only inspect state and use the dry-run on Linux.
Report the final build number and upload status. The cloud script adds valid
builds to the internal **Test** group; confirm that state before saying testers
can install the build. If group assignment fails after upload, report the
existing build instead of starting another release.
