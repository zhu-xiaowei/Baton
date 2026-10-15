# Xcode cache experiment on PR #64

Decision: do not adopt this cache. Both warm runs passed, but neither established
a reliable improvement over the existing Rust-only cache. PR #64 was restored
to its pre-experiment tree, including the original CI configuration. This branch
retains the candidate for reference; its temporary PR cache-write exception has
been removed.

## Controlled scope

- All reported comparisons ran on PR #64. Its business source did not change.
- The iOS build command, compiler flags, test suites and five CI jobs stayed the
  same.
- The candidate added Xcode module, SDK-stat and archive-intermediate directories
  to the existing Rust cache archive. Final apps, archives and signing materials
  were excluded.
- One initial run populated a PR-scoped combined cache. Its cold-build and
  upload time is excluded from the two warm results.
- Both measured warm runs logged an exact hit for the same combined cache.
  The only Cargo.lock difference from main is a local plugin entry, rather than
  a change in external dependency versions.

## Results

| Run | iOS job, including setup and restore | Tauri build/compile/archive step |
| --- | ---: | ---: |
| Existing cache, run 1 | 3:13 | 2:08 |
| Existing cache, run 2 | 3:05 | 2:15 |
| Existing cache, contemporaneous run 3 | 1:45 | 1:13 |
| Combined Rust/Xcode cache, warm run 1 | 3:27 | 2:27 |
| Combined Rust/Xcode cache, warm run 2 | 2:29 | 1:46 |

Every listed run passed all five jobs. Runtime variance is substantial, and
these samples do not support attributing a speedup to the added Xcode cache.
The contemporaneous Rust-only run was faster than both candidate runs.

Xcode DerivedData occupied only about 14–15 MiB uncompressed. The combined
cache archive was 511,206,712 bytes; the existing main iOS PR Rust archive was
510,235,014 bytes. This is a small addition to an existing roughly 510 MB
archive, not an additional 510 MB Xcode cache.

Tauri builds Swift plugin libraries through Cargo build scripts, so some native
dependency outputs already travel with the Rust cache. Changed local plugins
still need rebuilding. The additional DerivedData cache therefore covers much
less work than the full iOS build duration suggests.

## Evidence

- [Existing cache, runs 1–3](https://github.com/zhu-xiaowei/Baton/actions/runs/38685334568)
- [Combined cache, initial population](https://github.com/zhu-xiaowei/Baton/actions/runs/38687152036/attempts/1)
- [Combined cache, warm run 1](https://github.com/zhu-xiaowei/Baton/actions/runs/38687152036/attempts/2)
- [Combined cache, warm run 2](https://github.com/zhu-xiaowei/Baton/actions/runs/38687152036/attempts/3)

The temporary combined cache is deleted after the experiment. Existing main
Rust, Gradle, npm and pip caches are retained.
