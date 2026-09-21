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

## Compiler-free Bridge updates

Install the Bridge dependencies before running the packaging checks:

```bash
npm ci --prefix bridge --omit=dev --include=optional
npm run test:packaging
```

`node-pty` is pinned to the official `1.2.0-beta.15` prerelease because it ships
Linux x64 and ARM64 prebuilds; `1.1.0` requires a compiler on those platforms.
`packaging/pty-prebuilds.test.mjs` checks the lockfile and all six desktop prebuilds.

Run `node clean-install.mjs <staged-bridge> [legacy-platform.mjs]` in a disposable
Linux container with Node/npm but without Python, make, GCC, or G++. The stage must
contain the production Bridge files, `package.json`, and `package-lock.json`.
The optional legacy installer exercises an older Bridge's actual dependency
installation path. The test installs dependencies, runs their validation, and
checks real PTY input/output and resizing. Do not install build tools to make it pass.
