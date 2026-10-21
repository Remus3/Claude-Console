'use strict';
// CON-GATE-PANEL: the status panel's tracker panel. One
// collapsible panel inside the status panel; each tracker is a block with a one-line
// summary and a few rows, and has its own show/hide toggle in Settings (uiprefs
// "trackers"). GET /api/trackers returns { at, order, titles, trackers: { id: {summary,
// rows: [{text, cls}], state} } } - numbers, task names, tree names and short labels
// only: never a user name, email, account / session id, URL, key or token.
//
// Generic trackers (every build): tasks (scheduled tasks the console's projects own, plus
// quiet-window pauses) and machine (free disk, commit used vs limit, CPU, each with a
// short history for a sparkline). The fleet trackers (gate, headless, notes, kit, locks,
// worktrees, route, usage, lanes, stalls) live in server/trackers-fleet.js, which the
// public build leaves out (module:fleet).
const fs = require('fs');
const os = require('os');

// The 12 trackers, in panel order (ids also key Settings > Trackers and uiprefs).
const TRACKERS = Object.freeze([
  ['gate', 'Suite gate'],
  ['tasks', 'Scheduled tasks'],
  ['headless', 'Headless runs'],
  ['notes', 'Notes and inbox'],
  ['kit', 'Kit rollout'],
  ['locks', 'Git locks and claims'],
  ['worktrees', 'Worktrees'],
  ['machine', 'Machine'],
  ['route', 'Headless route'],
  ['usage', 'Usage and quota'],
  ['lanes', 'Lanes'],
  ['stalls', 'Stalled progress'],
]);
const TRACKER_IDS = TRACKERS.map((t) => t[0]);
const GENERIC = ['tasks', 'machine'];
const HISTORY = 30;
const BENIGN = new Set([0, 267009, 267011, 2147946720]); // CLAUDE.md machine facts

let FLEET = null;

function sanitizeTrackers(v) {
  const s = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const id of TRACKER_IDS) out[id] = typeof s[id] === 'boolean' ? s[id] : true;
  return out;
}

function clip(s, n) {
  return String(s === null || s === undefined ? '' : s).replace(/[^\x20-\x7e]/g, '').slice(0, n);
}
function push(ring, v) {
  ring.push(typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null);
  while (ring.length > HISTORY) ring.shift();
}
function cpuTimes(osm) {
  let idle = 0;
  let total = 0;
  for (const c of osm.cpus() || []) {
    const t = c.times || {};
    idle += t.idle || 0;
    total += (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.idle || 0) + (t.irq || 0);
  }
  return { idle, total };
}
function fmtGB(mb) {
  return (mb / 1024).toFixed(mb >= 102400 ? 0 : 1) + ' GB';
}
function clock12(ms) {
  const t = new Date(ms);
  const h = t.getHours();
  return (h % 12 || 12) + ':' + String(t.getMinutes()).padStart(2, '0') + (h < 12 ? 'AM' : 'PM');
}

// Scheduled tasks the console's projects own (owner set), Maint-* included; quiet-window
// pause / restore tasks named *Quiet* are listed as pauses.
function tasksTracker(list, now) {
  if (!list || !list.available) return { summary: 'task list not available', rows: [], state: 'unknown' };
  const own = list.tasks.filter((t) => t.owner || /^Maint-/i.test(t.name) || /quiet/i.test(t.name));
  const failing = own.filter((t) => t.lastResult !== null && t.lastResult !== undefined && !BENIGN.has(Number(t.lastResult)));
  const disabled = own.filter((t) => !t.enabled);
  const quiet = own.filter((t) => /quiet/i.test(t.name) && t.enabled);
  const rows = [];
  for (const t of failing) rows.push({ text: clip(t.name, 48) + ': last run ' + clip(t.result && t.result.text, 40), cls: 'bad' });
  for (const t of quiet) rows.push({ text: clip(t.name, 48) + ': quiet-window pause' + (t.nextRun ? ', next ' + clock12(Date.parse(t.nextRun)) : ''), cls: 'warn' });
  for (const t of disabled) if (!failing.includes(t)) rows.push({ text: clip(t.name, 48) + ': disabled', cls: 'muted' });
  const next = own.filter((t) => t.enabled && t.nextRun && Date.parse(t.nextRun) > now).sort((a, b) => Date.parse(a.nextRun) - Date.parse(b.nextRun)).slice(0, 3);
  for (const t of next) rows.push({ text: clip(t.name, 48) + ': next ' + clock12(Date.parse(t.nextRun)) });
  return {
    summary: own.length + ' task' + (own.length === 1 ? '' : 's') + ', ' + failing.length + ' failing' + (disabled.length ? ', ' + disabled.length + ' disabled' : '') + (quiet.length ? ', quiet window armed' : ''),
    rows: rows.slice(0, 10),
    state: failing.length ? 'failed' : quiet.length ? 'warn' : 'ok',
  };
}

// Commit charge (Win32_OperatingSystem, KB) - one PowerShell call, cached by the service.
const PS_COMMIT = "$o = Get-CimInstance Win32_OperatingSystem; '' + $o.TotalVirtualMemorySize + ' ' + $o.FreeVirtualMemory";
function parseCommit(stdout) {
  const m = /(\d+)\s+(\d+)/.exec(String(stdout || ''));
  if (!m) return null;
  const limit = parseInt(m[1], 10) / 1024;
  const free = parseInt(m[2], 10) / 1024;
  return limit > 0 ? { limitMb: limit, usedMb: Math.max(0, limit - free) } : null;
}

class TrackerService {
  // opts: { cfg, projects: () => [...], status: () => snapshot, scheduler, runner, env,
  //         os, statfs, now, gateDir, fleet (module override, tests), kitFiles, routeFile }
  constructor(opts) {
    opts = opts || {};
    this.cfg = opts.cfg || {};
    this.projectsFn = opts.projects || (() => []);
    this.statusFn = opts.status || (() => ({ projects: [] }));
    this.scheduler = opts.scheduler || null;
    this.runner = opts.runner || null;
    this.env = opts.env || process.env;
    this.os = opts.os || os;
    this.statfs = opts.statfs || fs.statfsSync;
    this.now = opts.now || (() => Date.now());
    this.fleet = opts.fleet !== undefined ? opts.fleet : FLEET;
    const tc = this.cfg.trackers || {};
    this.gateDir = opts.gateDir || (typeof tc.gateDir === 'string' && tc.gateDir) || (this.fleet ? this.fleet.gateDir(this.env) : null);
    // file locations of the fleet sources come from the fleet module itself
    const fd = this.fleet && typeof this.fleet.defaults === 'function' ? this.fleet.defaults(this.cfg) : {};
    this.kitFiles = opts.kitFiles || fd.kitFiles || [];
    this.routeFile = opts.routeFile || (typeof tc.routeFile === 'string' && tc.routeFile) || fd.routeFile || null;
    this.queueFile = opts.queueFile || (typeof tc.queueFile === 'string' && tc.queueFile) || fd.queueFile || null;
    this.probe = opts.probe || null;
    this.hist = { cpu: [], commit: [], disk: {} };
    this.lastCpu = null;
    this.cache = { tasks: null, tasksAt: 0, commit: null, commitAt: 0, procs: null, procsAt: 0, procsKey: '', base: undefined, baseAt: 0 };
    this.snap = { at: 0, order: TRACKER_IDS.slice(), titles: Object.fromEntries(TRACKERS), trackers: {} };
    this.busy = null;
    this.timer = null;
  }

  ids() {
    return this.fleet ? TRACKER_IDS.slice() : GENERIC.slice();
  }

  async sampleMachine(now) {
    const t = cpuTimes(this.os);
    if (this.lastCpu && t.total > this.lastCpu.total) push(this.hist.cpu, 100 * (1 - (t.idle - this.lastCpu.idle) / (t.total - this.lastCpu.total)));
    this.lastCpu = t;
    if (this.runner && now - this.cache.commitAt > 30000) {
      this.cache.commitAt = now;
      try {
        const r = await this.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_COMMIT], { timeoutMs: 20000 });
        this.cache.commit = r.code === 0 ? parseCommit(r.stdout) : null;
      } catch (e) { this.cache.commit = null; }
    }
    const c = this.cache.commit;
    push(this.hist.commit, c ? (100 * c.usedMb) / c.limitMb : null);
    const rows = [];
    for (const L of ['C', 'D', 'E', 'F']) {
      let st = null;
      try { st = this.statfs(L + ':\\'); } catch (e) { st = null; }
      if (!st || !st.blocks) continue;
      const freeMb = (Number(st.bavail) * Number(st.bsize)) / 1048576;
      const totMb = (Number(st.blocks) * Number(st.bsize)) / 1048576;
      if (!this.hist.disk[L]) this.hist.disk[L] = [];
      push(this.hist.disk[L], totMb > 0 ? (100 * (totMb - freeMb)) / totMb : null);
      rows.push({ text: L + ': ' + fmtGB(freeMb) + ' free of ' + fmtGB(totMb), spark: this.hist.disk[L].slice(), cls: totMb > 0 && freeMb / totMb < 0.1 ? 'warn' : '' });
    }
    const cpu = this.hist.cpu[this.hist.cpu.length - 1];
    rows.unshift({ text: 'commit ' + (c ? fmtGB(c.usedMb) + ' of ' + fmtGB(c.limitMb) : '--'), spark: this.hist.commit.slice(), cls: c && c.usedMb / c.limitMb > 0.9 ? 'warn' : '' });
    rows.unshift({ text: 'CPU ' + (typeof cpu === 'number' ? Math.round(cpu) + '%' : '--'), spark: this.hist.cpu.slice() });
    return { summary: 'CPU ' + (typeof cpu === 'number' ? Math.round(cpu) + '%' : '--') + ', commit ' + (c ? Math.round((100 * c.usedMb) / c.limitMb) + '%' : '--'), rows, state: c && c.usedMb / c.limitMb > 0.9 ? 'warn' : 'ok' };
  }

  async tasks(now) {
    if (!this.scheduler || !this.scheduler.available) return { summary: 'scheduler not available', rows: [], state: 'unknown' };
    if (!this.cache.tasks || now - this.cache.tasksAt > 120000) {
      this.cache.tasksAt = now;
      try { this.cache.tasks = await this.scheduler.list(); } catch (e) { this.cache.tasks = null; }
    }
    return tasksTracker(this.cache.tasks, now);
  }

  // Live processes, only while the gate has a holder or a ticket (one CIM call, 10 s cache).
  async procs(state, now) {
    const pids = [].concat((state.slots || []).map((s) => s.rec && s.rec.pid), (state.tickets || []).map((t) => t.rec && t.rec.pid)).filter(Number.isInteger);
    if (!pids.length) return new Map();
    const key = pids.sort().join(',');
    if (this.cache.procs && this.cache.procsKey === key && now - this.cache.procsAt < 10000) return this.cache.procs;
    let m = null;
    if (this.runner) {
      try {
        const r = await this.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', this.fleet.PS_PROCS], { timeoutMs: 30000 });
        m = r.code === 0 ? this.fleet.parseProcs(r.stdout) : null;
      } catch (e) { m = null; }
    }
    if (!m) {
      // No process list (no runner, or the call failed): liveness only, no command lines,
      // so a record without KIT-GATE-WHO fields shows '(unknown tree)'.
      m = new Map();
      for (const pid of pids) {
        let live = false;
        try { process.kill(pid, 0); live = true; } catch (e) { live = e.code === 'EPERM'; }
        if (live) m.set(pid, { cmd: '', parent: null });
      }
    }
    this.cache.procs = m;
    this.cache.procsKey = key;
    this.cache.procsAt = now;
    return this.cache.procs;
  }

  // CLAUDE_HEADLESS_BASE_URL: the user variable (registry) first, then this process env.
  async baseUrl(now) {
    if (this.cache.base !== undefined && now - this.cache.baseAt < 60000) return this.cache.base;
    let v = null;
    if (this.runner) {
      try {
        const r = await this.runner('reg.exe', ['query', 'HKCU\\Environment', '/v', 'CLAUDE_HEADLESS_BASE_URL'], { timeoutMs: 10000 });
        const m = r.code === 0 ? /CLAUDE_HEADLESS_BASE_URL\s+REG_\w+\s+(\S.*)$/m.exec(r.stdout) : null;
        v = m ? m[1].trim() : null;
      } catch (e) { v = null; }
    }
    if (!v && this.env.CLAUDE_HEADLESS_BASE_URL) v = this.env.CLAUDE_HEADLESS_BASE_URL;
    this.cache.base = v || null;
    this.cache.baseAt = now;
    return this.cache.base;
  }

  async refresh(want) {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      const now = this.now();
      const on = sanitizeTrackers(want);
      const ids = this.ids().filter((id) => on[id]);
      const snap = this.statusFn() || { projects: [] };
      const projects = (this.projectsFn() || []).filter((p) => p && p.dir && !p.retired);
      const out = {};
      const F = this.fleet;
      const safe = async (id, fn) => {
        try { out[id] = await fn(); } catch (e) { out[id] = { summary: 'unreadable', rows: [], state: 'unknown' }; }
      };
      for (const id of ids) {
        if (id === 'machine') await safe(id, () => this.sampleMachine(now));
        else if (id === 'tasks') await safe(id, () => this.tasks(now));
        else if (!F) continue;
        else if (id === 'gate') {
          await safe(id, async () => {
            const st = this.gateDir ? F.readGateState(this.gateDir, this.env) : null;
            if (!st) return { summary: 'gate directory not found', rows: [], state: 'unknown', gate: null };
            const g = F.gateModel(st, await this.procs(st, now), projects, now);
            return { summary: g.summary, rows: [], state: g.quiet ? 'warn' : g.slots.length ? 'running' : 'idle', gate: g };
          });
        } else if (id === 'headless') await safe(id, () => F.headlessTracker(snap));
        else if (id === 'notes') await safe(id, () => F.notesTracker(projects, snap, F.outboundCap(this.kitFiles), now));
        else if (id === 'kit') await safe(id, () => F.kitTracker(snap, this.queueFile, now));
        else if (id === 'locks') await safe(id, () => F.locksTracker(projects, (pid) => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }));
        else if (id === 'worktrees') await safe(id, () => F.worktreesTracker(projects, now, 24));
        else if (id === 'route') await safe(id, async () => F.routeTracker(this.routeFile, await this.baseUrl(now), this.probe));
        else if (id === 'usage') await safe(id, () => F.usageTracker(snap));
        else if (id === 'lanes') await safe(id, () => F.lanesTracker(snap));
        else if (id === 'stalls') await safe(id, () => F.stallsTracker(snap));
      }
      this.snap = { at: now, order: this.ids(), titles: Object.fromEntries(TRACKERS), trackers: out };
      return this.snap;
    })();
    try { return await this.busy; } finally { this.busy = null; }
  }
}

module.exports = { TRACKERS, TRACKER_IDS, GENERIC, sanitizeTrackers, tasksTracker, parseCommit, TrackerService, PS_COMMIT };
