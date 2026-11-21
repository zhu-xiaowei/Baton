// The hosted service's mainland-China relay (docs/v2-cn-relay.md), shared by the Bridge and the App. /api/version on the
// API host itself names the caller's country (as Cloudflare sees it) and the relay hosts; a caller in CN uses the first
// relay that answers, everyone else (and every failure) the API host.
// This caller's signed address (/api/version's ipToken), sent through the relay as x-baton-ip / ipt.
export const vouched = { token: '' };

export async function pickEntry(server, fetchImpl = fetch) {
  const get = async (base) => {
    const abort = new AbortController(); // not AbortSignal.timeout: iOS 14-15 WebViews lack it
    const timer = setTimeout(() => abort.abort(), 5000);
    try { return await (await fetchImpl(`${base}/api/version`, { signal: abort.signal })).json(); } finally { clearTimeout(timer); }
  };
  try {
    const { country, entries = [], ipToken } = await get(server);
    vouched.token = ipToken ?? '';
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
