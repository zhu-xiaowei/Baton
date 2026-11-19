// Usage points (Workers Analytics Engine, env.USAGE; absent on self-hosts) and the monthly cost cap of one AccountObject.
// No content and no account id leave the object: accounts appear as a hash. Point layout (server/cloudflare/monitor.mjs):
// blobs [kind, account, day, platform|os|role, country, network, new|version|reason], doubles [seconds, apps, code, weight].
import { refuse } from './ports.mjs';

const HOUR = 3_600_000;
const SAMPLE = 10; // detail points: 1 in 10, weight 10
const today = () => new Date().toISOString().slice(0, 10);
const platformOf = (ua = '') => (/iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'macOS'
  : /Windows/.test(ua) ? 'Windows' : /Linux|X11/.test(ua) ? 'Linux' : 'web');
export const accountHash = async (account) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account)))]
  .slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');

export class Usage {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async state() { return (this.s ??= (await this.ctx.storage.get('usage')) ?? {}); }
  save() { return this.ctx.storage.put('usage', this.s); }

  async point(account, blobs, doubles = []) {
    if (!this.env.USAGE || !account) return;
    const hash = (this.hash ??= await accountHash(account));
    try { this.env.USAGE.writeDataPoint({ indexes: [hash], blobs: [blobs[0], hash, ...blobs.slice(1)], doubles }); } catch {}
  }

  async blocked() { return ((await this.state()).blockedUntil ?? 0) > Date.now(); }
  async block(until) { (await this.state()).blockedUntil = until; await this.save(); }

  // A refused upgrade, sampled.
  refuse(account, code, reason) {
    if (Math.random() * SAMPLE < 1) this.point(account, ['reject', today(), '', '', '', reason], [0, 0, code, SAMPLE]);
    return refuse(code, reason);
  }

  // An accepted socket: the account's first App of the day writes `active`, each Bridge device `bridge` once a day.
  async joined(request, me, isNew) {
    const s = await this.state();
    if (s.day !== today()) {
      if (s.secs > (s.reported ?? 0)) await this.point(me.account, ['summary', s.day], [s.secs, s.apps.length]);
      Object.assign(s, { day: today(), secs: 0, reported: 0, at: 0, apps: [], devs: [] });
    }
    const app = me.role === 'app' ? me.tokenHash.slice(0, 8) : me.device;
    const seen = me.role === 'app' ? s.apps : s.devs;
    if (seen.includes(app)) return;
    const query = new URL(request.url).searchParams;
    if (me.role === 'bridge') await this.point(me.account, ['bridge', s.day, query.get('os') ?? '', '', '', query.get('version') ?? '']);
    else if (!s.apps.length) {
      await this.point(me.account, ['active', s.day, platformOf(request.headers.get('user-agent') ?? ''), request.cf?.country ?? '',
        String(request.cf?.asOrganization ?? '').slice(0, 64), isNew() ? 'new' : '']);
    }
    seen.push(app);
    await this.save();
  }

  // A socket gone: sampled detail; App time adds up, summarised when the last App leaves (at most hourly).
  async left(me, code, appsLeft) {
    const secs = Math.round((Date.now() - me.connectedAt) / 1000);
    if (Math.random() * SAMPLE < 1) await this.point(me.account, ['conn', today(), me.role, '', '', String(code ?? '')], [secs, 0, code ?? 0, SAMPLE]);
    if (me.role !== 'app') return;
    const s = await this.state();
    s.secs = (s.secs ?? 0) + secs;
    if (!appsLeft && Date.now() - (s.at ?? 0) >= HOUR) {
      await this.point(me.account, ['summary', s.day ?? today()], [s.secs, s.apps?.length ?? 0]);
      Object.assign(s, { at: Date.now(), reported: s.secs });
    }
    await this.save();
  }
}
