---
description: Build Android/macOS/Windows release packages into release/<version>/
allowed-tools: Bash(./scripts/package-all.sh), Bash(bash scripts/package-all.sh)
---

Build the release packages for the current `package.json` version and copy them
into `release/<version>/` as `Baton.apk`, `Baton.dmg`, `Baton.exe`.

Run the packaging script (it reads the version itself, builds all three
platforms independently, and copies the artifacts):

```
bash scripts/package-all.sh
```

This takes several minutes (each platform compiles Rust). When it finishes,
report the SUMMARY block verbatim — which platforms succeeded, where each file
landed and its size, and any that failed. Do not re-run failed platforms
unless asked. iOS is intentionally excluded (separate TestFlight flow via
`npm run release:ios`).
