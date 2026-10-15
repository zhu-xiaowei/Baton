# CI build performance

PR CI keeps five jobs: Tests and frontend, Android APK, iOS archive, macOS DMG,
and Windows NSIS. The separate PR title check is unchanged.

Independent JavaScript and Python test suites run concurrently inside the
existing test job. Each suite's exit status is collected, so any failure still
fails the job. The frontend is built first so packaging tests inspect a complete
`dist` directory.

## PR and production builds

PR native builds retain release-mode compilation, but disable LTO, use 16
codegen units and optimize at level 1. macOS PRs build an Apple Silicon DMG.
Production packaging keeps
the existing size-optimized release profile, universal macOS binary, signing,
notarization, and installer formats.

The macOS port fallback test remains in its existing job. It opens real TCP
listeners and checks that an occupied port causes a fallback; compiling an
installer does not exercise this behavior.

## Cache warming

The shared `rust-build-cache` action pins Rust 1.98.1 and separates PR
(`src-tauri/target-ci`) and production (`src-tauri/target`) caches. Cache keys
include the platform, build flavor, SDK, runner image, compiler, Cargo
configuration, and dependency manifests. Rust dependency build products are
cached; distributable installers and signing keys are not.

Android reuses preinstalled SDK components and the NDK selected by Tauri instead
of downloading a second, unused NDK. Missing SDK components are installed as a
fallback. It also uses the Gradle dependency and task-output caches; PRs skip
Gradle's end-of-job cache cleanup JVM, while main and Package retain cleanup.
The test job caches both npm lockfiles and Python package downloads.

After restoring Rust dependencies, an offline `cargo fetch --locked` checks every
requested target. Builds use Cargo's offline mode only when that check succeeds;
an incomplete cache retains normal network access. This avoids redundant index
refreshes without making a cold build depend on a cache hit.

After a merge, the same five CI jobs run on `main`. Each native job builds its PR
configuration and then warms the production configuration without production
signing credentials. New PRs and Package runs can restore matching caches from
`main`; a PR cache alone is not shared with other PRs.
New PR commits cancel superseded PR checks, while a running `main` warm-up is
allowed to finish even if another PR merges.

Consequently, the first run after a toolchain, runner image, or dependency change
can still be slow. `main` cache warming takes longer than the PR checks because
it builds both configurations. It is background work after merging, not another
PR prerequisite.

The number and names of jobs are unchanged. The macOS local packaging scripts
are unchanged. In cloud Package, the two macOS architectures still compile
sequentially inside the existing job; splitting them across runners would
require additional jobs.
