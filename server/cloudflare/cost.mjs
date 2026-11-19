// Workers Paid list prices (USD) and included usage per month; the Free plan's limits. Checked 2026-11-19 against
// https://developers.cloudflare.com/workers/platform/pricing/ (Workers, Durable Objects SQLite),
// https://developers.cloudflare.com/r2/pricing/ and https://developers.cloudflare.com/analytics/analytics-engine/pricing/.
// Usage keys come from monitor.mjs's GraphQL totals.
export const PRICE = { workerRequests: 0.30e-6, workerCpuMs: 0.02e-6, doRequests: 0.15e-6, doGbSec: 12.5e-6, rowsRead: 0.001e-6,
  rowsWritten: 1e-6, sqlGbMonths: 0.20, r2GbMonths: 0.015, r2ClassA: 4.5e-6, r2ClassB: 0.36e-6 }; // AE ($0.25/M over 10M) is not billed yet
const INCLUDED = { workerRequests: 10e6, workerCpuMs: 30e6, doRequests: 1e6, doGbSec: 400e3, rowsRead: 25e9, rowsWritten: 50e6,
  sqlGbMonths: 5, r2GbMonths: 10, r2ClassA: 1e6, r2ClassB: 10e6 };
// The quotas shown per plan: Free counts most per day (R2 operations per month), Paid's included usage per month;
// sqlBytes / r2Bytes are current storage.
const STORAGE = { sqlBytes: 5e9, r2Bytes: 10e9 };
export const PLANS = {
  free: { workerRequests: 100e3, doRequests: 100e3, doGbSec: 13e3, rowsRead: 5e6, rowsWritten: 100e3, aePoints: 100e3, r2ClassA: 1e6, r2ClassB: 10e6, ...STORAGE },
  paid: { ...Object.fromEntries(Object.entries(INCLUDED).filter(([k]) => !k.endsWith('GbMonths'))), aePoints: 10e6, ...STORAGE },
};
export const MONTHLY_ON_FREE = new Set(['r2ClassA', 'r2ClassB']);

// Durable Object requests: invocations other than hibernated WebSocket deliveries, plus incoming messages at 20:1.
export const doRequests = (u) => (u.calls ?? 0) + (u.wsIn ?? 0) / 20;

// One account object's month at list price, with the Worker request in front of each of its HTTP calls.
export const accountCost = (u) => (u.http ?? 0) * PRICE.workerRequests + doRequests(u) * PRICE.doRequests
  + (u.gbSec ?? 0) * PRICE.doGbSec + (u.rowsRead ?? 0) * PRICE.rowsRead + (u.rowsWritten ?? 0) * PRICE.rowsWritten;

// The service's month: { usage: list price of everything, items: per price, bill: Workers Paid ($5 with included usage) }.
export function serviceCost(t) {
  const keys = Object.keys(PRICE).filter((k) => t[k]);
  const items = Object.fromEntries(keys.map((k) => [k, t[k] * PRICE[k]]));
  return { usage: Object.values(items).reduce((a, b) => a + b, 0), items,
    bill: 5 + keys.reduce((sum, k) => sum + Math.max(0, t[k] - INCLUDED[k]) * PRICE[k], 0) };
}

// Month-end projection at the month's average rate so far (UTC).
export function projected(amount, now = new Date()) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return amount * (end - start) / Math.max(now - start, 3_600_000);
}
export const nextMonth = (now = new Date()) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
