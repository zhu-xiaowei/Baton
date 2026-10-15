# CI build performance and release checks

PR CI keeps five jobs: Tests and frontend, Android APK, iOS archive, macOS DMG,
and Windows NSIS. The separate PR title check is unchanged. There is no
path-based skipping of native builds.

Independent JavaScript and Python test suites run concurrently inside the
existing test job. Every suite's exit status is collected, so any failure fails
the job. The frontend is built first so packaging tests inspect a complete
`dist` directory. No existing tests or assertions are removed.

## Toolchains

The root `rust-toolchain.toml` is the Rust version source for both local Cargo
commands and GitHub Actions. CI reads this file instead of maintaining a second
version in an action input. Local release scripts keep their existing commands.
Changing this pin is a toolchain change and needs native build validation.

`.github/android-ndk-version` pins the NDK used by cloud Android builds. Version
30.0.16248370 matches the actual compiler in the
[pre-change production Package run](https://github.com/zhu-xiaowei/Baton/actions/runs/38520988251).
That workflow requested NDK 27, but Tauri 2.11 selected the newest installed NDK
instead of honoring `NDK_HOME`.

CI reuses the pinned NDK if installed and installs that exact version otherwise.
It exposes an SDK view containing only that NDK, so Tauri cannot silently select
a newer version. NDK upgrades or a rollback to 27 require a separate toolchain
change and validation; they are not cache optimizations.

## PR coverage and production coverage

PR native builds retain release-mode compilation, but disable LTO, use 16
codegen units and optimize at level 1. macOS PRs build an Apple Silicon DMG.
This deliberately does **not** check Intel/universal packaging or the full
production optimizer and LTO before merging.

After merging, the same native jobs on `main` also run the existing production
configuration: size optimization, full LTO, one codegen unit, and a universal
macOS binary. Signing, notarization and installer formats in Package are
unchanged.

The macOS port fallback test stays in its original job. It opens real TCP
listeners and verifies fallback from an occupied port; compiling an installer
does not exercise this behavior.

**A red main CI must be fixed before release.** Production Package checks the
latest main push CI for the exact dispatched SHA and requires every production
build step to have passed. An older green commit, a PR-only build, skipped jobs,
or a pending/failed run cannot authorize a release. The check fails promptly
with the CI link rather than repeating the builds. Dev packages remain
available for diagnosis and do not pass this production release gate.

## Caches

Large Rust and Gradle caches are written only on `main`; PRs and packaging from
other branches only restore them. The first main run initializes both PR and
production cache variants. Superseded PR checks can be cancelled, while a
running main warm-up is allowed to finish.

Rust cache keys include the selected Rust/Cargo binaries, actual Xcode SDK,
NDK or MSVC toolset, build flags and project Cargo manifests. They exclude the
whole runner image ID and unrelated preinstalled Rust versions. PR
(`src-tauri/target-ci`) and production (`src-tauri/target`) products are isolated.
Installers, archives and signing keys are not stored in this cache.
The cache action normalizes Cargo manifests and can restore compatible
dependency artifacts after a lockfile change; Cargo rebuilds changed crates.

Android also restores Gradle dependency and task-output caches. PRs skip
Gradle's cache-cleanup JVM; main retains cleanup. npm and pip use their normal
download caches. Closed-PR caches can be deleted; do not delete active main
caches to make room for repeated PR snapshots.

An offline `cargo fetch --locked` checks every requested target after restore.
Cargo networking is disabled only if the complete dependency set is cached;
otherwise normal network access remains enabled.
Cache-management commands always retain network access: their all-target
metadata query may need dependencies that the selected build target did not
download. This keeps build-only offline mode from producing an empty dependency
list during cache cleanup.

Cache hits reduce repeated compilation, but SDK/toolchain/dependency changes
still require rebuilding. Before this PR is merged, the new main cache keys
have not been populated, so read-only PR runs may be cold. Report cache misses
separately from warm-run timings.

The macOS local packaging flow is unchanged. Cloud Package still compiles both
macOS architectures inside its existing job; splitting them across runners
would require additional jobs.
