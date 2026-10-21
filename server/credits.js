'use strict';
// CON-CREDITS / CON-USAGE-2: per-account API spend chips and SEPARATE per-account
// Extra Usage chips (never lumped), plus the Settings rows behind them.
//
// Keys: one user environment variable per configured account,
// CLAUDE_CONSOLE_<ACCOUNT ID>_API_KEY (e.g. CLAUDE_CONSOLE_ACCT1_API_KEY), read here,
// SERVER SIDE ONLY: from this process's environment, else the user registry (HKCU\
// Environment) because a variable set after the console started is not in its env. A key
// never leaves this module: not in a response, a log line, an error text or the page.
// What leaves: the variable NAME, set / unset, the key kind (admin | regular | unknown),
// numbers, a short error code and the time of the last read.
//
// Source: an Admin API key (sk-ant-admin...) reads the organization's cost report,
// GET https://api.anthropic.com/v1/organizations/cost_report (anthropic-version
// 2023-06-01), month to date, amounts in cents as decimal strings -> USD. There is no
// documented prepaid-balance endpoint, so the API chip shows month-to-date API SPEND. A
// regular key cannot read it (chip "!", Settings says an Admin key is needed). Extra
// Usage (the subscription's paid overage) has no API source here: its chip reads the
// optional per-account fields extraUsedUsd / extraLimitUsd of the quota state file when
// a source ever writes them, else "--".
//
// CON-API-PUBLIC (ruling 2026-10-21, option A): ships in the public build, OFF by default.
// Nothing is read (no key, no registry, no call) until the user turns it on in Settings
// (console.local.json credits.enabled, opts.optIn), and every call passes
// installer/egress.check(url, 'credits'), which refuses api.anthropic.com while that
// opt-in is off (egress.json marks the host optIn). The egress log is host-only.
const { execFile } = require('child_process');

const API_HOST = 'https://api.anthropic.com';
const REFRESH_MS = 15 * 60 * 1000;
const MIN_FORCE_MS = 60 * 1000;
const KEY_CACHE_MS = 5 * 60 * 1000;
const MAX_PAGES = 4;

function varName(id) {
  return 'CLAUDE_CONSOLE_' + String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY';
}
function keyKind(key) {
  if (typeof key !== 'string' || !key) return null;
  if (/^sk-ant-admin/.test(key)) return 'admin';
  if (/^sk-ant-/.test(key)) return 'regular';
  return 'unknown';
}
function monthStartIso(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
// cost_report pages -> USD (amounts are cents as decimal strings; non-USD rows skipped).
function sumCostReport(pages) {
  let cents = 0;
  let rows = 0;
  for (const pg of pages || []) {
    for (const b of (pg && Array.isArray(pg.data) ? pg.data : [])) {
      for (const r of (b && Array.isArray(b.results) ? b.results : [])) {
        if (r && r.currency && r.currency !== 'USD') continue;
        const v = parseFloat(r && r.amount);
        if (Number.isFinite(v)) { cents += v; rows++; }
      }
    }
  }
  return { usd: Math.round(cents) / 100, rows };
}
// Error text that can never carry the key: a fixed code per failure class.
function errCode(status) {
  if (status === 401) return 'key rejected (401)';
  if (status === 403) return 'not allowed (403): needs an Admin key';
  if (status === 429) return 'rate limited (429)';
  if (status >= 500) return 'API error (' + status + ')';
  if (status) return 'HTTP ' + status;
  return 'network error';
}

function regRead(name, runner) {
  return new Promise((resolve) => {
    const run = runner || ((f, a, o, cb) => execFile(f, a, o, cb));
    try {
      run('reg.exe', ['query', 'HKCU\\Environment', '/v', name], { windowsHide: true, timeout: 10000 }, (err, out) => {
        if (err) return resolve(null);
        const m = new RegExp(name + '\\s+REG_\\w+\\s+(\\S+)').exec(String(out || ''));
        resolve(m ? m[1].trim() : null);
      });
    } catch (e) { resolve(null); }
  });
}

class CreditsService {
  // opts: { accounts: [{id, label}], env, reg (name -> Promise<value|null>), fetch,
  //         now, quota: () => quota snapshot, enabled, optIn: () => bool, egress }
  constructor(opts) {
    opts = opts || {};
    this.accounts = opts.accounts || [];
    this.env = opts.env || process.env;
    this.reg = opts.reg || ((n) => regRead(n));
    this.fetch = opts.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.now = opts.now || (() => Date.now());
    this.quota = opts.quota || (() => null);
    this.enabled = opts.enabled !== false;
    this.optIn = typeof opts.optIn === 'function' ? opts.optIn : () => opts.optIn === true;
    this.egress = opts.egress || null;
    this.keys = new Map(); // id -> {value, at}; the value never leaves this object
    this.api = new Map(); // id -> {usd, at, error}
    this.busy = null;
    this.lastForce = 0;
    this.timer = null;
  }

  async key(id) {
    const now = this.now();
    const c = this.keys.get(id);
    if (c && now - c.at < KEY_CACHE_MS) return c.value;
    const name = varName(id);
    let v = typeof this.env[name] === 'string' && this.env[name] ? this.env[name] : null;
    if (!v) { try { v = await this.reg(name); } catch (e) { v = null; } }
    this.keys.set(id, { value: v || null, at: now });
    return v || null;
  }

  async readCost(key) {
    if (!this.fetch) return { error: 'no fetch' };
    const pages = [];
    let page = null;
    for (let i = 0; i < MAX_PAGES; i++) {
      const u = new URL(API_HOST + '/v1/organizations/cost_report');
      u.searchParams.set('starting_at', monthStartIso(this.now()));
      u.searchParams.set('bucket_width', '1d');
      u.searchParams.set('limit', '31');
      if (page) u.searchParams.set('page', page);
      if (this.egress) { try { this.egress.check(u.href, 'credits'); } catch (e) { return { error: 'egress refused (opt-in off)' }; } }
      let r;
      try {
        r = await this.fetch(u.href, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      } catch (e) {
        return { error: errCode(0) };
      }
      if (!r.ok) return { error: errCode(r.status) };
      let j;
      try { j = await r.json(); } catch (e) { return { error: 'bad response' }; }
      pages.push(j);
      if (!j || !j.has_more || !j.next_page) break;
      page = String(j.next_page);
    }
    return { usd: sumCostReport(pages).usd };
  }

  async refresh(force) {
    if (!this.enabled) return this.snapshot();
    if (!this.on()) { this.keys.clear(); this.api.clear(); return this.snapshot(); }
    const now = this.now();
    if (force && now - this.lastForce < MIN_FORCE_MS) force = false;
    if (force) { this.lastForce = now; this.keys.clear(); }
    if (this.busy) return this.busy;
    this.busy = (async () => {
      for (const a of this.accounts) {
        const key = await this.key(a.id);
        const prev = this.api.get(a.id);
        if (!key || keyKind(key) !== 'admin') { this.api.delete(a.id); continue; }
        if (!force && prev && now - prev.at < REFRESH_MS) continue;
        const res = await this.readCost(key);
        this.api.set(a.id, { usd: res.usd === undefined ? (prev ? prev.usd : null) : res.usd, at: now, error: res.error || null });
      }
      return this.snapshot();
    })();
    try { return await this.busy; } finally { this.busy = null; }
  }

  on() { try { return this.optIn() === true; } catch (e) { return false; } }

  // The client-safe view: no key, ever.
  snapshot() {
    const q = this.quota();
    const qa = q && Array.isArray(q.accounts) ? q.accounts : [];
    return {
      enabled: this.enabled,
      optIn: this.on(),
      accounts: this.accounts.map((a) => {
        const c = this.keys.get(a.id);
        const kind = c ? keyKind(c.value) : null;
        const api = this.api.get(a.id) || null;
        const qq = (qa.find((x) => x && x.id === a.id) || {}).quota || {};
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        return {
          id: a.id, label: a.label, keyVar: varName(a.id), keySet: !!(c && c.value), keyKind: kind,
          api: kind === 'admin' ? { usd: api ? api.usd : null, at: api ? api.at : null, error: api ? api.error : null } : null,
          extra: num(qq.extraUsedUsd) !== null ? { used: num(qq.extraUsedUsd), limit: num(qq.extraLimitUsd) } : null,
        };
      }),
    };
  }

  start() {
    if (!this.enabled) return;
    this.refresh(false).catch(() => {});
    this.timer = setInterval(() => this.refresh(false).catch(() => {}), REFRESH_MS);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { CreditsService, varName, keyKind, monthStartIso, sumCostReport, errCode, regRead, REFRESH_MS };
