---
description: Build iOS release IPA and upload a new TestFlight build (auto-bumps CFBundleVersion)
allowed-tools: Bash(npm run release:ios), Bash(./scripts/release-ios.sh), Bash(npm run release:ios:cloud), Bash(node scripts/release-ios-cloud.mjs --dry-run)
---

For TestFlight update notes (`whatsNew`), default to exactly
`Bug fixes and improvements.` when there are no major new user-facing features.
Use feature-specific notes for major additions, or the user's supplied wording.

A request to publish authorizes the release's source commits, branch creation,
pushes, build-number bump, cloud run, TestFlight group assignment, the PR
and merge after a successful release, and deletion of the release branch
after the merge is confirmed. Continue without additional approval
prompts. Before publishing, inspect `git status
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

After a successful release, commit the build-number changes for the PR below.

**On Linux:** Always use the fixed branch name `release/testflight`; never create
per-build branches such as `release/testflight-<N>`. Before each release, fetch
`origin` and merge the latest `origin/main` into `release/testflight`, preserving
its release commits. If the branch does not exist, create it from the prepared
release commit or latest `origin/main`. Commit release changes there, push it, run
`node scripts/release-ios-cloud.mjs --dry-run` as a preflight, then start the
real release in the background on that branch:

```
npm run release:ios:cloud
```

Never force-push. The cloud script commits and pushes its own
build-number bump before starting Xcode Cloud, so running it on protected `main`
fails before packaging or upload. Do not bypass branch protection.

The script waits for a valid upload and adds it to the internal **Test** group.
Wait until the upload is `VALID` and the group is `IN_BETA_TESTING` before
opening the PR. The dry-run and the
`Prepared <version> (<build>)` message are not completion of `/testflight`.

**After successful publication:** Automatically create or reuse a PR from the
existing `release/testflight` branch to `main` with the build-number bump and
release changes, without asking for separate approval. Do not create a
temporary PR branch.
Wait for all required CI checks and repository review requirements, resolve
relevant failures within the release scope, and merge using the repository's
supported method without bypassing branch protection. This repository supports
squash merge and has GitHub auto-merge disabled, so merge directly when ready.
Confirm the actual merge. After branch cleanup, report the build number, upload
status, internal **Test** group state, cloud run ID (or local IPA path), PR URL,
and merge result.
Continue monitoring through upload, required CI, merge, and branch cleanup;
do not stop after starting the upload, creating the PR, or enabling auto-merge.
Do not merge a PR whose release failed.

After confirming the PR is merged, delete `release/testflight` remotely and
locally, verifying GitHub's automatic deletion if applicable. Switch to `main`
before deleting the local branch. Do not restore it after merge; the next
release recreates the same fixed branch name from the latest `origin/main`.
Keep the branch if publication or merge fails so the release can be resumed.

If the script fails with `Xcode Cloud does not see branch`, wait briefly and
rerun it on the same branch; it reuses the already-pushed prepared version. Do
not manually bump again after a failed push. If upload succeeded but group
assignment failed, do not start another release for that error.
