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

async function cfApi(env, path, body, type = 'application/json') {
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

const USAGE = `query($a:string!,$ns:string!,$nss:[string!],$scripts:[string!],$month:Date!,$day:Date!,$alarm:Time!,$recent:Time!,$spike:Time!,$store:Time!,$service:string!,$push:string!){viewer{
  accounts(filter:{accountTag:$a}){
    byTime:durableObjectsPeriodicGroups(limit:100,filter:{namespaceId:$ns,date_geq:$month},orderBy:[sum_duration_DESC]){sum{duration inboundWebsocketMsgCount rowsRead rowsWritten} dimensions{name objectId}}
    byWs:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId:$ns,date_geq:$month,type:"hibernation"},orderBy:[sum_requests_DESC]){sum{requests} dimensions{name objectId}}
    byCalls:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId:$ns,date_geq:$month,type_neq:"hibernation"},orderBy:[sum_requests_DESC]){sum{requests} dimensions{name objectId}}
    byHttp:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId:$ns,date_geq:$month,type:"http"},orderBy:[sum_requests_DESC]){sum{requests} dimensions{name objectId}}
    doMonth:durableObjectsPeriodicGroups(limit:1,filter:{namespaceId_in:$nss,date_geq:$month}){sum{duration inboundWebsocketMsgCount rowsRead rowsWritten}}
    callsMonth:durableObjectsInvocationsAdaptiveGroups(limit:50,filter:{namespaceId_in:$nss,date_geq:$month}){sum{requests} dimensions{hibernation:type}}
    workersMonth:workersInvocationsAdaptive(limit:1,filter:{scriptName_in:$scripts,date_geq:$month}){sum{requests cpuTimeUs}}
    pushMonth:workersInvocationsAdaptive(limit:1,filter:{date_geq:$month,scriptName:$push}){sum{requests cpuTimeUs}}
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
    alarms:durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{namespaceId:$ns,datetime_geq:$alarm,type:"alarm"}){dimensions{name}}
    awake:durableObjectsInvocationsAdaptiveGroups(limit:10000,filter:{namespaceId:$ns,datetime_geq:$recent}){dimensions{name}}
    sockets:durableObjectsPeriodicGroups(limit:10000,filter:{namespaceId:$ns,datetime_geq:$recent}){max{activeWebsocketConnections} dimensions{name}}
    errors:workersInvocationsAdaptive(limit:20,filter:{scriptName:$service,datetime_geq:$spike}){sum{requests errors}}
  }}}`;

// Incoming WebSocket messages of hibernatable sockets are `hibernation` invocations (measured: inboundWebsocketMsgCount stays 0
// for them; auto-answered pings appear in neither).
const doUsage = (s) => ({ gbSec: s?.duration ?? 0, wsIn: s?.inboundWebsocketMsgCount ?? 0, rowsRead: s?.rowsRead ?? 0, rowsWritten: s?.rowsWritten ?? 0 });
const split = (rows, periodic) => ({ calls: sum(rows.filter((r) => r.dimensions.hibernation !== 'hibernation'), (r) => r.sum.requests),
  wsIn: sum(rows.filter((r) => r.dimensions.hibernation === 'hibernation'), (r) => r.sum.requests) + (periodic?.inboundWebsocketMsgCount ?? 0) });
const r2Class = (action) => (/^(Delete|Abort)/.test(action) ? '' : /^(Get|Head)/.test(action) ? 'r2ClassB' : 'r2ClassA');

async function usage(env, now) {
  if (!env.ACCOUNT_NS || !env.NAMESPACES) throw new Error('ACCOUNT_NS / NAMESPACES unset'); // GraphQL ignores a null filter
  const month = iso(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)).slice(0, 10);
  const v = (await gql(env, USAGE, { ns: env.ACCOUNT_NS, nss: list(env.NAMESPACES), scripts: list(env.SCRIPTS), month, day: iso(now).slice(0, 10),
    alarm: iso(now - 3 * MIN), recent: iso(now - 5 * MIN), spike: iso(now - 15 * MIN), store: iso(now - 2880 * MIN), service: env.SERVICE_SCRIPT,
    push: env.PUSH_SCRIPT ?? '' })).accounts[0];
  // Each account object (its idFromName name is the account id): the union of the three top-100 lists.
  const objects = new Map();
  const at = (d) => objects.get(d.objectId) ?? objects.set(d.objectId, { name: d.name, objectId: d.objectId }).get(d.objectId);
  for (const r of v.byTime) Object.assign(at(r.dimensions), doUsage(r.sum));
  for (const r of v.byWs) { const a = at(r.dimensions); a.wsIn = (a.wsIn ?? 0) + r.sum.requests; }
  for (const r of v.byCalls) at(r.dimensions).calls = r.sum.requests;
  for (const r of v.byHttp) at(r.dimensions).http = r.sum.requests; // only these have a Worker request in front
  // The cap counts what only an authenticated client drives (messages, duration, rows): calls alone can be junk
  // upgrades with a guessed account id, which would otherwise get any account blocked.
  const accounts = [...objects.values()].map((a) => ({ ...a, cost: accountCost(a), capCost: accountCost({ ...a, http: 0, calls: 0 }) }))
    .sort((x, y) => y.cost - x.cost);

  const latest = (rows, key) => [...new Map(rows.map((r) => [key(r), r])).values()]; // rows are newest first: keep the first
  const sqlBytes = sum(latest([...v.sql].reverse(), (r) => r.dimensions.namespaceId).filter((r) => list(env.NAMESPACES).includes(r.dimensions.namespaceId)),
    (r) => r.max.storedBytes);
  const buckets = latest([...v.r2].reverse(), (r) => r.dimensions.bucketName);
  const r2Bytes = (rows) => sum(rows, (r) => r.max.payloadSize + r.max.metadataSize);
  const ops = (rows) => rows.reduce((o, r) => { const c = r2Class(r.dimensions.actionType); if (c) o[c] += r.sum.requests; return o; }, { r2ClassA: 0, r2ClassB: 0 });
  const mine = (rows) => rows.filter((r) => r.dimensions.bucketName === env.BUCKET);
  const elapsed = (now - Date.parse(month)) / (nextMonth(new Date(now)) - Date.parse(month));
  // Month to date: the service's own Workers and objects (usage at list price) and the whole Cloudflare account (the bill;
  // the push relay is reached only through a service binding: its CPU is billed, its requests are not).
  const month_ = (workers, periodic, calls) => ({ workerRequests: workers?.sum.requests ?? 0, workerCpuMs: (workers?.sum.cpuTimeUs ?? 0) / 1000,
    doRequests: doRequests(split(calls, periodic)), ...(({ gbSec, rowsRead, rowsWritten }) => ({ doGbSec: gbSec, rowsRead, rowsWritten }))(doUsage(periodic)) });
  const allSql = sum(latest([...v.sql].reverse(), (r) => r.dimensions.namespaceId), (r) => r.max.storedBytes);
  const push = v.pushMonth[0]?.sum ?? { requests: 0, cpuTimeUs: 0 };
  const totals = { ...month_(v.workersMonth[0], v.doMonth[0]?.sum, v.callsMonth), sqlGbMonths: (sqlBytes / 1e9) * elapsed,
    r2GbMonths: (r2Bytes(mine(buckets)) / 1e9) * elapsed, ...ops(mine(v.r2ops)) };
  totals.workerRequests -= push.requests;
  const account = { ...month_(v.workersAll[0], v.doAll[0]?.sum, v.callsAll), sqlGbMonths: (allSql / 1e9) * elapsed,
    r2GbMonths: (r2Bytes(buckets) / 1e9) * elapsed, ...ops(v.r2ops), aePoints: v.aeMonth[0]?.count ?? 0 };
  account.workerCpuMs += push.cpuTimeUs / 1000;
  const scale = projected(1, new Date(now)); // project the usage, then price it: included amounts make the bill non-linear
  const ahead = (t) => serviceCost(Object.fromEntries(Object.entries(t).map(([k, x]) => [k, x * scale])));
  const cost = { ...serviceCost(totals), bill: serviceCost(account).bill, projectedUsage: ahead(totals).usage, projectedBill: ahead(account).bill };
  // [used, limit] per quota of the plan, account-wide as Cloudflare counts them; Free mostly per day.
  const plan = env.PLAN === 'paid' ? 'paid' : 'free';
  const today = { workerRequests: v.workersDay[0]?.sum.requests ?? 0, doRequests: doRequests(split(v.callsDay, v.doDay[0]?.sum)),
    ...(({ gbSec, rowsRead, rowsWritten }) => ({ doGbSec: gbSec, rowsRead, rowsWritten }))(doUsage(v.doDay[0]?.sum)), aePoints: v.aeDay[0]?.count ?? 0 };
  const used = { ...account, ...(plan === 'free' ? today : {}), sqlBytes: allSql, r2Bytes: r2Bytes(buckets) };
  const quotas = Object.fromEntries(Object.entries(PLANS[plan]).map(([k, limit]) => [k, [used[k] ?? 0, limit]]));
  const names = (rows) => new Set(rows.map((r) => r.dimensions.name).filter((n) => n !== env.PROBE_ACCOUNT));
  const online = { apps: names(v.alarms).size, awake: names(v.awake).size, sockets: sum(v.sockets, (r) => r.max.activeWebsocketConnections) };
  const errors = { requests: sum(v.errors, (r) => r.sum.requests), errors: sum(v.errors, (r) => r.sum.errors) };
  return { accounts, totals, cost, plan, quotas, online, errors, storage: { sqlBytes, r2Bytes: r2Bytes(mine(buckets)), r2Objects: sum(mine(buckets), (r) => r.max.objectCount) } };
}

// ---- Dashboard figures that are not snapshots (cached a minute) ----

const LIVE = `query($a:string!,$z:string!,$day:Time!,$service:string!,$push:string!,$nss:[string!],$hosts:[string!]){viewer{
  accounts(filter:{accountTag:$a}){
    service:workersInvocationsAdaptive(limit:50,filter:{scriptName:$service,datetime_geq:$day}){sum{requests errors} dimensions{status}}
    push:workersInvocationsAdaptive(limit:50,filter:{scriptName:$push,datetime_geq:$day}){sum{requests} dimensions{httpResponseStatus}}
    objects:durableObjectsInvocationsAdaptiveGroups(limit:100,filter:{namespaceId_in:$nss,datetime_geq:$day}){sum{requests errors} dimensions{type status}}
    cpu:durableObjectsPeriodicGroups(limit:1,filter:{namespaceId_in:$nss,datetime_geq:$day}){sum{exceededCpuErrors exceededMemoryErrors}}
  }
  zones(filter:{zoneTag:$z}){
    countries:httpRequestsAdaptiveGroups(limit:15,filter:{datetime_geq:$day,clientRequestHTTPHost_in:$hosts},orderBy:[count_DESC]){count dimensions{clientCountryName}}
    devices:httpRequestsAdaptiveGroups(limit:10,filter:{datetime_geq:$day,clientRequestHTTPHost_in:$hosts},orderBy:[count_DESC]){count dimensions{clientDeviceType}}
    status:httpRequestsAdaptiveGroups(limit:20,filter:{datetime_geq:$day,clientRequestHTTPHost_in:$hosts},orderBy:[count_DESC]){count dimensions{edgeResponseStatus}}
  }}}`;

async function users(env) {
  const from = (days) => `FROM ${env.DATASET} WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob2 != '${env.PROBE_HASH}'`;
  const [daily, wau, mau, dist, time, bridges, conns] = await Promise.all([
    `SELECT blob3 AS day, count(DISTINCT blob2) AS dau, sum(if(blob7 = 'new', 1, 0)) AS new ${from(30)} AND blob1 = 'active' GROUP BY day ORDER BY day`,
    `SELECT count(DISTINCT blob2) AS n ${from(7)} AND blob1 = 'active'`,
    `SELECT count(DISTINCT blob2) AS n ${from(30)} AND blob1 = 'active'`,
    `SELECT blob4 AS platform, blob5 AS country, blob6 AS network, sum(_sample_interval) AS n ${from(30)} AND blob1 = 'active' GROUP BY platform, country, network`,
    `SELECT blob2 AS account, blob3 AS day, max(double1) AS secs ${from(8)} AND blob1 = 'summary' GROUP BY account, day`,
    `SELECT blob7 AS version, blob4 AS os, count(DISTINCT blob2) AS n ${from(1)} AND blob1 = 'bridge' GROUP BY version, os`,
    `SELECT blob1 AS kind, blob4 AS role, double3 AS code, sum(_sample_interval * double4) AS n, sum(_sample_interval * double4 * double1) AS secs ${from(1)} AND blob1 IN ('conn', 'reject') GROUP BY kind, role, code`,
  ].map((sql) => ae(env, sql)));
  const by = (key) => Object.entries(dist.reduce((o, r) => ({ ...o, [r[key] || '?']: (o[r[key] || '?'] ?? 0) + Number(r.n) }), {}))
    .sort((a, b) => b[1] - a[1]);
  const days = time.filter((r) => r.day !== new Date().toISOString().slice(0, 10));
  return { daily, dau: Number(daily.at(-1)?.dau ?? 0), wau: Number(wau[0]?.n ?? 0), mau: Number(mau[0]?.n ?? 0),
    platforms: by('platform'), countries: by('country'), networks: by('network'),
    avgDailySecs: days.length ? sum(days, (r) => Number(r.secs)) / days.length : null, bridges, conns };
}

async function live(env) {
  const day = iso(Date.now() - 1440 * MIN);
  const [v, u] = await Promise.all([
    gql(env, LIVE, { z: env.ZONE_ID, day, service: env.SERVICE_SCRIPT, push: env.PUSH_SCRIPT, nss: list(env.NAMESPACES), hosts: list(env.HOSTS) }),
    env.DATASET ? users(env).catch((error) => ({ error: error.message })) : { error: 'no usage dataset' }]);
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
  }

  // Each alert once (by key); one email per run lists them all.
  alert(state, key, subject, text) {
    if (state.sent[key]) return;
    state.sent[key] = Date.now();
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
      if (fails === 2) this.alert(state, `down:${name}:${now}`, `${name} probe failing`, `Two failed probes in a row: ${p.error}`);
      if (p.ok && (state.fails[name] ?? 0) >= 2) this.alert(state, `up:${name}:${now}`, `${name} probe recovered`, `Answered in ${p.ms} ms.`);
      state.fails[name] = fails;
    }
    state.usageFails = used.error ? (state.usageFails ?? 0) + 1 : 0;
    if (state.usageFails === 2) this.alert(state, `usage:${now}`, 'usage collection failing', `The cost cap is not enforced while this lasts: ${used.error}`);
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
    const alerts = this.pending ?? [];
    this.pending = null;
    if (alerts.length) {
      const subject = alerts.length > 1 ? `${alerts[0][0]} (+${alerts.length - 1} more)` : alerts[0][0];
      const result = await mail(env, subject, alerts.map(([s, t]) => `${s}\n${t}`).join('\n\n'));
      state.log = [...alerts.map(([s]) => ({ t: now, subject: s, result })), ...(state.log ?? [])].slice(0, 30);
    }
    // An unblock may have landed during the awaits above: keep it.
    state.lifted = (await this.ctx.storage.get('state'))?.lifted ?? state.lifted;
    for (const [name, m] of Object.entries(state.lifted ?? {})) if (m === month) delete state.blocked[name];
    await this.ctx.storage.put('state', state);
    const ok = probes.reduce((bits, p, i) => bits | (p.ok ? 1 << i : 0), 0);
    this.sql.exec('INSERT OR REPLACE INTO snaps VALUES (?, ?, ?, ?)', now, ok, used.online?.apps ?? null, JSON.stringify({ probes, ...used, accounts: used.accounts?.slice(0, 10) }));
    this.sql.exec('DELETE FROM snaps WHERE t < ?', now - 35 * 1440 * MIN);
    return { probes, error: used.error };
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

  async data() {
    if (this.cached?.until > Date.now()) return this.cached.value;
    const now = Date.now();
    const midnight = Date.parse(iso(now).slice(0, 10));
    const [latest] = this.sql.exec('SELECT t, data FROM snaps ORDER BY t DESC LIMIT 1').toArray();
    const series = this.sql.exec('SELECT t, ok, online, data FROM snaps WHERE t > ? ORDER BY t', now - 1440 * MIN).toArray().map((r) => {
      const d = JSON.parse(r.data);
      return [r.t, r.ok, r.online, ...(d.probes ?? []).map((p) => p.ms), d.cost?.usage ?? null, d.errors?.errors ?? null];
    });
    const uptime = (from) => this.sql.exec('SELECT count(*) AS n, sum(ok & 1) AS v, sum((ok >> 1) & 1) AS r, sum((ok >> 2) & 1) AS w FROM snaps WHERE t >= ?', from).one();
    // Use time so far today: online accounts integrated over the 5-minute snapshots.
    const [today] = this.sql.exec('SELECT sum(online) * 300 AS secs FROM snaps WHERE t >= ?', midnight).toArray();
    const state = (await this.ctx.storage.get('state')) ?? {};
    const value = { now, latest: latest && { t: latest.t, ...JSON.parse(latest.data) }, series, uptime: { today: uptime(midnight), week: uptime(now - 7 * 1440 * MIN) }, useToday: today?.secs ?? 0,
      blocked: state.blocked ?? {}, alerts: state.log ?? [], cap: Number(this.env.COST_CAP || 1),
      live: await live(this.env).catch((error) => ({ error: error.message })) };
    this.cached = { until: now + MIN, value };
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
const HEADERS = { 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };

export default {
  async fetch(request, env) {
    if (!(await accessOk(request, env))) return new Response('Forbidden', { status: 403 });
    const { pathname } = new URL(request.url);
    if (pathname === '/') return new Response(page, { headers: { ...HEADERS, 'content-type': 'text/html; charset=utf-8' } });
    if (pathname === '/api/data') return Response.json(await store(env).data(), { headers: HEADERS });
    // JSON only: a cross-site form cannot send it without a preflight, which this Worker never answers.
    if (pathname === '/api/unblock' && request.method === 'POST' && request.headers.get('content-type') === 'application/json') {
      return Response.json({ ok: await store(env).unblock(String((await request.json()).account ?? '')) }, { headers: HEADERS });
    }
    return new Response('Not Found', { status: 404 });
  },
  async scheduled(_, env, ctx) {
    ctx.waitUntil(store(env).run());
  },
};
