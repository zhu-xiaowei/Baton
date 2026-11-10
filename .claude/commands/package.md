---
description: Build Android/macOS/Windows/Linux release packages into release/<version>/
allowed-tools: Bash(./scripts/package-all.sh), Bash(bash scripts/package-all.sh), Bash(npm run package:linux)
---

Build the release packages for the current `package.json` version and copy them
into `release/<version>/` as `Baton.apk`, `Baton.dmg`, `Baton.exe`, and
`Baton.deb` with its verified `Baton.deb.sha256`.

Run the packaging script (it reads the version itself and collects all four
platforms independently):

```
bash scripts/package-all.sh
```

On macOS the script builds Android, macOS, and Windows locally, then invokes
the Linux runner. On Linux it dispatches the native GitHub
Actions workflow for the pushed source commit and downloads all four platforms.
See `docs/package.md` for one-time GitHub secrets and other prerequisites.

This takes several minutes (each platform compiles Rust). When it finishes,
report the SUMMARY block verbatim — which platforms succeeded, where each file
landed and its size, and any that failed. Do not re-run failed platforms
unless asked. iOS is intentionally excluded (separate TestFlight flow via
`npm run release:ios`).
