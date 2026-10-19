'use strict';
// CON-RES: the top-bar resource readout (CPU RAM GPU C: D: E: F: NET), with Task
// Manager > Performance semantics:
//   CPU  = \Processor Information(_Total)\% Processor Utility (capped at 100)
//   RAM  = (total - available) / total physical (os module, no process)
//   GPU  = busiest engine of the busiest GPU (GPU Engine counters, summed per engine)
//   C..F = disk active time (100 - PhysicalDisk % Idle Time); capacity used in the
//          tooltip comes from fs.statfsSync; a letter is listed only when it exists
//   NET  = (rx + tx) bits/s as percent of link speed, busiest adapter with a link
// One long-lived powershell.exe (server/resources.ps1) streams one JSON line per
// ~1.1 s sample; it runs only while a page is connected (stops idleStopSec after
// the last one leaves), restarts with a backoff when it dies and is killed on
// close. Every metric fails soft to null ('--' in the page). The snapshot holds
// numbers and drive letters only: never a machine, adapter or GPU name.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LETTERS = ['C', 'D', 'E', 'F'];
const SCRIPT = path.join(__dirname, 'resources.ps1');

function resConfig(cfg) {
  const r = (cfg && cfg.resources) || {};
  const num = (v, d, lo, hi) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
  return {
    enabled: r.enabled !== false,
    powershell: typeof r.powershell === 'string' && r.powershell ? r.powershell : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    tickMs: num(r.tickMs, 1000, 100, 60000),
    idleStopSec: num(r.idleStopSec, 30, 1, 86400),
    staleSec: num(r.staleSec, 8, 1, 600),
    capacitySec: num(r.capacitySec, 30, 1, 3600),
  };
}

const pct = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(Math.max(0, Math.min(100, v))) : null);
const nonneg = (v) => (typeof v === 'number' && isFinite(v) && v >= 0 ? v : null);

// Parse one sampler line into counter values; anything malformed is null.
function parseLine(line) {
  let j;
  try { j = JSON.parse(String(line)); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const disks = {};
  if (Array.isArray(j.disks)) {
    for (const d of j.disks) {
      if (!d || typeof d.l !== 'string') continue;
      const a = pct(d.a);
      for (const ch of d.l.toUpperCase()) if (/^[A-Z]$/.test(ch)) disks[ch] = a;
    }
  }
  let net = null;
  if (j.net && typeof j.net === 'object') {
    net = { pct: pct(j.net.pct), rx: nonneg(j.net.rx), tx: nonneg(j.net.tx), bw: nonneg(j.net.bw) };
  }
  return { cpu: pct(j.cpu), gpu: pct(j.gpu), disks, net };
}

function ramPct(osm) {
  const total = osm.totalmem();
  const free = osm.freemem();
  if (!(total > 0) || !(free >= 0)) return null;
  return pct(((total - free) / total) * 100);
}

// Capacity used per existing letter; a letter whose statfs fails (no volume, no
// media) does not exist for the readout.
function capacities(statfs, letters) {
  const out = {};
  for (const l of letters) {
    try {
      const s = statfs(l + ':\\');
      const total = s.blocks * s.bsize;
      const avail = s.bavail * s.bsize;
      out[l] = total > 0 ? { used: pct(((total - avail) / total) * 100), totalBytes: total, freeBytes: avail } : { used: null, totalBytes: null, freeBytes: null };
    } catch (e) { /* letter absent */ }
  }
  return out;
}

class ResourceSampler {
  constructor(cfg, opts) {
    opts = opts || {};
    this.rc = resConfig(cfg);
    this.enabled = this.rc.enabled && opts.enabled !== false;
    this.spawn = opts.spawn || spawn;
    this.os = opts.os || os;
    this.statfs = opts.statfs || (fs.statfsSync ? (p) => fs.statfsSync(p) : () => { throw new Error('no statfs'); });
    this.now = opts.now || Date.now;
    this.viewers = opts.viewers || (() => 0);
    this.onSnap = opts.onSnap || (() => {});
    this.parentPid = opts.parentPid || process.pid;
    this.child = null;
    this.buf = '';
    this.last = null; // last parsed counter line
    this.lastAt = 0;
    this.lastViewer = 0;
    this.caps = null;
    this.capsAt = 0;
    this.deaths = 0;
    this.nextSpawnAt = 0;
    this.timer = null;
    this.snap = this.build();
  }

  touch() { this.lastViewer = this.now(); }

  wanted() {
    const t = this.now();
    if (this.viewers() > 0) this.lastViewer = t;
    return this.lastViewer > 0 && t - this.lastViewer < this.rc.idleStopSec * 1000;
  }

  startChild() {
    if (this.child || this.now() < this.nextSpawnAt) return;
    let ch;
    try {
      ch = this.spawn(this.rc.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-ParentPid', String(this.parentPid)], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      this.died();
      return;
    }
    this.child = ch;
    this.buf = '';
    if (ch.stdout) {
      if (ch.stdout.setEncoding) ch.stdout.setEncoding('utf8');
      ch.stdout.on('data', (d) => this.onData(d));
    }
    const gone = () => { if (this.child === ch) { this.child = null; this.died(); } };
    ch.on('exit', gone);
    ch.on('error', gone);
  }

  died() {
    this.deaths = Math.min(this.deaths + 1, 6);
    this.nextSpawnAt = this.now() + Math.min(60000, 1000 * Math.pow(2, this.deaths));
  }

  stopChild() {
    const ch = this.child;
    this.child = null;
    if (ch) { try { ch.kill(); } catch (e) { /* gone */ } }
  }

  onData(d) {
    this.buf += String(d);
    if (this.buf.length > 65536) this.buf = this.buf.slice(-8192);
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const p = parseLine(line);
      if (!p) continue;
      this.last = p;
      this.lastAt = this.now();
      this.deaths = 0;
      this.publish();
    }
  }

  build() {
    const t = this.now();
    const fresh = this.last && t - this.lastAt < this.rc.staleSec * 1000 ? this.last : null;
    if (!this.caps || t - this.capsAt >= this.rc.capacitySec * 1000) {
      this.caps = capacities(this.statfs, LETTERS);
      this.capsAt = t;
    }
    let ram = null;
    let ramTotal = null;
    try { ram = ramPct(this.os); ramTotal = this.os.totalmem(); } catch (e) { /* null */ }
    const drives = [];
    for (const l of LETTERS) {
      const c = this.caps[l];
      if (!c) continue;
      drives.push({ letter: l, active: fresh && l in fresh.disks ? fresh.disks[l] : null, used: c.used, totalBytes: c.totalBytes, freeBytes: c.freeBytes });
    }
    return {
      at: t,
      live: !!fresh,
      cpu: fresh ? fresh.cpu : null,
      ram,
      ramTotalBytes: ramTotal,
      gpu: fresh ? fresh.gpu : null,
      drives,
      net: fresh && fresh.net ? fresh.net : null,
    };
  }

  publish() {
    this.snap = this.build();
    this.onSnap(this.snap);
  }

  tick() {
    if (!this.enabled) return;
    if (this.wanted()) {
      this.startChild();
      // RAM (and the '--' fall-back when the sampler is stale) without the child
      if (!this.last || this.now() - this.lastAt >= this.rc.staleSec * 1000) this.publish();
    } else if (this.child) {
      this.stopChild();
    }
  }

  publicSnap() { this.snap = this.build(); return this.snap; }

  start() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.tick(), this.rc.tickMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopChild();
  }
}

module.exports = { ResourceSampler, parseLine, capacities, ramPct, resConfig, LETTERS, SCRIPT };
