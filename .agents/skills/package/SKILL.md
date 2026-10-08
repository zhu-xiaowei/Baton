---
name: package
description: Build Baton Android, macOS, and Windows release installers into the versioned release directory. Use when asked to run $package or package desktop and Android releases.
---

# Baton packages

From the repository root, run `bash scripts/package-all.sh`. On macOS it builds locally. On Linux it triggers the native GitHub Actions packaging workflow and downloads the three results. A Linux run requires the source commit on the connected GitHub branch and the repository secrets listed in `docs/package.md`.

Report the script's SUMMARY block, including the size of each available artifact and any failed platform. Treat a failed platform as incomplete; do not claim an unsigned or unnotarized artifact is ready. Do not start another cloud run just because one platform fails.

iOS uses the separate TestFlight flow.
