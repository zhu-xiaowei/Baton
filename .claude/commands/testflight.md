---
description: Build iOS release IPA and upload a new TestFlight build (auto-bumps CFBundleVersion)
allowed-tools: Bash(npm run release:ios), Bash(./scripts/release-ios.sh), Bash(npm run release:ios:cloud), Bash(node scripts/release-ios-cloud.mjs --dry-run)
---

For TestFlight update notes (`whatsNew`), default to exactly
`Bug fixes and improvements.` when there are no major new user-facing features.
Use feature-specific notes for major additions, or the user's supplied wording.

Before publishing, inspect `git status --short`, including untracked files.
If there are changes, show the files that would be included and ask whether
to commit them and continue. Wait for the answer. Commit only agreed files;
if the user declines, stop. When the worktree is clean, continue with the
release in the same invocation.

**On macOS:**

Ship a new TestFlight build. Run the release script — it auto-bumps
`CFBundleVersion` in `src-tauri/gen/apple/project.yml`, builds the release IPA,
validates it, and uploads to TestFlight via the App Store Connect API:

```
npm run release:ios
```

Run it in the background (build + upload takes several minutes) and monitor the
output. When it finishes, report the result: the bumped CFBundleVersion, the IPA
path, and whether validation + upload succeeded. If it fails, show the error.

Do not commit the `project.yml` version bump unless asked.

**On Linux:** Run the release from an unprotected release branch, not `main`.
Reuse the current release branch, or obtain approval to create a branch such as
`release/testflight-<build-number>` if branch creation is not already authorized.
After the agreed changes are committed, push the source commit to the GitHub
repository connected to Xcode Cloud. Run
`node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then continue
with the real release on that same branch:

```
npm run release:ios:cloud
```

The cloud script commits and pushes its own build-number bump before starting
Xcode Cloud, so running it on protected `main` fails before packaging or upload.
Create or reuse a PR targeting `main` for the release branch, including the bump;
do not bypass branch protection. The PR can be created once the bump is pushed
while the cloud run is in progress. Creating a PR is not proof of upload.

If a protected-branch push already failed after the bump commit was created,
preserve that commit. With approval, create an unprotected release branch from
it, push the branch, and create or reuse its PR. Rerun the dry-run and release
there; the script decides whether to reuse the prepared version. Do not manually
bump again just because the push failed.

The script waits for a valid upload and adds it to the internal **Test** group.
The dry-run is not completion of `/testflight`. Report the PR URL, cloud run ID,
build number, and TestFlight state. If upload succeeded but group assignment
failed, do not start another release for that error.
