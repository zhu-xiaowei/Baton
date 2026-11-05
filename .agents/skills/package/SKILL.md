---
name: package
description: Build Baton Android, macOS, Windows, and Linux release installers into the versioned release directory. Use when asked to run $package or package desktop and Android releases.
---

# Baton packages

From the repository root, run `bash scripts/package-all.sh`. On macOS it builds Android, macOS, and Windows locally, then invokes the Linux runner. On Linux it triggers the native GitHub Actions packaging workflow and downloads all four platforms, including `Baton.deb` and its verified `Baton.deb.sha256`. Cloud packaging requires the source commit on the connected GitHub branch and the applicable repository secrets listed in `docs/package.md`.

Report the script's SUMMARY block, including the size of each available artifact, Linux checksum verification, and any failed platform. Treat a failed platform as incomplete. macOS releases must be signed and notarized; Windows and Linux packages are currently unsigned. Do not start another cloud run just because one platform fails.

iOS uses the separate TestFlight flow.
