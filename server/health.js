'use strict';
// HEALTH (2026-10-18 "v19.1" A): Settings > "Health & cleanup".
// A manual health check and cleanup run over a FIXED allowlist of step ids, one run
// at a time. Core (this file) owns the Console steps; PC / Repo / LLM steps come only
// from an optional plugin (server/plugins/main.js, off unless configured), so the
// public build ships the Console steps alone.
//
// Each step: {id, group, label, eta_s, cost: {usd, tokens} (0 for deterministic
// steps; a {median, lo, hi} band for an LLM step), deletes: text | null, default}.
// While a run is in flight the item-12 progress file is rewritten after every step
// ({task, pct, step, eta_s, status, updated, checklist}); the finished run is appended
// to <reportDir>/<yyyy-mm-dd>.json. Every delete goes to the Recycle Bin.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const drops = require('./drops');
const clean = require('../installer/machine-advisors-cleanliness');

const CORE_STEPS = Object.freeze([
  { id: 'console.drops', group: 'Console', label: 'Old composer attachments (drops/ day folders over 14 days)', eta_s: 10, default: true, deletes: 'drops/ day folders over 14 days old, to the Recycle Bin' },
  { id: 'console.panes', group: 'Console', label: 'Dead and idle panes', eta_s: 1, default: true, deletes: 'closes panes whose process exited over 1 h ago (their scrollback is discarded; nothing on disk)' },
  { id: 'console.orphans', group: 'Console', label: 'Orphaned child processes of closed panes', eta_s: 5, default: false, deletes: 'ends processes left running by panes that are gone' },
  { id: 'console.memory', group: 'Console', label: 'Server memory (RSS, heap) and leak trend', eta_s: 1, default: true, deletes: null },
  { id: 'console.scrollback', group: 'Console', label: 'Scrollback held by panes', eta_s: 1, default: true, deletes: null },
].map((s) => Object.freeze(Object.assign({ cost: { usd: 0, tokens: 0 } }, s))));

// CON-013 L9 (mach-findings-rules, generic subset): machine-health steps. Report-only
// (deletes: null) and off by default; a cleanup is a separate, consented act per
// suggestion (applyCleanup), always through the Recycle Bin. Passed to HealthRunner by
// whoever mounts them: `core: Object.assign(coreRunners(d), machineRunners(m))` with
// `steps: CORE_STEPS.concat(MACHINE_STEPS)`.
const MACHINE_STEPS = Object.freeze([
  { id: 'machine.temp', group: 'Machine', label: 'Temp hygiene: file count against the alarm line', eta_s: 20, default: false, deletes: null },
  { id: 'machine.disk', group: 'Machine', label: 'Disk free per drive', eta_s: 2, default: false, deletes: null },
  { id: 'machine.scratch', group: 'Machine', label: 'Scratch in repos, Temp and outside folders (suggestions only)', eta_s: 20, default: false, deletes: null },
].map((s) => Object.freeze(Object.assign({ cost: { usd: 0, tokens: 0 } }, s))));

const DISK_FREE_WARN_PCT = 20;

// Free space per fixed drive (read-only CIM query).
function listDisks() {
  return new Promise((resolve) => {
    const ps = "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { '{0}|{1}|{2}' -f $_.DeviceID, $_.Size, $_.FreeSpace }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000 }, (err, out) => {
      if (err) return resolve(null);
      const rows = [];
      for (const ln of String(out).split(/\r?\n/)) {
        const m = /^([A-Z]:)\|(\d+)\|(\d+)$/.exec(ln.trim());
        if (m) rows.push({ id: m[1], size: +m[2], free: +m[3] });
      }
      resolve(rows);
    });
  });
}

// deps: {temp, repos, outside, untracked, disks(), now, alarm}
function machineRunners(deps) {
  deps = deps || {};
  const temp = deps.temp || os.tmpdir();
  return {
    'machine.temp': async () => {
      const c = clean.tempCensus(temp, { alarm: deps.alarm });
      const findings = c.alarm ? ['Temp holds ' + c.files + ' files, over the ' + c.alarm_line + ' alarm line; Temp file count is logon time - review the machine.scratch suggestions'] : [];
      return result('machine.temp', true, 'Temp: ' + c.files + ' files, ' + Math.round(c.bytes / MB) + ' MB (alarm at ' + c.alarm_line + ')', { files: c.files, mb: Math.round(c.bytes / MB), alarm_line: c.alarm_line, alarm: c.alarm }, findings);
    },
    'machine.disk': async () => {
      const rows = await (deps.disks || listDisks)();
      if (!rows) return result('machine.disk', false, 'disk list not readable', {}, ['Get-CimInstance Win32_LogicalDisk failed']);
      const pct = (d) => (d.size ? Math.round((100 * d.free) / d.size) : 0);
      const low = rows.filter((d) => d.size && pct(d) < DISK_FREE_WARN_PCT);
      const numbers = {};
      for (const d of rows) numbers[d.id] = pct(d);
      return result('machine.disk', true, rows.map((d) => d.id + ' ' + pct(d) + '% free').join(', ') || 'no fixed drives', numbers, low.map((d) => d.id + ' ' + pct(d) + '% free (under ' + DISK_FREE_WARN_PCT + '%) - review the cleanup suggestions'));
    },
    'machine.scratch': async () => {
      const list = await cleanupCandidates(deps);
      const mb = Math.round(list.reduce((a, c) => a + c.bytes, 0) / MB);
      const findings = list.slice(0, 40).map((c) => c.where + ': ' + path.basename(c.path) + ' (' + c.files + ' files) - ' + c.why);
      return result('machine.scratch', true, list.length + ' cleanup suggestion' + (list.length === 1 ? '' : 's') + ', ' + mb + ' MB; nothing deleted - choose in the cleanup list', { candidates: list.length, mb }, findings);
    },
  };
}

function cleanupCandidates(deps) {
  deps = deps || {};
  return clean.candidates({ repos: deps.repos || [], temp: deps.temp || os.tmpdir(), outside: deps.outside || [], untracked: deps.untracked, now: deps.now });
}

function applyCleanup(list, accept, opts) {
  return clean.applyCleanup(list, accept, opts);
}

const EXITED_CLOSE_MS = 3600 * 1000;
const IDLE_REPORT_MS = 12 * 3600 * 1000;
// Leak rule (provisional until a week of samples is measured): over at least LEAK_MIN_SPAN_H
// of samples, a least-squares slope at or above the limit with a fit r2 >= LEAK_R2.
const LEAK_MIN_SPAN_H = 1;
const LEAK_MIN_N = 12;
const LEAK_HEAP_MB_H = 10;
const LEAK_RSS_MB_H = 30;
const LEAK_R2 = 0.7;
const MB = 1048576;

function day(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function iso(now) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

// Least squares y = a + b x; returns {slope, r2}. x in hours, y in MB.
function fit(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, r2: 0 };
  let sx = 0; let sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  const mx = sx / n; const my = sy / n;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (const [x, y] of points) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (!sxx) return { slope: 0, r2: 0 };
  const slope = sxy / sxx;
  const r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, r2 };
}

// samples: [{t, rss, heapUsed}] (bytes, ms). Verdict over the whole series.
function leakVerdict(samples) {
  const s = Array.isArray(samples) ? samples.filter((x) => x && isFinite(x.t) && isFinite(x.rss) && isFinite(x.heapUsed)) : [];
  if (s.length < 2) return { leak: false, n: s.length, spanH: 0, heapMBh: 0, rssMBh: 0, enough: false };
  const t0 = s[0].t;
  const spanH = (s[s.length - 1].t - t0) / 3600000;
  const heap = fit(s.map((x) => [(x.t - t0) / 3600000, x.heapUsed / MB]));
  const rss = fit(s.map((x) => [(x.t - t0) / 3600000, x.rss / MB]));
  const enough = s.length >= LEAK_MIN_N && spanH >= LEAK_MIN_SPAN_H;
  const heapLeak = enough && heap.slope >= LEAK_HEAP_MB_H && heap.r2 >= LEAK_R2;
  const rssLeak = enough && rss.slope >= LEAK_RSS_MB_H && rss.r2 >= LEAK_R2;
  const r1 = (v) => Math.round(v * 10) / 10;
  return { leak: heapLeak || rssLeak, heapLeak, rssLeak, n: s.length, spanH: r1(spanH), heapMBh: r1(heap.slope), rssMBh: r1(rss.slope), heapR2: Math.round(heap.r2 * 100) / 100, rssR2: Math.round(rss.r2 * 100) / 100, enough };
}

// Samples process.memoryUsage() over the server's life (default every 60 s, 24 h kept).
class MemSampler {
  constructor(opts) {
    opts = opts || {};
    this.intervalMs = opts.intervalMs || 60000;
    this.max = opts.max || 1440;
    this.mem = opts.mem || (() => process.memoryUsage());
    this.now = opts.now || (() => Date.now());
    this.samples = [];
    this.timer = null;
  }
  sample() {
    const m = this.mem();
    this.samples.push({ t: this.now(), rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal });
    if (this.samples.length > this.max) this.samples.splice(0, this.samples.length - this.max);
    return this.samples[this.samples.length - 1];
  }
  start() {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
}

// Win32_Process rows {pid, ppid, name, created(ms)} through powershell (one call).
function listProcesses() {
  return new Promise((resolve) => {
    const ps = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $(if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } else { 0 }) }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000, maxBuffer: 16 * MB }, (err, out) => {
      if (err) return resolve(null);
      const rows = [];
      for (const ln of String(out).split(/\r?\n/)) {
        const m = /^(\d+)\|(\d+)\|([^|]*)\|(\d+)$/.exec(ln.trim());
        if (m) rows.push({ pid: +m[1], ppid: +m[2], name: m[3], created: +m[4] });
      }
      resolve(rows);
    });
  });
}

function killTree(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err));
  });
}

// Orphans: live processes whose parent is a pane process that has ended (recorded in
// pidLog) and that were created inside that pane's lifetime (pid-reuse guard), plus
// their live descendants. A parent pid that is alive again (reused) never matches.
function findOrphans(procs, pidLog) {
  if (!Array.isArray(procs)) return [];
  const alive = new Set(procs.map((p) => p.pid));
  const ended = new Map();
  for (const e of pidLog || []) if (e && e.endedAt && !alive.has(e.pid)) ended.set(e.pid, e);
  const roots = procs.filter((p) => {
    const e = ended.get(p.ppid);
    return e && p.created >= e.startedAt - 2000 && p.created <= e.endedAt + 2000;
  });
  const out = new Map(roots.map((p) => [p.pid, p]));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!out.has(p.pid) && out.has(p.ppid) && p.created >= out.get(p.ppid).created - 2000) { out.set(p.pid, p); grew = true; }
    }
  }
  return [...out.values()];
}

function result(id, ok, summary, numbers, findings, deleted) {
  return { id, ok: !!ok, summary: String(summary).slice(0, 300), numbers: numbers || {}, findings: (findings || []).slice(0, 40).map((f) => String(f).slice(0, 300)), deleted: deleted | 0 };
}

// The Console steps. deps: {panes, dropsDir, mem (MemSampler), pruneDrops, listProcesses, killTree, now}.
function coreRunners(deps) {
  const now = () => (deps.now ? deps.now() : Date.now());
  return {
    'console.drops': async () => {
      const old = drops.oldDropDirs(deps.dropsDir, now());
      const done = await (deps.pruneDrops || drops.pruneDrops)(deps.dropsDir, { now: now() });
      const miss = old.length - done.length;
      return result('console.drops', miss <= 0, done.length ? 'recycled ' + done.length + ' old drops day folder' + (done.length === 1 ? '' : 's') : 'no drops day folder over 14 days', { candidates: old.length, recycled: done.length }, miss > 0 ? [miss + ' day folder(s) not recycled'] : [], done.length);
    },
    'console.panes': async () => {
      const list = deps.panes ? [...deps.panes.panes.values()] : [];
      const t = now();
      const dead = list.filter((p) => p.state === 'exited' && p.exitedAt && t - p.exitedAt >= EXITED_CLOSE_MS);
      const exitedRecent = list.filter((p) => p.state === 'exited' && !dead.includes(p)).length;
      const idle = list.filter((p) => p.state !== 'exited' && p.state !== 'busy' && t - Math.max(p.lastActivity || 0, p.lastInput || 0, p.startedAt || 0) >= IDLE_REPORT_MS);
      for (const p of dead) deps.panes.close(p.id);
      const findings = idle.map((p) => 'pane "' + String(p.title).slice(0, 40) + '" idle ' + Math.round((t - Math.max(p.lastActivity || 0, p.lastInput || 0, p.startedAt || 0)) / 3600000) + ' h (left open)');
      return result('console.panes', true, list.length + ' panes: closed ' + dead.length + ' exited over 1 h, ' + exitedRecent + ' recently exited, ' + idle.length + ' idle over 12 h', { panes: list.length, closed: dead.length, exitedRecent, idle: idle.length }, findings, dead.length);
    },
    'console.orphans': async () => {
      const procs = await (deps.listProcesses || listProcesses)();
      if (!procs) return result('console.orphans', false, 'process list not readable', {}, ['Get-CimInstance Win32_Process failed']);
      const orphans = findOrphans(procs, deps.panes ? deps.panes.pidLog : []);
      const kill = deps.killTree || killTree;
      let ended = 0;
      let endedProcs = 0;
      let failed = 0;
      // Roots first (taskkill /T takes their descendants with them).
      const ids = new Set(orphans.map((o) => o.pid));
      const treeSize = (root) => { let n = 0; const seen = new Set([root]); let grew = true; while (grew) { grew = false; for (const o of orphans) if (!seen.has(o.pid) && seen.has(o.ppid)) { seen.add(o.pid); grew = true; } } n = seen.size; return n; };
      for (const o of orphans) {
        if (ids.has(o.ppid)) continue;
        if (await kill(o.pid)) { ended++; endedProcs += treeSize(o.pid); } else failed++;
      }
      const names = {};
      for (const o of orphans) names[o.name] = (names[o.name] || 0) + 1;
      const findings = orphans.length ? ['orphans: ' + Object.entries(names).map(([k, v]) => k + ' x' + v).join(', ')] : [];
      if (failed) findings.push(failed + ' orphan tree(s) could not be ended');
      return result('console.orphans', !failed, orphans.length ? 'ended ' + ended + ' orphan tree(s), ' + endedProcs + ' of ' + orphans.length + ' process(es)' : 'no orphaned processes', { orphans: orphans.length, ended, ended_procs: endedProcs, failed, names }, findings, endedProcs);
    },
    'console.memory': async () => {
      const m = deps.mem;
      const cur = m ? m.sample() : Object.assign({ t: now() }, process.memoryUsage());
      const v = leakVerdict(m ? m.samples : [cur]);
      const r = (b) => Math.round(b / MB);
      const findings = [];
      if (v.heapLeak) findings.push('heap grows ' + v.heapMBh + ' MB/h over ' + v.spanH + ' h (r2 ' + v.heapR2 + ') - possible leak; restart the server at a quiet moment');
      if (v.rssLeak) findings.push('RSS grows ' + v.rssMBh + ' MB/h over ' + v.spanH + ' h (r2 ' + v.rssR2 + ') - possible leak');
      const trend = v.enough ? 'heap ' + (v.heapMBh >= 0 ? '+' : '') + v.heapMBh + ' MB/h over ' + v.spanH + ' h' : 'trend needs ' + LEAK_MIN_SPAN_H + ' h of samples (have ' + v.spanH + ' h)';
      return result('console.memory', true, 'RSS ' + r(cur.rss) + ' MB, heap ' + r(cur.heapUsed) + ' MB; ' + trend, { rss_mb: r(cur.rss), heap_mb: r(cur.heapUsed), samples: v.n, span_h: v.spanH, heap_mb_h: v.heapMBh, rss_mb_h: v.rssMBh, leak: v.leak }, findings);
    },
    'console.scrollback': async () => {
      const list = deps.panes ? [...deps.panes.panes.values()] : [];
      const total = list.reduce((a, p) => a + (p.bufBytes || 0), 0);
      const top = list.reduce((a, p) => ((p.bufBytes || 0) > (a ? a.bufBytes : -1) ? p : a), null);
      const cap = deps.panes && deps.panes.cfg ? deps.panes.cfg.scrollbackBytes || 400000 : 400000;
      return result('console.scrollback', true, list.length + ' panes hold ' + Math.round(total / 1024) + ' KB of scrollback (cap ' + Math.round(cap / 1024) + ' KB each)', { panes: list.length, total_kb: Math.round(total / 1024), max_kb: top ? Math.round(top.bufBytes / 1024) : 0, cap_kb: Math.round(cap / 1024) }, []);
    },
  };
}

// Suite gate (machine-wide suite slots): a live holder of a machine-wide slot lock = a suite runs.
function suiteHolders(dir) {
  if (!dir) return 0; // no machine-wide suite gate unless a slot dir is given
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^slot-\d+\.lock$/.test(n)); } catch (e) { return 0; }
  let n = 0;
  for (const f of names) {
    let pid = 0;
    try { pid = +JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).pid; } catch (e) { pid = 0; }
    if (!pid) { n++; continue; } // unreadable lock: count it (fail safe: refuse)
    try { process.kill(pid, 0); n++; } catch (e) { if (e.code === 'EPERM') n++; }
  }
  return n;
}

class HealthRunner {
  // opts: {core: runners map, plugins: [{name, steps(): meta[], plan(): Promise<meta[]>, run(id, timeoutMs)}],
  //        busy: () => reason|null, suiteHolders: () => n, reportDir, progressFile, now, onChange,
  //        steps: meta list for the core runners (default CORE_STEPS)}
  constructor(opts) {
    this.core = opts.core || {};
    this.steps = opts.steps || CORE_STEPS;
    this.plugins = (opts.plugins || []).filter(Boolean);
    this.busyFn = opts.busy || (() => null);
    this.suiteFn = opts.suiteHolders || (() => suiteHolders());
    this.reportDir = opts.reportDir;
    this.progressFile = opts.progressFile;
    this.now = opts.now || (() => Date.now());
    this.onChange = opts.onChange || (() => {});
    this.current = null;
    this.last = null;
    this.seq = 0;
  }

  // The allowlist: core ids plus each plugin's FIXED id list. Never built from input.
  allowlist() {
    const ids = this.steps.map((s) => s.id).filter((id) => this.core[id]);
    for (const p of this.plugins) for (const id of p.ids) if (!ids.includes(id)) ids.push(id);
    return ids;
  }

  async plan() {
    const steps = this.steps.filter((s) => this.core[s.id]).map((s) => Object.assign({}, s));
    for (const p of this.plugins) {
      let meta = [];
      try { meta = await p.plan(); } catch (e) { meta = []; }
      for (const id of p.ids) {
        const m = meta.find((x) => x && x.id === id);
        if (m) steps.push(m);
      }
    }
    const last = this.lastDurations();
    for (const s of steps) if (last[s.id] && !s.llm) s.eta_s = Math.max(1, Math.round(last[s.id]));
    return steps;
  }

  // Measured durations of the newest report (an ETA beats a guess).
  lastDurations() {
    const out = {};
    const r = this.last || this.readLast();
    if (r && Array.isArray(r.steps)) for (const s of r.steps) if (s.startedAt && s.endedAt && s.status === 'done') out[s.id] = (s.endedAt - s.startedAt) / 1000;
    return out;
  }

  readLast() {
    if (!this.reportDir) return null;
    try {
      const files = fs.readdirSync(this.reportDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      if (!files.length) return null;
      const doc = JSON.parse(fs.readFileSync(path.join(this.reportDir, files[files.length - 1]), 'utf8'));
      const runs = Array.isArray(doc.runs) ? doc.runs : [];
      return runs[runs.length - 1] || null;
    } catch (e) { return null; }
  }

  state() {
    return { running: this.current, last: this.last || this.readLast() };
  }

  // Validate and start. Returns {status, error?, run?}; the run continues in the background.
  async start(ids) {
    if (!Array.isArray(ids) || !ids.length) return { status: 400, error: 'choose at least one step' };
    if (ids.length > 50 || ids.some((x) => typeof x !== 'string')) return { status: 400, error: 'bad step list' };
    const allow = this.allowlist();
    const unknown = ids.filter((x) => !allow.includes(x));
    if (unknown.length) return { status: 400, error: 'unknown step ' + unknown[0].slice(0, 40) };
    if (this.current) return { status: 409, error: 'a health check is already running (started ' + Math.round((this.now() - this.current.startedAt) / 1000) + ' s ago)' };
    const refusal = () => {
      const busy = this.busyFn();
      if (busy) return { status: 409, error: busy };
      const holders = this.suiteFn();
      if (holders) return { status: 409, error: 'a test suite is running (' + holders + ' suite slot' + (holders === 1 ? '' : 's') + ' held); run the health check when it ends' };
      return null;
    };
    let no = refusal();
    if (no) return no;
    const plan = await this.plan();
    // The plan can take seconds (a plugin child): every check again, with no await
    // between them and taking the run.
    if (this.current) return { status: 409, error: 'a health check is already running' };
    no = refusal();
    if (no) return no;
    const chosen = allow.filter((id) => ids.includes(id)); // allowlist order, deduped
    const run = {
      id: ++this.seq, startedAt: this.now(), endedAt: null, status: 'running', reportFile: null,
      steps: chosen.map((id) => {
        const m = plan.find((s) => s.id === id) || { id, group: '?', label: id, eta_s: 30 };
        return { id, group: m.group, label: m.label, eta_s: m.eta_s, timeout_s: m.timeout_s || null, deletes: m.deletes || null, status: 'pending', startedAt: null, endedAt: null, result: null };
      }),
    };
    this.current = run;
    this.progress();
    this.onChange(this.state());
    this.execute(run).catch(() => {});
    return { status: 202, run };
  }

  async execute(run) {
    for (const s of run.steps) {
      if (this.current !== run) return; // aborted (server closing)
      s.status = 'running';
      s.startedAt = this.now();
      this.progress();
      this.onChange(this.state());
      let r;
      try {
        r = await this.runOne(s);
      } catch (e) {
        r = result(s.id, false, 'step crashed: ' + (e && e.message ? e.message : e), {}, []);
      }
      if (this.current !== run) return;
      s.result = r;
      s.endedAt = this.now();
      s.status = r && r.ok ? 'done' : 'failed';
      this.progress();
      this.onChange(this.state());
    }
    run.endedAt = this.now();
    run.status = run.steps.every((s) => s.status === 'done') ? 'done' : 'failed';
    run.findings = run.steps.reduce((a, s) => a + ((s.result && s.result.findings) || []).length, 0);
    run.deleted = run.steps.reduce((a, s) => a + ((s.result && s.result.deleted) || 0), 0);
    run.reportFile = this.saveReport(run);
    this.current = null;
    this.last = run;
    this.progress(run);
    this.onChange(this.state());
  }

  runOne(s) {
    // Kill at 3x the ETA, never below the step's own floor (a plugin
    // step's work - gc, a headless run - has its own limit that a measured ETA must
    // not undercut).
    const timeoutMs = Math.max(60, (s.eta_s || 30) * 3, s.timeout_s || 0) * 1000;
    if (this.core[s.id]) {
      return Promise.race([this.core[s.id](), new Promise((resolve) => { const t = setTimeout(() => resolve(result(s.id, false, 'timed out after ' + Math.round(timeoutMs / 1000) + ' s', {}, ['step timed out'])), timeoutMs); if (t.unref) t.unref(); })]);
    }
    const p = this.plugins.find((x) => x.ids.includes(s.id));
    return p.run(s.id, timeoutMs);
  }

  saveReport(run) {
    if (!this.reportDir) return null;
    const file = path.join(this.reportDir, day(run.startedAt) + '.json');
    try {
      let doc = { runs: [] };
      try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { doc = { runs: [] }; }
      if (!Array.isArray(doc.runs)) doc.runs = [];
      doc.runs.push(Object.assign({ startedAtIso: iso(run.startedAt) }, run, { reportFile: undefined }));
      doc.runs = doc.runs.slice(-50);
      writeJson(file, doc);
      return file;
    } catch (e) { return null; }
  }

  // Server shutdown mid-run: the run ends as failed (report + progress), never left
  // reading "running".
  abort(reason) {
    const run = this.current;
    if (!run) return;
    for (const s of run.steps) {
      if (s.status === 'pending' || s.status === 'running') {
        s.status = 'failed';
        s.endedAt = this.now();
        s.result = s.result || result(s.id, false, reason, {}, [reason]);
      }
    }
    run.endedAt = this.now();
    run.status = 'failed';
    run.findings = run.steps.reduce((a, s) => a + ((s.result && s.result.findings) || []).length, 0);
    run.deleted = run.steps.reduce((a, s) => a + ((s.result && s.result.deleted) || 0), 0);
    run.reportFile = this.saveReport(run);
    this.current = null;
    this.last = run;
    this.progress(run);
  }

  // Progress file, remaining steps as its checklist.
  progress(done) {
    if (!this.progressFile) return;
    const run = done || this.current;
    if (!run) return;
    const total = run.steps.reduce((a, s) => a + (s.eta_s || 1), 0) || 1;
    const fin = run.steps.filter((s) => s.status === 'done' || s.status === 'failed');
    const doneEta = fin.reduce((a, s) => a + (s.eta_s || 1), 0);
    const cur = run.steps.find((s) => s.status === 'running');
    const remaining = run.steps.filter((s) => s.status === 'pending' || s.status === 'running');
    const doc = {
      task: 'health-check',
      pct: done ? 100 : Math.min(99, Math.round((doneEta / total) * 100)),
      step: done ? 'done: ' + (run.findings || 0) + ' findings' : cur ? cur.label : 'starting',
      eta_s: done ? 0 : remaining.reduce((a, s) => a + (s.eta_s || 1), 0),
      status: done ? (run.status === 'done' ? 'done' : 'failed') : 'running',
      updated: iso(this.now()),
      checklist: remaining.map((s) => ({ id: s.id.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 16), task: s.label.slice(0, 80), state: s.status === 'running' ? 'running' : 'pending', eta_s: s.eta_s || 0 })),
    };
    try { writeJson(this.progressFile, doc); } catch (e) { /* progress is best effort */ }
  }
}

module.exports = { CORE_STEPS, MACHINE_STEPS, machineRunners, cleanupCandidates, applyCleanup, tempCensus: clean.tempCensus, listDisks, HealthRunner, MemSampler, coreRunners, leakVerdict, fit, findOrphans, suiteHolders, listProcesses, killTree, result, day, EXITED_CLOSE_MS, IDLE_REPORT_MS };
