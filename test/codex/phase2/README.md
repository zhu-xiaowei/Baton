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

