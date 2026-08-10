# Codex Phase 2 tests

```bash
npm run test:codex
```

This covers append-only extraction, partial trailing JSON, watermark retry semantics, Parcel
root discovery, bounded active/recent rollout watchers, rename, multiple `CODEX_HOME` roots,
status transitions, WS ack/fallback, WebSearch/background-command mapping, and oversized frames.

The 10,000-Session native watcher stress test is explicit:

```bash
npm run test:codex:stress
```

The live AWS/Codex validation is explicit because it starts real model turns:

```bash
npm run test:codex:e2e
```

It uses an isolated temporary `CODEX_HOME`, starts two concurrent Codex Sessions, subscribes through
the deployed App WS endpoint, compares rollout and WS arrival, checks DDB UUID uniqueness/final
metadata, and removes the temporary Session/Project metadata.
