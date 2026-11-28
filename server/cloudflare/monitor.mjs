// The monitoring Worker (monitor.agentbaton.app, behind Cloudflare Access). Every 5 minutes MonitorStore probes the service,
// reads Cloudflare's analytics, blocks accounts over the monthly cost cap and emails alerts; the dashboard reads its
// snapshots plus live Analytics Engine / GraphQL figures. Deployed by deploy.mjs --monitor (docs/v2-cloudflare-design.md §14).
import { DurableObject } from 'cloudflare:workers';
import { EmailMessage } from 'cloudflare:email';
import { MONTHLY_ON_FREE, PLANS, accountCost, doRequests, nextMonth, projected, serviceCost } from './cost.mjs';
import page from './monitor.html';

const MIN = 60_000;
const PROBES = ['version', 'rest', 'ws'];
const iso = (t) => new Date(t).toISOString();
const list = (text) => (text ?? '').split(',').filter(Boolean);
const sum = (rows, f) => (rows ?? []).reduce((n, r) => n + (f(r) ?? 0), 0);
// An account's hash in the usage dataset (usage.mjs accountHash); the probe's and purged accounts' points are left out.
// A copy of usage.mjs accountHash: importing it would bring server/core into this Worker.
const hashOf = async (name) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)))].slice(0, 8)
  .map((b) => b.toString(16).padStart(2, '0')).join('');
const skipped = (env, state) => [env.PROBE_HASH, ...Object.values(state?.purged ?? {}).map((p) => p.hash)].map((h) => `'${h}'`).join(', ');

// Until the operator adds the read-only token, analytics, the cost cap and their alerts stay off (probes still run).
const NO_TOKEN = 'ANALYTICS_TOKEN is not set';
async function cfApi(env, path, body, type = 'application/json') {
  if (!env.ANALYTICS_TOKEN) throw new Error(NO_TOKEN);
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method: 'POST', body,
    headers: { authorization: `Bearer ${env.ANALYTICS_TOKEN}`, 'content-type': type }, signal: AbortSignal.timeout(20_000) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors?.length) throw new Error(`${path}: ${res.status} ${JSON.stringify(json?.errors ?? json).slice(0, 300)}`);
  return json;
}
const gql = async (env, query, vars) => (await cfApi(env, '/graphql', JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, ...vars } }))).data.viewer;
// Analytics Engine SQL; counts are weighted by AE's own sampling (_sample_interval) and our 1-in-10 detail weight (double4).
const ae = async (env, sql) => (await cfApi(env, `/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, sql, 'text/plain')).data;

// ---- Probes: the public version, a REST call through the probe account's object, a WebSocket ping ----

async function timed(fn) {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - start };
  } catch (error) {
    return { ok: false, ms: Date.now() - start, error: String(error.message).slice(0, 200) };
  }
}
const expectOk = async (res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); await res.arrayBuffer(); };

async function wsPing(env) {
  const res = await fetch(`${env.TARGET_API}/ws?role=app&apiKey=${encodeURIComponent(env.PROBE_TOKEN)}`, { headers: { upgrade: 'websocket' },
    signal: AbortSignal.timeout(10_000) });
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade HTTP ${res.status}`);
  ws.accept();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no realtime_pong in 10 s')), 10_000);
    ws.addEventListener('message', (e) => { if (String(e.data).includes('realtime_pong')) { clearTimeout(timer); resolve(); } });
    ws.addEventListener('close', (e) => { clearTimeout(timer); reject(new Error(`closed ${e.code} ${e.reason}`)); });
    ws.send('{"action":"realtime_ping"}');
  });
  ws.close(1000, 'probe');
}

const probe = (env) => Promise.all([
  timed(async () => expectOk(await fetch(`${env.TARGET_API}/api/version`, { signal: AbortSignal.timeout(10_000) }))),
  timed(async () => expectOk(await fetch(`${env.TARGET_API}/api/bridge/devices`, { headers: { 'x-api-key': env.PROBE_TOKEN },
    signal: AbortSignal.timeout(10_000) }))),
  timed(() => wsPing(env))]);

// ---- Usage: month-to-date per account object (top 100) and service totals, today's Free quotas, who is online ----

const USAGE = `query($a:string!,$ns:string!,$nss:[string!],$scripts:[string!],$month:Date!,$day:Date!,$recent:Time!,$spike:Time!,$store:Time!,$service:string!,$push:string!){viewer{
  accounts(filter:{accountTag:$a}){
    byTime:durableObjectsPeriodicGroups(limit:100,filter:{namespaceId:$ns,date_geq:$month},orderBy:[sum_duration_DESC]){sum{duration inboundWebsocketMsgCount rowsRead rowsWritten} dimensions{name objectId}}
    byWs:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId:$ns,date_geq:$month,type:"hibernation"},orderBy:[sum_requests_DESC]){sum{requests} dimensions{name objectId}}
    byCalls:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId:$ns,date_geq:$month,type_neq:"hibernation"},orderBy:[sum_requests_DESC]){sum{requests} dimensions{name objectId}}
    byHttp:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId:$ns,date_geq:$month,type:"http"},orderBy:[sum_requests_DESC]){sum{requests} dimensions{name objectId}}
    doMonth:durableObjectsPeriodicGroups(limit:1,filter:{namespaceId_in:$nss,date_geq:$month}){sum{duration inboundWebsocketMsgCount rowsRead rowsWritten}}
    callsMonth:durableObjectsInvocationsAdaptiveGroups(limit:50,filter:{namespaceId_in:$nss,date_geq:$month}){sum{requests} dimensions{hibernation:type}}
    workersMonth:workersInvocationsAdaptive(limit:1,filter:{scriptName_in:$scripts,date_geq:$month}){sum{requests cpuTimeUs}}
    workersAll:workersInvocationsAdaptive(limit:1,filter:{date_geq:$month,scriptName_neq:$push}){sum{requests cpuTimeUs}}
    doAll:durableObjectsPeriodicGroups(limit:1,filter:{date_geq:$month}){sum{duration inboundWebsocketMsgCount rowsRead rowsWritten}}
    callsAll:durableObjectsInvocationsAdaptiveGroups(limit:50,filter:{date_geq:$month}){sum{requests} dimensions{hibernation:type}}
    aeMonth:workersAnalyticsEngineAdaptiveGroups(limit:1,filter:{date_geq:$month}){count}
    aeDay:workersAnalyticsEngineAdaptiveGroups(limit:1,filter:{date:$day}){count}
    sql:durableObjectsSqlStorageGroups(limit:200,filter:{datetime_geq:$store},orderBy:[datetime_DESC]){max{storedBytes} dimensions{namespaceId datetime}}
    r2:r2StorageAdaptiveGroups(limit:200,filter:{datetime_geq:$store},orderBy:[datetime_DESC]){max{payloadSize metadataSize objectCount} dimensions{bucketName datetime}}
    r2ops:r2OperationsAdaptiveGroups(limit:1000,filter:{date_geq:$month}){sum{requests} dimensions{bucketName actionType}}
    workersDay:workersInvocationsAdaptive(limit:1,filter:{date:$day,scriptName_neq:$push}){sum{requests}}
    doDay:durableObjectsPeriodicGroups(limit:1,filter:{date:$day}){sum{duration inboundWebsocketMsgCount rowsRead rowsWritten}}
    callsDay:durableObjectsInvocationsAdaptiveGroups(limit:50,filter:{date:$day}){sum{requests} dimensions{hibernation:type}}
    awake:durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{namespaceId:$ns,datetime_geq:$recent}){dimensions{name}}
    sockets:durableObjectsPeriodicGroups(limit:10000,filter:{namespaceId:$ns,datetime_geq:$recent}){max{activeWebsocketConnections} dimensions{name}}
    errors:workersInvocationsAdaptive(limit:20,filter:{scriptName:$service,datetime_geq:$spike}){sum{requests errors}}
  }}}`;

// Incoming WebSocket messages of hibernatable sockets are `hibernation` invocations (measured: inboundWebsocketMsgCount stays 0
// for them; auto-answered pings appear in neither).
const doUsage = (s) => ({ gbSec: s?.duration ?? 0, wsIn: s?.inboundWebsocketMsgCount ?? 0, rowsRead: s?.rowsRead ?? 0, rowsWritten: s?.rowsWritten ?? 0 });
// A period's Durable Object totals from its invocations (grouped by type) and periodic sums.
const doTotals = (calls, periodic) => {
  const ws = sum(calls.filter((r) => r.dimensions.hibernation === 'hibernation'), (r) => r.sum.requests);
  const { gbSec, wsIn, rowsRead, rowsWritten } = doUsage(periodic);
  return { doRequests: doRequests({ calls: sum(calls, (r) => r.sum.requests) - ws, wsIn: ws + wsIn }), doGbSec: gbSec, rowsRead, rowsWritten };
};
const r2Class = (action) => (/^(Delete|Abort)/.test(action) ? '' : /^(Get|Head)/.test(action) ? 'r2ClassB' : 'r2ClassA');

async function usage(env, now) {
  if (!env.ACCOUNT_NS || !env.NAMESPACES) throw new Error('ACCOUNT_NS / NAMESPACES unset'); // GraphQL ignores a null filter
  const month = iso(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)).slice(0, 10);
  const v = (await gql(env, USAGE, { ns: env.ACCOUNT_NS, nss: list(env.NAMESPACES), scripts: list(env.SCRIPTS), month, day: iso(now).slice(0, 10),
    recent: iso(now - 5 * MIN), spike: iso(now - 15 * MIN), store: iso(now - 2880 * MIN), service: env.SERVICE_SCRIPT,
    push: env.PUSH_SCRIPT ?? '' })).accounts[0];
  // Each account object (its idFromName name is the account id): the union of the three top-100 lists.
  const objects = new Map();
  const at = (d) => objects.get(d.objectId) ?? objects.set(d.objectId, { name: d.name, objectId: d.objectId }).get(d.objectId);
  for (const r of v.byTime) Object.assign(at(r.dimensions), doUsage(r.sum));
  for (const r of v.byWs) { const a = at(r.dimensions); a.wsIn = (a.wsIn ?? 0) + r.sum.requests; }
  for (const r of v.byCalls) at(r.dimensions).calls = r.sum.requests;
  for (const r of v.byHttp) at(r.dimensions).http = r.sum.requests; // only these have a Worker request in front
  // The cap leaves out calls: refused upgrades with a guessed account id are cheap to send and priced as requests. The
  // duration and rows such a refusal adds are about a thousand times below its request price.
  const accounts = [...objects.values()].map((a) => ({ ...a, cost: accountCost(a), capCost: accountCost({ ...a, http: 0, calls: 0 }) }))
    .sort((x, y) => y.cost - x.cost);

  const latest = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()]; // rows are newest first: keep the first
  const sqlRows = latest([...v.sql].reverse(), (r) => r.dimensions.namespaceId);
  const [sqlBytes, allSql] = [sqlRows.filter((r) => list(env.NAMESPACES).includes(r.dimensions.namespaceId)), sqlRows].map((rows) => sum(rows, (r) => r.max.storedBytes));
  const buckets = latest([...v.r2].reverse(), (r) => r.dimensions.bucketName);
  const r2Bytes = (rows) => sum(rows, (r) => r.max.payloadSize + r.max.metadataSize);
  const ops = (rows) => rows.reduce((o, r) => { const c = r2Class(r.dimensions.actionType); if (c) o[c] += r.sum.requests; return o; }, { r2ClassA: 0, r2ClassB: 0 });
  const mine = (rows) => rows.filter((r) => r.dimensions.bucketName === env.BUCKET);
  const elapsed = (now - Date.parse(month)) / (nextMonth(new Date(now)) - Date.parse(month));
  // Month to date: the service's own Workers and objects (usage at list price) and the whole Cloudflare account (the bill).
  // The push relay, reached only through a service binding, has no invocation rows: its CPU (≈1–2 ms an alert) is not counted.
  const month_ = (workers, periodic, calls) => ({ workerRequests: workers?.sum.requests ?? 0, workerCpuMs: (workers?.sum.cpuTimeUs ?? 0) / 1000,
    ...doTotals(calls, periodic) });
  const totals = { ...month_(v.workersMonth[0], v.doMonth[0]?.sum, v.callsMonth), sqlGbMonths: (sqlBytes / 1e9) * elapsed,
    r2GbMonths: (r2Bytes(mine(buckets)) / 1e9) * elapsed, ...ops(mine(v.r2ops)) };
  const account = { ...month_(v.workersAll[0], v.doAll[0]?.sum, v.callsAll), sqlGbMonths: (allSql / 1e9) * elapsed,
    r2GbMonths: (r2Bytes(buckets) / 1e9) * elapsed, ...ops(v.r2ops), aePoints: v.aeMonth[0]?.count ?? 0 };
  const scale = projected(1, new Date(now)); // project the usage, then price it: included amounts make the bill non-linear
  const ahead = (t) => serviceCost(Object.fromEntries(Object.entries(t).map(([k, x]) => [k, x * scale])));
  const cost = { ...serviceCost(totals), bill: serviceCost(account).bill, projectedUsage: ahead(totals).usage, projectedBill: ahead(account).bill };
  // [used, limit] per quota of the plan, account-wide as Cloudflare counts them; Free mostly per day.
  const plan = env.PLAN === 'paid' ? 'paid' : 'free';
  const today = { workerRequests: v.workersDay[0]?.sum.requests ?? 0, ...doTotals(v.callsDay, v.doDay[0]?.sum), aePoints: v.aeDay[0]?.count ?? 0 };
  const used = { ...account, ...(plan === 'free' ? today : {}), sqlBytes: allSql, r2Bytes: r2Bytes(buckets) };
  const quotas = Object.fromEntries(Object.entries(PLANS[plan]).map(([k, limit]) => [k, [used[k] ?? 0, limit]]));
  const names = (rows) => new Set(rows.map((r) => r.dimensions.name).filter((n) => n !== env.PROBE_ACCOUNT));
  // Analytics cannot tell an App's socket from a Bridge's: accounts with any activity, and all open sockets.
  const online = { awake: names(v.awake).size,
    sockets: sum(v.sockets.filter((r) => r.dimensions.name !== env.PROBE_ACCOUNT), (r) => r.max.activeWebsocketConnections) };
  const errors = { requests: sum(v.errors, (r) => r.sum.requests), errors: sum(v.errors, (r) => r.sum.errors) };
  return { accounts, totals, cost, plan, quotas, online, errors, storage: { sqlBytes, r2Bytes: r2Bytes(mine(buckets)), r2Objects: sum(mine(buckets), (r) => r.max.objectCount) } };
}

// ---- Dashboard figures that are not snapshots (cached a minute) ----

const LIVE = `query($a:string!,$z:string!,$day:Time!,$service:string!,$push:string!,$nss:[string!],$hosts:[string!]){viewer{
  accounts(filter:{accountTag:$a}){
    service:workersInvocationsAdaptive(limit:50,filter:{scriptName:$service,datetime_geq:$day}){sum{requests errors} dimensions{status}}
    # A service-bound relay has no invocation rows, only its subrequests: one per APNs attempt.
    push:workersSubrequestsAdaptiveGroups(limit:20,filter:{scriptName:$push,datetime_geq:$day,hostname_in:["api.push.apple.com","api.sandbox.push.apple.com"]}){sum{subrequests} dimensions{httpResponseStatus}}
    objects:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId_in:$nss,datetime_geq:$day}){sum{requests errors} dimensions{type status}}
    cpu:durableObjectsPeriodicGroups(limit:1,filter:{namespaceId_in:$nss,datetime_geq:$day}){sum{exceededCpuErrors exceededMemoryErrors}}
  }
  zones(filter:{zoneTag:$z}){
    countries:httpRequestsAdaptiveGroups(limit:15,filter:{datetime_geq:$day,clientRequestHTTPHost_in:$hosts},orderBy:[count_DESC]){count dimensions{clientCountryName}}
    devices:httpRequestsAdaptiveGroups(limit:10,filter:{datetime_geq:$day,clientRequestHTTPHost_in:$hosts},orderBy:[count_DESC]){count dimensions{clientDeviceType}}
    status:httpRequestsAdaptiveGroups(limit:20,filter:{datetime_geq:$day,clientRequestHTTPHost_in:$hosts},orderBy:[count_DESC]){count dimensions{edgeResponseStatus}}
  }}}`;

async function users(env, skip) {
  const from = (days) => `FROM ${env.DATASET} WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob2 NOT IN (${skip})`;
  const day = iso(Date.now()).slice(0, 10);
  const relayed = (days, when) => `SELECT blob4 AS role, count(DISTINCT blob2) AS n ${from(days)} AND blob1 = 'relay' AND ${when} GROUP BY role`;
  const [daily, wau, mau, dist, time, bridges, conns, relayDay, relayMonth, devices] = await Promise.all([
    `SELECT blob3 AS day, count(DISTINCT blob2) AS dau, sum(if(blob7 = 'new', 1, 0)) AS new ${from(30)} AND blob1 = 'active' GROUP BY day ORDER BY day`,
    `SELECT count(DISTINCT blob2) AS n ${from(7)} AND blob1 = 'active'`,
    `SELECT count(DISTINCT blob2) AS n ${from(30)} AND blob1 = 'active'`,
    `SELECT blob4 AS platform, blob5 AS country, blob6 AS network, sum(_sample_interval) AS n ${from(30)} AND blob1 = 'active' GROUP BY platform, country, network`,
    `SELECT blob3 AS day, sum(_sample_interval * double4 * double1) AS secs ${from(8)} AND blob1 = 'conn' AND blob4 = 'app' GROUP BY day`,
    `SELECT blob7 AS version, blob4 AS os, count(DISTINCT blob2) AS n ${from(1)} AND blob1 = 'bridge' GROUP BY version, os`,
    `SELECT blob1 AS kind, blob4 AS role, double3 AS code, sum(_sample_interval * double4) AS n, sum(_sample_interval * double4 * double1) AS secs ${from(1)} AND blob1 IN ('conn', 'reject') GROUP BY kind, role, code`,
    relayed(1, `blob3 = '${day}'`), relayed(31, `blob3 >= '${day.slice(0, 8)}01'`), // accounts through the mainland-China relay
    `SELECT blob1 AS role, sum(_sample_interval) AS n ${from(1)} AND blob1 IN ('app', 'bridge') AND blob3 = '${day}' GROUP BY role`, // one a day each
  ].map((sql) => ae(env, sql)));
  const roles = (rows) => Object.fromEntries(rows.map((r) => [r.role, Number(r.n)]));
  const by = (key) => Object.entries(dist.reduce((o, r) => ({ ...o, [r[key] || '?']: (o[r[key] || '?'] ?? 0) + Number(r.n) }), {}))
    .sort((a, b) => b[1] - a[1]);
  // App seconds of the finished days (sampled closes) over their active accounts.
  const first = iso(Date.now() - 7 * 1440 * MIN).slice(0, 10); // the 8-day window's oldest day is partial
  const days = time.filter((r) => r.day !== day && r.day >= first), active = sum(daily.filter((r) => days.some((d) => d.day === r.day)), (r) => Number(r.dau));
  return { daily, dau: Number(daily.at(-1)?.dau ?? 0), wau: Number(wau[0]?.n ?? 0), mau: Number(mau[0]?.n ?? 0),
    platforms: by('platform'), countries: by('country'), networks: by('network'),
    avgDailySecs: active ? sum(days, (r) => Number(r.secs)) / active : null, todaySecs: Number(time.find((r) => r.day === day)?.secs ?? 0), bridges, conns,
    relay: { day: roles(relayDay), month: roles(relayMonth) }, devices: roles(devices) };
}

async function live(env, skip) {
  const day = iso(Date.now() - 1440 * MIN);
  const [v, u] = await Promise.all([
    gql(env, LIVE, { z: env.ZONE_ID, day, service: env.SERVICE_SCRIPT, push: env.PUSH_SCRIPT, nss: list(env.NAMESPACES), hosts: list(env.HOSTS) }),
    env.DATASET ? users(env, skip).catch((error) => ({ error: error.message })) : { error: 'no usage dataset' }]);
  const zone = v.zones[0];
  return { users: u, service: v.accounts[0].service, push: v.accounts[0].push, objects: v.accounts[0].objects, cpu: v.accounts[0].cpu[0]?.sum ?? {},
    countries: zone.countries.map((r) => [r.dimensions.clientCountryName, r.count]), devices: zone.devices.map((r) => [r.dimensions.clientDeviceType, r.count]),
    status: zone.status.map((r) => [r.dimensions.edgeResponseStatus, r.count]) };
}

async function mail(env, subject, text) {
  if (!env.EMAIL) return 'no email binding';
  const raw = [`From: Baton monitor <${env.FROM_EMAIL}>`, `To: ${env.ADMIN_EMAIL}`, `Subject: [Baton] ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${env.FROM_EMAIL.split('@')[1]}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
    `${text}\n\n${env.MONITOR_URL ?? ''}`].join('\r\n');
  try {
    await env.EMAIL.send(new EmailMessage(env.FROM_EMAIL, env.ADMIN_EMAIL, raw));
    return 'sent';
  } catch (error) {
    return `failed: ${error.message}`;
  }
}

// Snapshots (35 days), alert state, blocked accounts and the alert log; one object (idFromName('monitor')).
export class MonitorStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS snaps (t INTEGER PRIMARY KEY, ok INTEGER, online INTEGER, data TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, role TEXT, first INTEGER)'); // every App and computer seen
    try { this.sql.exec('ALTER TABLE devices ADD COLUMN acct TEXT'); } catch {} // its account's hash: a purge removes only those
  }

  // Each keyed alert once; one email per run lists them all.
  alert(state, key, subject, text) {
    if (key && state.sent[key]) return;
    if (key) state.sent[key] = Date.now();
    (this.pending ??= []).push([subject, text]);
  }

  async run() {
    const now = Date.now();
    const env = this.env;
    const [probes, used] = await Promise.all([probe(env), usage(env, now).catch((error) => ({ error: error.message }))]);
    const state = (await this.ctx.storage.get('state')) ?? { fails: {}, sent: {}, blocked: {} };
    for (const [key, t] of Object.entries(state.sent)) if (now - t > 40 * 1440 * MIN) delete state.sent[key];
    const month = iso(now).slice(0, 7);
    // Probes: an alert after two failures in a row, and one when it answers again.
    for (const [i, p] of probes.entries()) {
      const name = PROBES[i];
      const fails = p.ok ? 0 : (state.fails[name] ?? 0) + 1;
      if (fails === 2) this.alert(state, null, `${name} probe failing`, `Two failed probes in a row: ${p.error}`);
      if (p.ok && (state.fails[name] ?? 0) >= 2) this.alert(state, null, `${name} probe recovered`, `Answered in ${p.ms} ms.`);
      state.fails[name] = fails;
    }
    if (used.accounts) used.accounts = used.accounts.filter((a) => !state.purged?.[a.name]);
    state.usageFails = used.error && used.error !== NO_TOKEN ? (state.usageFails ?? 0) + 1 : 0;
    if (state.usageFails === 2) this.alert(state, null, 'usage collection failing', `The cost cap is not enforced while this lasts: ${used.error}`);
    if (!used.error) {
      // The cost cap: an account object over COST_CAP this month is blocked until the 1st of next month (UTC).
      const cap = Number(env.COST_CAP || 1);
      for (const [name, b] of Object.entries(state.blocked)) if (b.until <= now) delete state.blocked[name];
      for (const a of used.accounts.filter((x) => x.capCost > cap && x.name !== env.PROBE_ACCOUNT && !state.blocked[x.name] && state.lifted?.[x.name] !== month)) {
        const until = nextMonth(new Date(now));
        try {
          await env.ACCOUNT.get(env.ACCOUNT.idFromString(a.objectId)).monthlyLimit(until);
          state.blocked[a.name] = { until, cost: a.capCost, at: now, objectId: a.objectId };
          this.alert(state, `blocked:${a.name}:${month}`, `account ${a.name} blocked`,
            `Month-to-date cost $${a.capCost.toFixed(2)} is over the $${cap} cap; blocked until ${iso(until)}.`);
        } catch (error) {
          console.log(`block ${a.name} failed: ${error.message}`);
        }
      }
      const { requests, errors } = used.errors;
      if (requests >= 100 && errors / requests > 0.05) {
        this.alert(state, `errors:${iso(now).slice(0, 13)}`, 'error rate spike', `${errors} of ${requests} requests failed in the last 15 minutes.`);
      }
      for (const [name, share] of Object.entries(used.quotas).map(([k, [u, limit]]) => [k, u / limit])) {
        if (share > 0.8) this.alert(state, `quota:${name}:${used.plan === 'paid' || MONTHLY_ON_FREE.has(name) ? month : iso(now).slice(0, 10)}`,
          `${used.plan === 'paid' ? 'Included usage' : 'Free quota'} ${name} at ${Math.round(share * 100)}%`,
          `${name} is at ${Math.round(share * 100)}% of the ${used.plan === 'paid' ? 'Workers Paid included usage' : 'Free plan quota'}.`);
      }
      if (used.cost.usage > Number(env.COST_ALERT || 20)) {
        this.alert(state, `cost:${month}`, 'monthly cost alert', `Month-to-date usage $${used.cost.usage.toFixed(2)} is over $${env.COST_ALERT}.`);
      }
    }
    // Relays (their 5-minute reports): silent for 20 minutes and back, two thirds of the monthly cap, the cap reached.
    state.relayStale ??= {};
    for (const [key, r] of await this.ctx.storage.list({ prefix: 'relay:' })) {
      const name = key.slice(6), stale = now - r.t > 20 * MIN;
      if (now - r.t > 7 * 1440 * MIN) { await this.ctx.storage.delete(key); delete state.relayStale[name]; continue; } // retired
      if (stale !== !!state.relayStale[name]) {
        this.alert(state, null, `relay ${name} ${stale ? 'not reporting' : 'reporting again'}`, stale
          ? `No report since ${iso(r.t)}: it may be down; mainland clients then use the API host directly (accounts placed in Tokyo slow down).`
          : 'Its reports arrive again.');
        if (stale) state.relayStale[name] = true; else delete state.relayStale[name];
      }
      const tb = (b) => `${(b / 1e12).toFixed(2)} TB`;
      if (r.month === month && r.monthBytes > (r.cap * 2) / 3) this.alert(state, `relay-use:${name}:${month}`, `relay ${name} at ${tb(r.monthBytes)} this month`,
        `${tb(r.monthBytes)} of its ${tb(r.cap)} monthly cap (both directions, as Lightsail counts its allowance). Add a relay before it stops.`);
      if (r.month === month && r.stopped) this.alert(state, `relay-stop:${name}:${month}`, `relay ${name} stopped at its monthly cap`,
        `It relays again next month; meanwhile mainland clients use the API host directly.`);
    }
    // Devices seen since the last run (overlapping; up to AE's 90 days the first time) join the all-time list.
    if (env.DATASET && env.ANALYTICS_TOKEN) {
      const minutes = Math.min(90 * 1440, Math.ceil((now - (state.devicesAt ?? 0)) / MIN) + 15);
      try {
        for (const r of await ae(env, `SELECT blob8 AS id, blob1 AS role, blob2 AS acct FROM ${env.DATASET} WHERE timestamp > NOW() - INTERVAL '${minutes}' MINUTE`
          + ` AND blob1 IN ('app', 'bridge') AND blob8 != '' AND blob2 NOT IN (${skipped(env, state)}) GROUP BY id, role, acct`)) {
          this.sql.exec('INSERT OR IGNORE INTO devices VALUES (?, ?, ?, ?)', r.id, r.role, now, r.acct);
        }
        state.devicesAt = now;
      } catch (error) { console.log(`devices: ${error.message}`); }
    }
    // New alerts are logged once; an email that could not be sent is retried with the next run's (at most 20 kept).
    const fresh = this.pending ?? [];
    this.pending = null;
    const alerts = [...(state.unsent ?? []), ...fresh];
    if (alerts.length) {
      const subject = alerts.length > 1 ? `${alerts[0][0]} (+${alerts.length - 1} more)` : alerts[0][0];
      const result = await mail(env, subject, alerts.map(([s, t]) => `${s}\n${t}`).join('\n\n'));
      state.log = [...fresh.map(([s]) => ({ t: now, subject: s, result })), ...(state.log ?? [])].slice(0, 30);
      state.unsent = result === 'sent' ? [] : alerts.slice(-20);
    }
    // An unblock or a purge may have landed during the awaits above: keep it, and drop the purged accounts' devices
    // this run may have added.
    const saved = await this.ctx.storage.get('state');
    state.lifted = saved?.lifted ?? state.lifted;
    if (JSON.stringify(saved?.purged ?? {}) !== JSON.stringify(state.purged ?? {})) {
      state.purged = saved.purged;
      for (const [name, p] of Object.entries(state.purged)) {
        delete state.blocked?.[name];
        this.sql.exec('DELETE FROM devices WHERE acct = ?', p.hash);
      }
    }
    for (const [name, m] of Object.entries(state.lifted ?? {})) if (m === month) delete state.blocked[name];
    const relays = new Set([...(await this.ctx.storage.list({ prefix: 'relay:' })).keys()].map((k) => k.slice(6))); // a retire meanwhile
    for (const name of Object.keys(state.relayStale ?? {})) if (!relays.has(name)) delete state.relayStale[name];
    await this.ctx.storage.put('state', state);
    const ok = probes.reduce((bits, p, i) => bits | (p.ok ? 1 << i : 0), 0);
    this.sql.exec('INSERT OR REPLACE INTO snaps VALUES (?, ?, ?, ?)', now, ok, used.online?.awake ?? null, JSON.stringify({ probes, ...used, accounts: used.accounts?.slice(0, 10) }));
    this.sql.exec('DELETE FROM snaps WHERE t < ?', now - 35 * 1440 * MIN);
  }

  // The operator's unblock (dashboard): lifts the object's block and exempts it for the rest of the month.
  async unblock(name) {
    const state = (await this.ctx.storage.get('state')) ?? {};
    const b = state.blocked?.[name];
    if (!b?.objectId) return false;
    await this.env.ACCOUNT.get(this.env.ACCOUNT.idFromString(b.objectId)).monthlyLimit(0);
    delete state.blocked[name];
    state.lifted = { ...state.lifted, [name]: iso(Date.now()).slice(0, 7) };
    await this.ctx.storage.put('state', state);
    this.cached = null;
    return true;
  }

  // The operator's purge of a test account (dashboard): its object is emptied, its devices leave the list, and its
  // points leave every figure. Other accounts' devices are untouched.
  async purge(name) {
    if (!/^[0-9a-f]{16}$/.test(name) || name === this.env.PROBE_ACCOUNT) return false;
    await this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(name)).purge(name);
    const hash = await hashOf(name); // before reading state: no await between its read and write
    const state = (await this.ctx.storage.get('state')) ?? {};
    state.purged = { ...state.purged, [name]: { hash, at: Date.now() } };
    delete state.blocked?.[name]; // unblocking it later would write into the emptied object
    delete state.lifted?.[name];
    await this.ctx.storage.put('state', state);
    this.sql.exec('DELETE FROM devices WHERE acct = ?', hash);
    this.cached = null;
    this.purges = (this.purges ?? 0) + 1; // a data() read in flight meanwhile is not cached
    return true;
  }

  // A relay's 5-minute report (checked by the Worker).
  async report(r) {
    await this.ctx.storage.put(`relay:${r.name}`, { ...r, t: Date.now() });
  }

  // A relay taken down for good (`{name, retire: true}`): its record and alert state go.
  async retire(name) {
    await this.ctx.storage.delete(`relay:${name}`);
    const state = await this.ctx.storage.get('state');
    if (state?.relayStale?.[name]) { delete state.relayStale[name]; await this.ctx.storage.put('state', state); }
    this.cached = null;
  }

  async data() {
    if (this.cached?.until > Date.now()) return this.cached.value;
    const now = Date.now(), purges = this.purges;
    const midnight = Date.parse(iso(now).slice(0, 10));
    const [latest] = this.sql.exec('SELECT t, data FROM snaps ORDER BY t DESC LIMIT 1').toArray();
    const series = this.sql.exec('SELECT t, ok, online, data FROM snaps WHERE t > ? ORDER BY t', now - 1440 * MIN).toArray().map((r) => {
      const d = JSON.parse(r.data);
      return [r.t, r.ok, r.online, ...(d.probes ?? []).map((p) => p.ms), d.cost?.usage ?? null, d.errors?.errors ?? null];
    });
    const uptime = (from) => this.sql.exec('SELECT count(*) AS n, sum(ok & 1) AS v, sum((ok >> 1) & 1) AS r, sum((ok >> 2) & 1) AS w FROM snaps WHERE t >= ?', from).one();
    const state = (await this.ctx.storage.get('state')) ?? {};
    const last = latest && { t: latest.t, ...JSON.parse(latest.data) };
    if (last?.accounts) last.accounts = last.accounts.filter((a) => !state.purged?.[a.name]); // a snapshot taken before a purge
    const value = { now, latest: last, series, probe: this.env.PROBE_ACCOUNT, uptime: { today: uptime(midnight), week: uptime(now - 7 * 1440 * MIN) },
      blocked: state.blocked ?? {}, alerts: state.log ?? [], cap: Number(this.env.COST_CAP || 1),
      relays: Object.fromEntries([...(await this.ctx.storage.list({ prefix: 'relay:' }))].map(([k, r]) => [k.slice(6), r])),
      devices: Object.fromEntries(this.sql.exec('SELECT role, count(*) AS n FROM devices GROUP BY role').toArray().map((r) => [r.role, r.n])),
      live: await live(this.env, skipped(this.env, state)).catch((error) => ({ error: error.message })) };
    if (purges === this.purges) this.cached = { until: now + MIN, value };
    return value;
  }
}

// ---- Access: every request must carry a valid Cloudflare Access token for this application ----

const b64url = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
let certs;
async function accessOk(request, env) {
  const jwt = request.headers.get('cf-access-jwt-assertion') ?? '';
  const [head, body, sig] = jwt.split('.');
  if (!sig || !env.ACCESS_AUD || !env.ACCESS_TEAM) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(head)));
    const claims = JSON.parse(new TextDecoder().decode(b64url(body)));
    if (![claims.aud].flat().includes(env.ACCESS_AUD) || claims.iss !== `https://${env.ACCESS_TEAM}` || claims.exp * 1000 < Date.now()) return false;
    certs ??= fetch(`https://${env.ACCESS_TEAM}/cdn-cgi/access/certs`).then((r) => r.json());
    const jwk = (await certs).keys?.find((k) => k.kid === header.kid);
    if (!jwk) { certs = null; return false; }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(sig), new TextEncoder().encode(`${head}.${body}`));
  } catch {
    certs = null;
    return false;
  }
}

const store = (env) => env.STORE.get(env.STORE.idFromName('monitor'));

// The relays' reports arrive on REPORT_HOST, outside Access, with the shared key RELAY_REPORT_KEY; nothing else is served there.
const digest = async (text) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
const REPORT = { name: /^[\w.-]{1,64}$/, day: /^\d{4}-\d{2}-\d{2}$/, month: /^\d{4}-\d{2}$/ };
async function report(request, env) {
  if (new URL(request.url).pathname !== '/relay/report' || request.method !== 'POST' || !env.RELAY_REPORT_KEY) return new Response('Not Found', { status: 404 });
  const key = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!crypto.subtle.timingSafeEqual(await digest(key), await digest(env.RELAY_REPORT_KEY))) return new Response('Forbidden', { status: 403 });
  const text = await request.text();
  let r;
  try { r = JSON.parse(text.length <= 1024 ? text : 'null'); } catch {}
  if (r?.retire === true && REPORT.name.test(String(r.name))) return (await store(env).retire(r.name), new Response(null, { status: 204 }));
  const counts = ['dayBytes', 'monthBytes', 'cap', 'addrs'];
  if (!r || Object.entries(REPORT).some(([k, re]) => !re.test(String(r[k]))) || counts.some((k) => !(Number.isFinite(r[k]) && r[k] >= 0))
    || typeof r.stopped !== 'boolean') return new Response('Bad Request', { status: 400 });
  await store(env).report({ name: r.name, day: r.day, month: r.month, stopped: r.stopped, ...Object.fromEntries(counts.map((k) => [k, r[k]])) });
  return new Response(null, { status: 204 });
}
const HEADERS = { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };

export default {
  async fetch(request, env) {
    if (env.REPORT_HOST && new URL(request.url).host === env.REPORT_HOST) return report(request, env);
    if (!(await accessOk(request, env))) return new Response('Forbidden', { status: 403 });
    const { pathname } = new URL(request.url);
    if (pathname === '/') return new Response(page, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/api/data') return Response.json(await store(env).data(), { headers: HEADERS });
    // JSON only: a cross-site form cannot send it without a preflight, which this Worker never answers.
    if (pathname === '/api/unblock' && request.method === 'POST' && request.headers.get('content-type') === 'application/json') {
      return Response.json({ ok: await store(env).unblock(String((await request.json()).account ?? '')) }, { headers: HEADERS });
    }
    if (pathname === '/api/purge' && request.method === 'POST' && request.headers.get('content-type') === 'application/json') {
      return Response.json({ ok: await store(env).purge(String((await request.json()).account ?? '')) }, { headers: HEADERS });
    }
    return new Response('Not Found', { status: 404 });
  },
  async scheduled(_, env, ctx) {
    ctx.waitUntil(store(env).run());
  },
};
