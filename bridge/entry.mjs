// The hosted service's mainland-China relay (docs/v2-cn-relay.md), shared by the Bridge and the App. /api/version on the
// API host itself names the caller's country (as Cloudflare sees it) and the relay hosts; a caller in CN uses the first
// relay that answers, everyone else (and every failure) the API host.
export async function pickEntry(server, fetchImpl = fetch) {
  const get = async (base) => (await fetchImpl(`${base}/api/version`, { signal: AbortSignal.timeout(5000) })).json();
  try {
    const { country, entries = [] } = await get(server);
    for (const entry of country === 'CN' ? entries : []) {
      if ((await get(entry).catch(() => null))?.version) return entry;
    }
  } catch {}
  return server;
}

// `url` on the API host, sent through `entry` instead.
export function viaEntry(url, server, entry) {
  if (!entry || entry === server) return url;
  const target = new URL(url);
  if (target.host !== new URL(server).host) return url;
  target.host = new URL(entry).host;
  return target.href;
}
