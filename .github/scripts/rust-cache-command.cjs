// The build may be offline, but cache cleanup needs metadata for every target.
const { spawnSync } = require('node:child_process');
const [command, ...args] = process.argv.slice(2);

if (command === 'rustup' && args[0] === 'toolchain' && args[1] === 'list') {
  // This repository builds with one pinned toolchain; unrelated installed
  // toolchains must not change the cache environment fingerprint.
  if (!process.env.RUSTUP_TOOLCHAIN) throw new Error('RUSTUP_TOOLCHAIN must be pinned');
  console.log(process.env.RUSTUP_TOOLCHAIN);
} else {
  if (!command) throw new Error('Cache command is required');
  const result = spawnSync(command, args, {
    env: { ...process.env, CARGO_NET_OFFLINE: 'false' },
    stdio: 'inherit',
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
