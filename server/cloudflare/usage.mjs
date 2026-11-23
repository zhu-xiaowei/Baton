// Usage points (Workers Analytics Engine, env.USAGE; absent on self-hosts) and the monthly cost cap of one AccountObject.
// No content and no account id leave the object: accounts appear as a hash. Point layout (server/cloudflare/monitor.mjs):
// blobs [kind, account, day, platform|os|role, country, network, new|version|reason, device], doubles [seconds, apps, code, weight].
// `app` / `bridge`: each App (token) / computer once a day; `device` is a hash of it (the monitor's device count).
// `relay`: an App (token) or Bridge (device) through the mainland-China relay, once a day each: [relay, account, day, role].
import { readIpToken } from '../core/accounts.mjs';
import { refuse } from './ports.mjs';

const SAMPLE = 10; // detail points: 1 in 10, weight 10
export const today = () => new Date().toISOString().slice(0, 10);
const platformOf = (ua = '') => (/iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'macOS'
  : /Windows/.test(ua) ? 'Windows' : /Linux|X11/.test(ua) ? 'Linux' : 'web');
export const accountHash = async (account) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(account)))]
  .slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');

// What a socket's daily points need, kept on it: one still open on a later UTC day counts there at its next frame.
export function describe(request) {
  const query = new URL(request.url).searchParams;
  return { ip: request.headers.get('cf-connecting-ip'), platform: platformOf(request.headers.get('user-agent') ?? ''),
    os: query.get('os') ?? '', version: query.get('version') ?? '', ipt: query.get('ipt') ?? '',
    country: request.cf?.country ?? '', network: String(request.cf?.asOrganization ?? '').slice(0, 64) };
}

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
  async joined(info, me, isNew) {
    const s = await this.state();
    if (s.day !== today()) Object.assign(s, { day: today(), apps: [], devs: [], rel: [] });
    const app = me.role === 'app' ? me.tokenHash.slice(0, 8) : me.device;
    const seen = me.role === 'app' ? s.apps : s.devs;
    const relay = (this.env.RELAY_IPS ?? '').split(',').includes(info.ip);
    if (relay && !(s.rel ??= []).includes(`${me.role}:${app}`)) { // also when it came directly earlier today
      await this.point(me.account, ['relay', s.day, me.role]);
      s.rel.push(`${me.role}:${app}`);
      await this.save();
    }
    if (seen.includes(app)) return;
    const device = (await accountHash(`${me.account}|${me.role}|${app}`)).slice(0, 12);
    if (me.role === 'bridge') await this.point(me.account, ['bridge', s.day, info.os, '', '', info.version, device]);
    else await this.point(me.account, ['app', s.day, info.platform, '', '', '', device]);
    if (me.role === 'app' && !s.apps?.length) {
      // Through the relay Cloudflare sees only the relay: the App's signed address (`ipt`) if any.
      const own = relay && await readIpToken(this.env.IP_TOKEN_KEY, info.ipt);
      const [country, network] = !relay ? [info.country, info.network]
        : own ? [own.country, `AS${own.asn}`] : ['relay', 'relay'];
      await this.point(me.account, ['active', s.day, info.platform, country, network, isNew() ? 'new' : '']);
    }
    seen.push(app);
    await this.save();
  }

  // A socket gone, sampled; its seconds also give the monitor's App time per active account (nothing stored).
  async left(me, code) {
    const secs = Math.round((Date.now() - me.connectedAt) / 1000);
    if (Math.random() * SAMPLE < 1) await this.point(me.account, ['conn', today(), me.role, '', '', String(code ?? '')], [secs, 0, code ?? 0, SAMPLE]);
  }
}
