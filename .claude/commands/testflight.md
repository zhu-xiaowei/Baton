---
description: Build iOS release IPA and upload a new TestFlight build (auto-bumps CFBundleVersion)
allowed-tools: Bash(npm run release:ios), Bash(./scripts/release-ios.sh), Bash(npm run release:ios:cloud), Bash(node scripts/release-ios-cloud.mjs --dry-run)
---

For TestFlight update notes (`whatsNew`), default to exactly
`Bug fixes and improvements.` when there are no major new user-facing features.
Use feature-specific notes for major additions, or the user's supplied wording.

A request to publish authorizes the release's source commits, branch creation,
pushes, build-number bump, cloud run, and TestFlight group assignment. Continue
without routine approval prompts. Before publishing, inspect `git status
--short`, including untracked files. Automatically commit changes within the
requested release scope and preserve unrelated work, using an isolated checkout
when needed. Continue with the release in the same invocation.

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

**On Linux:** Always use the fixed branch name `release/testflight`; never create
per-build branches such as `release/testflight-<N>`. Before each release, fetch
`origin`, then create `release/testflight` from the latest `origin/main` (delete
any stale local copy first). Commit release changes there, push it, run
`node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then start the
real release in the background on that branch:

```
npm run release:ios:cloud
```

Never use `git merge` or force-push. The cloud script commits and pushes its own
build-number bump before starting Xcode Cloud, so running it on protected `main`
fails before packaging or upload. Do not bypass branch protection.

As soon as the script prints `Prepared <version> (<build>)` (the bump is pushed),
open a PR from `release/testflight` to `main` without asking. Creating a PR is
not proof of upload. The script waits for a valid upload and adds it to the
internal **Test** group. The dry-run is not completion of `/testflight`.

When the build finishes, report the cloud run ID, build number, upload status,
internal **Test** group state, and the PR URL. Once the release has succeeded
and the PR's required checks pass, squash-merge it (GitHub auto-merge is
disabled, so merge directly) and confirm the merge. The repository deletes the
branch on merge; delete it manually if it remains. Do not merge a PR whose
release failed.

If the script fails with `Xcode Cloud does not see branch`, wait briefly and
rerun it on the same branch; it reuses the already-pushed prepared version. Do
not manually bump again after a failed push. If upload succeeded but group
assignment failed, do not start another release for that error.
