'use strict';
// CON-WATCHDOG (S49 operator intake 2026-10-18), OBSERVE-ONLY first cut: the measurement
// and collection half. CLAUDE.md "measure before choosing a threshold": this module
// collects and analyses, and every threshold is CONFIG (`watchdog.thresholds`, all null
// by default). With a threshold unset nothing is flagged; with one set, a candidate is
// listed in `wouldReport` (with the tree it would go to) but NOTHING is ever sent - no
// channel note, no inbox write, no process touched. Reporting is a later step, once the
// baselines below are measured and the thresholds are chosen from them.
//
// One collector run per interval (default 600 s) through an injected runner: a READ-ONLY
// PowerShell (Win32_Process rows, four \Memory counters, Application log events 1000
// crash / 1001 WER / 1002 hang since the previous sample). The event start time travels
// in an environment variable, never on the command line. Command lines are used only to
// tag a row (seed case, owning tree) and are never stored. Samples go to
// <dataDir>/watchdog/<yyyy-mm-dd>/samples.jsonl; day folders past retainDays go to the
// Recycle Bin (drops.pruneDrops), never a direct delete.
//
// Seed cases (ROADMAP S47): DIALVOL-LEAK (DialVolume.ps1 powershell, 795 MB private after
// 5.8 days, ~5.7 MB/h) and BT-LEAK (MTKBTSVC, 7.0 M handles after 5.8 days, ~40k/h). They
// mark the known-bad end of the scale; the normal-process baseline is what is missing.
const fs = require('fs');
const path = require('path');
const drops = require('./drops');
const { fit } = require('./health');
const { ownerOf, POWERSHELL } = require('./scheduler');

const H = 3600000;
const MB = 1048576;

const PS_COLLECT = "$ErrorActionPreference = 'SilentlyContinue'; "
  + '$p = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; path = [string]$_.ExecutablePath; cmd = [string]$_.CommandLine; '
  + 'priv = [long]$_.PrivatePageCount; handles = [long]$_.HandleCount; '
  + "created = $(if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } else { 0 }) } }); "
  + "$c = Get-Counter -Counter @('\\Memory\\Pages/sec', '\\Memory\\Page Reads/sec', '\\Memory\\Available MBytes', '\\Memory\\% Committed Bytes In Use') -SampleInterval 1 -MaxSamples 1; "
  + "$m = @{}; if ($c) { foreach ($s in $c.CounterSamples) { $m[$s.Path.Split('\\')[-1].ToLowerInvariant()] = [double]$s.CookedValue } }; "
  + '$since = [datetime]::Parse($env:CC_WD_SINCE, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind); '
  + "$ev = @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; Id = 1000, 1001, 1002; StartTime = $since } -MaxEvents 200 -ErrorAction SilentlyContinue | ForEach-Object { "
  + "[pscustomobject]@{ t = [long]($_.TimeCreated.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds; id = [int]$_.Id; provider = [string]$_.ProviderName; "
  + "app = $(if ($_.Id -ne 1001 -and $_.Properties.Count -gt 0) { [string]$_.Properties[0].Value } else { '' }) } }); "
  + 'ConvertTo-Json -InputObject ([pscustomobject]@{ procs = $p; mem = $m; events = $ev }) -Depth 4 -Compress';

const DEFAULT_SEEDS = Object.freeze([
  Object.freeze({ id: 'DIALVOL-LEAK', name: 'powershell.exe', cmd: 'DialVolume.ps1', known: 'about 5.7 MB/h private bytes (795 MB after 5.8 days)' }),
  Object.freeze({ id: 'BT-LEAK', name: 'MTKBTSVC.exe', cmd: null, known: 'about 40k handles/h (7.0 M after 5.8 days)' }),
]);

const THRESHOLD_KEYS = Object.freeze(['privMBh', 'handlesH', 'r2', 'minSpanH', 'pagesPerSec', 'crashesPerApp']);

function wdConfig(cfg) {
  const w = (cfg && cfg.watchdog) || {};
  const num = (v, d, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
  const th = {};
  const t = w.thresholds && typeof w.thresholds === 'object' ? w.thresholds : {};
  for (const k of THRESHOLD_KEYS) th[k] = typeof t[k] === 'number' && isFinite(t[k]) && t[k] >= 0 ? t[k] : null;
  const seeds = Array.isArray(w.seeds) ? w.seeds.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string').map((s) => ({ id: s.id.slice(0, 40), name: s.name, cmd: typeof s.cmd === 'string' ? s.cmd : null, known: typeof s.known === 'string' ? s.known : null })) : DEFAULT_SEEDS;
  return {
    mode: 'observe', // the only mode: reporting comes after measuring
    enabled: w.enabled !== false,
    intervalSec: num(w.intervalSec, 600, 60, 86400),
    retainDays: num(w.retainDays, 14, 1, 365),
    windowH: num(w.windowH, 72, 1, 24 * 60),
    topN: num(w.topN, 40, 1, 500),
    thresholds: th,
    seeds,
  };
}

function pad(n) { return String(n).padStart(2, '0'); }
function dayName(ms) { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
const fin = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function seedOf(p, seeds) {
  for (const s of seeds || []) {
    if (String(p.name || '').toLowerCase() !== s.name.toLowerCase()) continue;
    if (s.cmd && !String(p.cmd || '').toLowerCase().includes(s.cmd.toLowerCase())) continue;
    return s.id;
  }
  return null;
}

// Collector JSON -> stored sample {t, procs: [{k, n, pid, o, s, pb, h}], mem, events}.
// ctx: {projects, consoleRoot, seeds, topN}
function parseSample(text, t, ctx) {
  let j;
  try { j = JSON.parse(String(text)); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  ctx = ctx || {};
  const topN = ctx.topN || 40;
  const raw = (Array.isArray(j.procs) ? j.procs : j.procs ? [j.procs] : []).filter((p) => p && Number.isInteger(p.pid));
  const rows = raw.map((p) => ({
    p,
    seed: seedOf(p, ctx.seeds),
    owner: ownerOf({ actions: [{ exe: p.path || '', args: p.cmd || '', workdir: '' }] }, ctx.projects || [], ctx.consoleRoot || null),
  }));
  const keep = new Set();
  [...rows].sort((a, b) => (b.p.priv || 0) - (a.p.priv || 0)).slice(0, topN).forEach((r) => keep.add(r));
  [...rows].sort((a, b) => (b.p.handles || 0) - (a.p.handles || 0)).slice(0, topN).forEach((r) => keep.add(r));
  for (const r of rows) if (r.seed || r.owner) keep.add(r);
  const procs = rows.filter((r) => keep.has(r)).map((r) => ({
    k: String(r.p.name) + '|' + r.p.pid + '|' + (fin(r.p.created) || 0), n: String(r.p.name || '').slice(0, 80), pid: r.p.pid,
    o: r.owner, s: r.seed, pb: fin(r.p.priv) || 0, h: fin(r.p.handles) || 0,
  }));
  const m = j.mem && typeof j.mem === 'object' ? j.mem : {};
  const mem = { pagesPerSec: fin(m['pages/sec']), pageReadsPerSec: fin(m['page reads/sec']), availMB: fin(m['available mbytes']), commitPct: fin(m['% committed bytes in use']) };
  const events = (Array.isArray(j.events) ? j.events : j.events ? [j.events] : [])
    .filter((e) => e && fin(e.t) !== null && [1000, 1001, 1002].includes(e.id))
    .map((e) => ({ t: e.t, id: e.id, app: String(e.app || '').slice(0, 120) }));
  return { t, procs, mem, events };
}

function stats(vals) {
  const s = vals.filter((v) => v !== null).sort((a, b) => a - b);
  if (!s.length) return { median: null, p95: null, max: null };
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const p95 = s[Math.max(0, Math.ceil(0.95 * s.length) - 1)];
  const r = (v) => Math.round(v * 10) / 10;
  return { median: r(median), p95: r(p95), max: r(s[s.length - 1]) };
}

const r1 = (v) => Math.round(v * 10) / 10;
const routeTo = (owner) => (owner && owner !== 'main' && owner !== 'console' ? owner : 'HOME');

// samples -> trends, seeds, paging, crashes, wouldReport (threshold-gated), measuring.
function analyze(samples, thresholds, opts) {
  opts = opts || {};
  const th = thresholds || {};
  const list = (samples || []).filter((s) => s && fin(s.t) !== null).sort((a, b) => a.t - b.t);
  const out = { samples: list.length, spanH: 0, processes: 0, privGrowth: [], handleGrowth: [], seeds: [], paging: { n: 0 }, crashes: { total: 0, wer: 0, byApp: [] }, wouldReport: [], measuring: [] };
  if (list.length) out.spanH = r1((list[list.length - 1].t - list[0].t) / H);
  const series = new Map();
  for (const s of list) {
    for (const p of s.procs || []) {
      let x = series.get(p.k);
      if (!x) { x = { name: p.n, pid: p.pid, owner: p.o, seed: p.s, pts: [] }; series.set(p.k, x); }
      x.pts.push([s.t, p.pb / MB, p.h]);
    }
  }
  out.processes = series.size;
  const trends = [];
  for (const x of series.values()) {
    if (x.pts.length < 3) continue;
    const t0 = x.pts[0][0];
    const pr = fit(x.pts.map((q) => [(q[0] - t0) / H, q[1]]));
    const hd = fit(x.pts.map((q) => [(q[0] - t0) / H, q[2]]));
    const last = x.pts[x.pts.length - 1];
    trends.push({ name: x.name, pid: x.pid, owner: x.owner, seed: x.seed, n: x.pts.length, spanH: r1((last[0] - t0) / H), privMB: Math.round(last[1]), mbPerH: r1(pr.slope), r2: Math.round(pr.r2 * 100) / 100, handles: last[2], perH: Math.round(hd.slope), r2h: Math.round(hd.r2 * 100) / 100 });
  }
  out.privGrowth = trends.filter((t) => t.mbPerH > 0).sort((a, b) => b.mbPerH - a.mbPerH).slice(0, 10);
  out.handleGrowth = trends.filter((t) => t.perH > 0).sort((a, b) => b.perH - a.perH).slice(0, 10);
  for (const sd of opts.seeds || []) {
    const mine = trends.filter((t) => t.seed === sd.id).sort((a, b) => b.n - a.n)[0];
    const any = [...series.values()].some((x) => x.seed === sd.id);
    out.seeds.push(mine ? { id: sd.id, seen: true, name: mine.name, n: mine.n, spanH: mine.spanH, privMB: mine.privMB, mbPerH: mine.mbPerH, handles: mine.handles, handlesPerH: mine.perH, known: sd.known || null } : { id: sd.id, seen: any, known: sd.known || null });
  }
  // paging
  const pick = (k) => list.map((s) => (s.mem ? fin(s.mem[k]) : null));
  out.paging = { n: pick('pagesPerSec').filter((v) => v !== null).length, pagesPerSec: stats(pick('pagesPerSec')), pageReadsPerSec: stats(pick('pageReadsPerSec')), availMB: stats(pick('availMB')), commitPct: stats(pick('commitPct')) };
  // crashes / hangs, deduplicated across overlapping event windows
  const seen = new Set();
  const byApp = new Map();
  for (const s of list) {
    for (const e of s.events || []) {
      const key = e.t + '|' + e.id + '|' + e.app;
      if (seen.has(key)) continue;
      seen.add(key);
      if (e.id === 1001) { out.crashes.wer++; continue; }
      out.crashes.total++;
      const a = byApp.get(e.app) || { app: e.app, crashes: 0, hangs: 0 };
      if (e.id === 1000) a.crashes++; else a.hangs++;
      byApp.set(e.app, a);
    }
  }
  out.crashes.byApp = [...byApp.values()].sort((a, b) => (b.crashes + b.hangs) - (a.crashes + a.hangs) || a.app.localeCompare(b.app)).slice(0, 20);
  // candidates - only for thresholds that are set
  const enough = (t) => th.minSpanH === null || th.minSpanH === undefined || t.spanH >= th.minSpanH;
  const fits = (r2) => th.r2 === null || th.r2 === undefined || r2 >= th.r2;
  if (th.privMBh !== null && th.privMBh !== undefined) {
    for (const t of trends) if (enough(t) && t.mbPerH >= th.privMBh && fits(t.r2)) out.wouldReport.push({ kind: 'private-bytes', name: t.name, pid: t.pid, owner: t.owner, to: routeTo(t.owner), value: t.mbPerH, unit: 'MB/h', threshold: th.privMBh, spanH: t.spanH });
  }
  if (th.handlesH !== null && th.handlesH !== undefined) {
    for (const t of trends) if (enough(t) && t.perH >= th.handlesH && fits(t.r2h)) out.wouldReport.push({ kind: 'handles', name: t.name, pid: t.pid, owner: t.owner, to: routeTo(t.owner), value: t.perH, unit: 'handles/h', threshold: th.handlesH, spanH: t.spanH });
  }
  if (th.pagesPerSec !== null && th.pagesPerSec !== undefined && out.paging.pagesPerSec.p95 !== null && out.paging.pagesPerSec.p95 >= th.pagesPerSec) {
    out.wouldReport.push({ kind: 'thrash', name: 'paging', owner: null, to: 'HOME', value: out.paging.pagesPerSec.p95, unit: 'pages/s p95', threshold: th.pagesPerSec, spanH: out.spanH });
  }
  if (th.crashesPerApp !== null && th.crashesPerApp !== undefined) {
    for (const a of out.crashes.byApp) if (a.crashes + a.hangs >= th.crashesPerApp) out.wouldReport.push({ kind: 'crash', name: a.app, owner: null, to: 'HOME', value: a.crashes + a.hangs, unit: 'events', threshold: th.crashesPerApp, spanH: out.spanH });
  }
  // what still has to be measured before a threshold is chosen
  const want = 72;
  out.measuring.push('private-bytes slope baseline of normal processes: needs >= ' + want + ' h of samples (have ' + out.spanH + ' h)');
  out.measuring.push('handle-count slope baseline over the same window; the seeds mark the known-bad end (' + (opts.seeds || []).map((s) => s.id).join(', ') + ')');
  out.measuring.push('paging baseline: pages/sec median and p95 over a normal working week (have ' + out.paging.n + ' samples)');
  out.measuring.push('crash / hang rate per app over 7 days (have ' + out.crashes.total + ' events)');
  const unset = THRESHOLD_KEYS.filter((k) => th[k] === null || th[k] === undefined);
  if (unset.length) out.measuring.push('thresholds unset (config watchdog.thresholds): ' + unset.join(', '));
  return out;
}

class Watchdog {
  // opts: {runner, dataDir, cfg, projects: () => [], consoleRoot, now, recycle}
  constructor(opts) {
    opts = opts || {};
    this.runner = opts.runner || null;
    this.conf = wdConfig(opts.cfg || {});
    this.dir = path.join(opts.dataDir, 'watchdog');
    this.projectsFn = opts.projects || (() => []);
    this.consoleRoot = opts.consoleRoot || null;
    this.now = opts.now || (() => Date.now());
    this.recycle = opts.recycle || drops.recycle;
    this.timer = null;
    this.timers = [];
    this.sampling = false;
    this.lastT = null;
    this.lastSampleAt = null;
    this.lastError = null;
  }

  latestOnDisk() {
    const days = this.dayDirs();
    for (let i = days.length - 1; i >= 0; i--) {
      const rows = this.readDay(days[i]);
      if (rows.length) return rows[rows.length - 1].t;
    }
    return null;
  }

  dayDirs() {
    try { return fs.readdirSync(this.dir).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort(); } catch (e) { return []; }
  }

  readDay(day) {
    let text = '';
    try { text = fs.readFileSync(path.join(this.dir, day, 'samples.jsonl'), 'utf8'); } catch (e) { return []; }
    const out = [];
    for (const ln of text.split('\n')) {
      if (!ln.trim()) continue;
      try { out.push(JSON.parse(ln)); } catch (e) { /* a torn last line */ }
    }
    return out;
  }

  async sample() {
    if (!this.runner || this.sampling) return null;
    this.sampling = true;
    try {
      const t = this.now();
      if (this.lastT === null) this.lastT = this.latestOnDisk();
      const since = this.lastT !== null ? this.lastT : t - this.conf.intervalSec * 1000;
      const r = await this.runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', PS_COLLECT], { env: { CC_WD_SINCE: new Date(since).toISOString() }, timeoutMs: 120000 });
      if (!r || r.code !== 0) {
        this.lastError = 'collector: ' + String((r && (r.stderr || r.stdout)) || 'no output').replace(/\s+/g, ' ').trim().slice(0, 200);
        return null;
      }
      const s = parseSample(r.stdout, t, { projects: this.projectsFn() || [], consoleRoot: this.consoleRoot, seeds: this.conf.seeds, topN: this.conf.topN });
      if (!s) { this.lastError = 'collector output unreadable'; return null; }
      const day = path.join(this.dir, dayName(t));
      fs.mkdirSync(day, { recursive: true });
      fs.appendFileSync(path.join(day, 'samples.jsonl'), JSON.stringify(s) + '\n');
      this.lastT = t;
      this.lastSampleAt = t;
      this.lastError = null;
      return s;
    } catch (e) {
      this.lastError = 'sample failed: ' + (e && e.message ? e.message : e);
      return null;
    } finally {
      this.sampling = false;
    }
  }

  // Samples inside the analysis window, oldest first.
  window() {
    const from = this.now() - this.conf.windowH * H;
    const days = this.dayDirs().slice(-(Math.ceil(this.conf.windowH / 24) + 1));
    const out = [];
    for (const d of days) for (const s of this.readDay(d)) if (s && s.t >= from) out.push(s);
    return out;
  }

  snapshot() {
    const c = this.conf;
    return {
      mode: c.mode, enabled: c.enabled, collecting: !!this.timer, intervalSec: c.intervalSec, retainDays: c.retainDays, windowH: c.windowH,
      lastSampleAt: this.lastSampleAt, lastError: this.lastError, thresholds: c.thresholds,
      analysis: analyze(this.window(), c.thresholds, { seeds: c.seeds }),
    };
  }

  async prune() {
    return drops.pruneDrops(this.dir, { now: this.now(), days: this.conf.retainDays, recycle: this.recycle });
  }

  start() {
    if (this.timer || !this.conf.enabled || !this.runner) return;
    const tick = () => { this.sample().catch(() => {}); };
    this.timer = setInterval(tick, this.conf.intervalSec * 1000);
    const first = setTimeout(tick, 60000);
    const prune = setInterval(() => { this.prune().catch(() => {}); }, 24 * H);
    this.timers = [first, prune];
    for (const x of [this.timer, first, prune]) if (x.unref) x.unref();
  }

  stop() {
    clearInterval(this.timer);
    for (const x of this.timers) { clearTimeout(x); clearInterval(x); }
    this.timer = null;
    this.timers = [];
  }
}

module.exports = { PS_COLLECT, DEFAULT_SEEDS, THRESHOLD_KEYS, wdConfig, dayName, parseSample, analyze, stats, Watchdog };
