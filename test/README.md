# Tests

All repository tests live under this directory:

- `bridge/` - shared Bridge runtime, catalog, identity, and updater tests
- `codex/phase1/` - Codex discovery and extraction tests
- `codex/phase2/` - Codex realtime watcher tests and explicit live E2E validation
- `frontend/` - WebSocket stream-render regression harness
- `server/` - Server runtime compatibility tests
- `packaging/` - assertions that tests stay out of Bridge, Server, web, and Tauri artifacts

Run the local suites with:

```bash
npm test
```

The live Codex/AWS E2E test is intentionally separate:

```bash
npm run test:codex:e2e
```

The cross-platform-scale watcher stress test is also explicit:

```bash
npm run test:codex:stress
```
