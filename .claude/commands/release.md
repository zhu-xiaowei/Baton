---
description: Publish Baton <version> — version bump PR, packages, hosted service, Latest GitHub Release, dl.agentbaton.app, TestFlight
argument-hint: <version> [--auto], e.g. 2.0.1
---

Publish `$ARGUMENTS` (version, optional `--auto`) from `main` as a normal GitHub
Release marked Latest. Run steps 1–3 up to a green PR, then stop and ask with a
summary of the version changes, the full notes and CI. After confirmation, or at
once with `--auto`, run the rest without prompts. Stop on any failure. Each step
reuses what an earlier run already did, so re-running resumes.
Work in a clone on `main` at `../baton-release-<version>` (packaging needs a
branch matching `origin`; `main` is checked out elsewhere), reused on re-runs,
with the main checkout's `.env.local` copied in. Never force-push. HarmonyOS is
not part of this flow.

1. **Prepare** branch `release/<version>`. The version must be higher than the
   latest normal release; an existing tag is only allowed as a Pre-release.
   Follow "Prepare a versioned release" in `docs/package.md`: its version table,
   README download links and feature descriptions in all three languages, and
   version-specific QR codes (decode them to verify).
2. **Notes** in `release/<version>/notes.md` (must stay git-ignored), in the format
   of the previous normal release (`gh release view`, e.g. v1.1.0): `## Highlights`,
   `## Fixes`, `## Upgrade`; English, user-facing changes since the previous tag,
   repository links at `blob/v<version>/`. Upgrade: update the apps
   (dl.agentbaton.app, TestFlight), re-run the README's self-hosted server command
   with the same region, stack and profile; the hosted service and Bridges update
   automatically.
3. **Merge:** PR `chore(release): <version>` to `main`; fix failing checks within
   the release scope. After confirmation, squash-merge; use the merged commit from
   here on.
4. **Package:** once its `main` push CI passes, run `/package` with `main` at it. All four platforms
   must succeed, giving the six files listed in step 6.
5. **Hosted service**, before the apps so they never meet an old server; needs
   `CF_ACCOUNT_ID`, `CF_API_TOKEN` and `BATON_PROD_SECRETS` (production
   `--secrets` JSON path; ask if missing):
   ```
   npm ci
   node server/cloudflare/deploy.mjs --name baton --bucket baton-files --api-domain api.agentbaton.app \
     --web-domain web.agentbaton.app --install-domain agentbaton.app --zone 387d3d961b05753a9bb536e6545f817b \
     --secrets "$BATON_PROD_SECRETS" --rate-limit --usage-dataset baton_usage --zero-rtt \
     --relay-domain api-jp.agentbaton.app --relay-ips <A>,<AAAA of api-jp.agentbaton.app>
   ```
6. **Publish** through a draft, so Latest is never incomplete. First remove an
   existing draft or Pre-release of this version (`gh release delete v<version> -y`,
   plus `--cleanup-tag` if its tag exists, e.g. v2.0.0 on an older commit).
   ```
   gh release create v<version> release/<version>/{Baton.apk,Baton.dmg,Baton.exe,Baton.deb,Baton.deb.sha256,install.sh} \
     --draft --target <merged commit> --title "Baton v<version>" --notes-file release/<version>/notes.md
   gh release edit v<version> --draft=false --prerelease=false --latest
   ```
7. **Downloads:** `node scripts/publish-downloads.mjs v<version>`.
8. **iOS:** `/testflight` from the updated `main`.
9. **Verify:** `releases/latest/download/install.sh` contains
   `DEFAULT_REF="v<version>"`; the four dl.agentbaton.app files match the release
   asset sizes; `https://api.agentbaton.app/api/version` is
   `<version>-<merged short hash>`.

Report the PR, merged commit, release URL, asset sizes, TestFlight build and the
step 9 results, and whether `push-relay/` or `home/` changed since the previous tag
(they deploy separately).
