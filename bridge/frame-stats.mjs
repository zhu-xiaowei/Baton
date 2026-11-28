// Temporary measurement (phase 0, docs/v2-relay-plan.md): with BATON_FRAME_STATS=1 the Bridge logs, once a
// minute, how many frames of each kind it sent and received on the direct socket and their bytes. Counts
// only, never content. Delete this file and its two calls in direct-rpc.mjs when the numbers are in.
const enabled = process.env.BATON_FRAME_STATS === '1';
let counts = new Map();

export function countFrame(dir, kind, bytes) {
  if (!enabled) return;
  const key = dir + ' ' + kind;
  const entry = counts.get(key) || counts.set(key, { n: 0, bytes: 0 }).get(key);
  entry.n++;
  entry.bytes += bytes;
}

if (enabled) {
  setInterval(() => {
    if (!counts.size) return;
    const line = [...counts].sort((a, b) => b[1].n - a[1].n).map(([key, { n, bytes }]) => `${key}=${n}/${bytes}`).join(' ');
    console.log(`[frame-stats] ${line}`);
    counts = new Map();
  }, 60_000).unref();
}
