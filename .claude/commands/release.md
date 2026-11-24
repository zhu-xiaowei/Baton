---
description: Publish Baton <version> — version bump PR, packages, hosted service, Latest GitHub Release, dl.agentbaton.app, TestFlight
argument-hint: <version> [--auto], e.g. 2.0.1
---

Arguments: `$ARGUMENTS` (version, optional `--auto`). Publish that version from
`main` as a normal (not Pre-release) GitHub Release marked Latest. The request
authorizes steps 1–3 up to a green PR. There, stop and ask: summarize the
version changes, the full release notes and the CI result. Once the user
confirms, or immediately with `--auto`, run steps 3–10 without further prompts.
On a failure, stop and report it. Every step first checks whether it is already done and
then reuses its result, so re-running the same command resumes the release.
Work in an isolated checkout of the latest `origin/main`; never force-push.
HarmonyOS (DevEco) is not part of this flow.

1. **Prepare** branch `release/<version>` (reuse it and its PR if present). The
   version must be higher than the latest normal release (`gh release list`);
   an existing tag is only allowed as a Pre-release of it. Follow "Prepare a
   versioned release" in `docs/package.md`: every location in its version table
   (HarmonyOS `versionCode` = major·1000000 + minor·1000 + patch; leave iOS
   `CFBundleVersion`), README download links and feature descriptions in all
   three languages, and version-specific QR codes (decode them to verify).
2. **Notes:** write `docs/releases/<version>.md` locally (untracked) in the
   format of the previous normal release (`gh release view <tag>`, e.g. v1.1.0):
   `## Highlights`, `## Fixes`, `## Upgrade`; English, user-facing changes from
   the PRs merged since the previous tag; repository links at `blob/v<version>/`.
   Upgrade: update the apps (dl.agentbaton.app, TestFlight), re-run the README's
   self-hosted server command with the same region, stack and profile; the
   hosted service and all Bridges update automatically.
3. **Merge:** PR `chore(release): <version>` to `main`, wait for all required
   checks and fix failures within the release scope. After the confirmation
   above, squash-merge and use the merged commit from here on.
4. **Package:** after that commit's `main` push CI passes, check out `main` at it
   and run `/package` (skip if `release/<version>/` already holds a complete
   set built from it). All four platforms must succeed.
5. **Check** `release/<version>/`: non-empty `Baton.apk`, `Baton.dmg`,
   `Baton.exe`, `Baton.deb`, `Baton.deb.sha256` matching the deb, and
   `install.sh` containing `DEFAULT_REF="v<version>"`.
6. **Hosted service** (before the apps, since new apps must not meet an old
   server): with `CF_ACCOUNT_ID`/`CF_API_TOKEN` and `BATON_PROD_SECRETS` (path
   of the production `--secrets` JSON; ask if missing), at the merged commit:
   ```
   node server/cloudflare/deploy.mjs --name baton --bucket baton-files --api-domain api.agentbaton.app \
     --web-domain web.agentbaton.app --install-domain agentbaton.app --zone 387d3d961b05753a9bb536e6545f817b \
     --secrets "$BATON_PROD_SECRETS" --rate-limit --usage-dataset baton_usage --zero-rtt \
     --relay-domain api-jp.agentbaton.app --relay-ips <A>,<AAAA of api-jp.agentbaton.app>
   ```
7. **Publish atomically:** upload everything to a draft first, so Latest never
   points at an incomplete release:
   ```
   gh release create v<version> release/<version>/{Baton.apk,Baton.dmg,Baton.exe,Baton.deb,Baton.deb.sha256,install.sh} \
     --draft --target <merged commit> --title "Baton v<version>" --notes-file docs/releases/<version>.md
   gh release edit v<version> --draft=false --prerelease=false --latest
   ```
   For an existing draft or Pre-release, `gh release upload --clobber` the
   assets and update the notes before the same `edit`.
8. **Downloads:** `node scripts/publish-downloads.mjs v<version>`.
9. **iOS:** run `/testflight` from the updated `main`; it merges its own
   build-number PR, so it comes after packaging.
10. **Verify:** `releases/latest/download/install.sh` contains
   `DEFAULT_REF="v<version>"`; the four dl.agentbaton.app files have the
   release assets' sizes; `https://api.agentbaton.app/api/version` reports
   `<version>-<merged short hash>`.

`push-relay/` and `home/` deploy separately (`push-relay/deploy.sh`,
`home/deploy.mjs`); if either changed since the previous tag, say so in the
report. Report the PR, merged commit, release URL, assets with sizes, the
TestFlight build, and every result of step 10.
