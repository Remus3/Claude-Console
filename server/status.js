'use strict';
// Read-only status readers. Nothing in this file writes to any project tree.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { resolveBoard, readBoardsFile } = require('./boards');

const MAX_STR = 400;

function clip(s, n) {
  if (s === null || s === undefined) return s;
  s = String(s);
  n = n || MAX_STR;
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch (e) {
    return null;
  }
}

function readText(p, maxBytes) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(maxBytes || 65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.slice(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
}

// ---------- headless runs ----------
// A repo's headless work is visible through two files of the headless spawn helper, both only read here:
// the live status file the spawn helper rewrites on every run (state running / idle /
// halted ...), and the repo lane locks (<i>.lock, JSON with the holder pid) that exist
// while a lane runs. A lock whose pid is gone is a leftover, not a running lane.
const HEADLESS_STATUS_REL = path.join('ops', 'loop', 'control', 'inbox_status.json');
const LANES_REL = path.join('ops', 'loop', 'control', 'lanes');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readHeadless(project, opts) {
  const now = (opts && opts.now) || Date.now();
  const alive = (opts && opts.pidAlive) || pidAlive;
  let st = null;
  const raw = readText(path.join(project.dir, HEADLESS_STATUS_REL), 16384);
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j && typeof j === 'object') {
        const updated = Date.parse(j.updated);
        const eta = Number.isFinite(+j.task_eta_s) && j.task_eta_s !== null ? +j.task_eta_s : null;
        st = {
          state: clip(j.state, 20) || null,
          task: clip(j.task, 40) || null,
          updated: Number.isFinite(updated) ? updated : null,
          runs: Number.isFinite(+j.runs_in_window) ? +j.runs_in_window : null,
          cap: Number.isFinite(+j.runs_cap) ? +j.runs_cap : null,
          eta_s: eta,
        };
        // A "running" file that stopped updating (crashed run) is not a live run.
        const freshFor = Math.max(2 * (eta || 0) * 1000, 30 * 60 * 1000);
        st.running = st.state === 'running' && st.updated !== null && now - st.updated <= freshFor;
      }
    } catch (e) { st = null; }
  }
  const lanes = [];
  let names = [];
  try { names = fs.readdirSync(path.join(project.dir, LANES_REL)).filter((n) => /^\d+\.lock$/.test(n)); } catch (e) { names = []; }
  for (const n of names.sort()) {
    const f = path.join(project.dir, LANES_REL, n);
    let rec = {};
    try { rec = JSON.parse(readText(f, 8192) || '{}') || {}; } catch (e) { rec = {}; }
    const live = alive(rec.pid) || alive(rec.holder_pid);
    if (live) lanes.push({ index: parseInt(n, 10), lane: clip(rec.lane, 40) || null });
  }
  if (!st && !lanes.length) return null;
  return {
    active: !!(st && st.running) || lanes.length > 0,
    state: st ? st.state : null,
    task: st ? st.task : null,
    runs: st ? st.runs : null,
    cap: st ? st.cap : null,
    updated: st ? st.updated : null,
    lanes,
  };
}

// ---------- hand-off ----------
function findHandoffFile(project) {
  let names = [];
  try {
    names = fs.readdirSync(project.dir).filter((n) => /-NEXT-SESSION\.txt$/i.test(n));
  } catch (e) {
    names = [];
  }
  if (names.length) {
    const pref = project.code ? names.find((n) => n.toUpperCase().startsWith(project.code.toUpperCase() + '-')) : null;
    return path.join(project.dir, pref || names.sort()[0]);
  }
  if (project.handoffFallback) {
    const p = path.join(project.dir, project.handoffFallback);
    if (statSafe(p)) return p;
  }
  return null;
}

function parseHandoff(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  let session = null;
  for (const l of lines.slice(0, 40)) {
    const m = /^\s*SESSION:\s*(\d+)/i.exec(l);
    if (m) {
      session = parseInt(m[1], 10);
      break;
    }
  }
  const head = lines.filter((l) => !/^\s*SESSION:/i.test(l)).slice(0, 6).map((l) => clip(l, 200));
  // "NEXT ACTION" block: the heading line plus a few following non-empty lines.
  let nextAction = null;
  // Heading forms seen in the fleet: "THE SINGLE NEXT ACTION" on its own line, or "Next action: ...".
  let idx = lines.findIndex((l) => /^\s*(THE\s+SINGLE\s+)?NEXT\s+ACTION\s*:?\s*$/i.test(l));
  if (idx < 0) idx = lines.findIndex((l) => /^\s*next\s+action\s*:/i.test(l));
  if (idx >= 0) {
    const block = [];
    for (let i = idx; i < lines.length && block.length < 6; i++) {
      if (i > idx && lines[i].trim() === '' && block.length > 1) break;
      if (lines[i].trim() !== '') block.push(clip(lines[i], 200));
    }
    nextAction = block;
  }
  return { session, head, nextAction };
}

function readHandoff(project) {
  const file = findHandoffFile(project);
  if (!file) return null;
  const st = statSafe(file);
  const text = readText(file, 32768);
  if (text === null) return null;
  return Object.assign({ file: path.basename(file), mtime: st ? st.mtimeMs : null }, parseHandoff(text));
}

// ---------- progress ----------
function normalizeProgress(obj, file, mtimeMs, now) {
  if (!obj || typeof obj !== 'object') return null;
  const etaS = Number.isFinite(+obj.eta_s) ? +obj.eta_s : null;
  let updatedMs = Date.parse(obj.updated);
  if (!Number.isFinite(updatedMs)) updatedMs = mtimeMs;
  const lastMs = Math.max(updatedMs || 0, mtimeMs || 0);
  const status = obj.status ? String(obj.status) : 'unknown';
  // A progress file that stops updating for 2x its ETA step is a failure.
  const staleAfter = Math.max(2 * (etaS || 0) * 1000, 10 * 60 * 1000);
  const stale = status === 'running' && now - lastMs > staleAfter;
  const checklist = Array.isArray(obj.checklist)
    ? obj.checklist.slice(0, 20).map((c) => ({
        id: clip(c && c.id, 40),
        task: clip(c && c.task, 200),
        state: clip(c && c.state, 40),
        eta_s: c && Number.isFinite(+c.eta_s) ? +c.eta_s : null,
        // kit v20 (CHECKLIST-ETA-CLOCK): optional per-row pct and started
        pct: c && c.pct !== null && c.pct !== undefined && c.pct !== '' && Number.isFinite(+c.pct) ? Math.max(0, Math.min(100, +c.pct)) : null,
        started: c ? startedMs(c.started) : null,
      }))
    : [];
  return {
    file: path.basename(file),
    task: clip(obj.task || path.basename(file, '.json'), 80),
    pct: Number.isFinite(+obj.pct) ? Math.max(0, Math.min(100, +obj.pct)) : null,
    step: clip(obj.step, 300),
    eta_s: etaS,
    status,
    updated: lastMs,
    started: startedMs(obj.started),
    stale,
    checklist,
  };
}

// kit v20 "started": ISO text (write_progress) or epoch seconds (checklist rows) -> ms.
function startedMs(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v * 1000 : null;
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function readProgress(project, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const maxAge = (opts.maxAgeHours || 72) * 3600 * 1000;
  const maxN = opts.maxPerProject || 8;
  // Finished (done/failed/other) files leave after doneMaxAgeHours, stale running files
  // after staleMaxAgeHours; only live running files ride the full maxAgeHours window.
  const hrs = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d) * 3600 * 1000;
  const doneMaxAge = hrs(opts.doneMaxAgeHours, 1);
  const staleMaxAge = hrs(opts.staleMaxAgeHours, 2);
  const tooOld = (it) => {
    const age = now - (it.updated || 0);
    if (it.status === 'running') return it.stale && age > staleMaxAge;
    return age > doneMaxAge;
  };
  const items = [];
  for (const rel of project.progressDirs || []) {
    const dir = path.join(project.dir, rel);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json'));
    } catch (e) {
      continue;
    }
    for (const n of names) {
      const file = path.join(dir, n);
      const st = statSafe(file);
      if (!st || !st.isFile()) continue;
      if (now - st.mtimeMs > maxAge) continue;
      const text = readText(file, 262144);
      let obj = null;
      try {
        obj = JSON.parse(text);
      } catch (e) {
        const bad = { file: n, task: n.replace(/\.json$/i, ''), status: 'unreadable', updated: st.mtimeMs, stale: false, checklist: [] };
        if (!tooOld(bad)) items.push(bad);
        continue;
      }
      const it = normalizeProgress(obj, file, st.mtimeMs, now);
      if (it && !tooOld(it)) {
        it.dir = rel;
        items.push(it);
      }
    }
  }
  const rank = (it) => (it.status === 'running' && !it.stale ? 0 : it.stale ? 1 : it.status === 'failed' ? 2 : 3);
  items.sort((a, b) => rank(a) - rank(b) || b.updated - a.updated);
  return { total: items.length, items: items.slice(0, maxN) };
}

// ---------- inbox ----------
const inboxCache = new Map(); // dir -> { dirMtime, since, result }

// CON-UX-STATUSPANEL: a channel note's kind + subject from its filename
// (<stamp>-from-<TREE>-<KIND>-to-<DEST>-<subject>.md), for the card's hover text.
// A name that does not parse keeps its base name as the subject.
function noteLabel(name) {
  const base = String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const m = /-from-[A-Za-z0-9]+-([A-Z][A-Z-]*?)-(to|re)-(.*)$/.exec(base);
  if (!m) return { kind: '', subject: clip(base, 60) };
  const subject = m[2] === 'to' ? m[3].replace(/^(ALL-SIX|ALL|[A-Z0-9]+)-(?=.)/, '') : 're ' + m[3];
  return { kind: m[1], subject: clip(subject, 60) };
}

function readInbox(project, inboxRel, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  if (!inboxRel) return null; // no inbox folder unless the config names one (inboxDir)
  const dir = path.join(project.dir, inboxRel);
  const dst = statSafe(dir);
  if (!dst || !dst.isDirectory()) return null;
  const since = Number.isFinite(opts.since) ? opts.since : null;
  const cached = inboxCache.get(dir);
  if (cached && cached.dirMtime === dst.mtimeMs && cached.since === since && now - cached.at < 60000) return cached.result;
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch (e) {
    names = [];
  }
  const files = [];
  for (const n of names) {
    const st = statSafe(path.join(dir, n));
    if (st) files.push({ name: n, mtime: st.mtimeMs });
  }
  // Sort by mtime, never by filename stamp.
  files.sort((a, b) => b.mtime - a.mtime);
  const day = 24 * 3600 * 1000;
  const result = {
    total: files.length,
    last24h: files.filter((f) => now - f.mtime < day).length,
    newest: files.slice(0, 5).map((f) => ({ name: clip(f.name, 120), mtime: f.mtime })),
    // CON-UX-STATUSPANEL: notes new since the tree's last /done (else the last 24 h)
    fresh: files.filter((f) => f.mtime > (since !== null ? since : now - day)).length,
    freshBasis: since !== null ? 'done' : '24h',
    newestNote: files.length ? noteLabel(files[0].name) : null,
  };
  inboxCache.set(dir, { dirMtime: dst.mtimeMs, since, at: now, result });
  return result;
}

// ---------- /done marker (UI/UX standard section 2) ----------
// <tree>/ops/loop/control/session_done.json, written by the /done step's mark command, only read
// here. readDoneMarker applies validation rules 1 (status) and 3 (HEAD and hand-off hash
// unchanged since /done); the pane binding (rule 2) and the prompt/Stop/title timing
// (rule 4) are the pane manager's (panes.js doneFor).
const DONE_MARKER_REL = path.join('ops', 'loop', 'control', 'session_done.json');
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// HEAD sha from the files under .git (no process spawn; worktree and packed refs handled).
function readHead(dir) {
  let gitDir = path.join(dir, '.git');
  const st = statSafe(gitDir);
  if (!st) return null;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readText(gitDir, 4096) || '');
    if (!m) return null;
    gitDir = path.resolve(dir, m[1].trim());
  }
  const head = (readText(path.join(gitDir, 'HEAD'), 4096) || '').trim();
  if (HEX40.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head);
  if (!ref || ref[1].includes('..')) return null;
  const common = (readText(path.join(gitDir, 'commondir'), 4096) || '').trim();
  const dirs = [gitDir];
  if (common) dirs.push(path.resolve(gitDir, common));
  for (const d of dirs) {
    const v = (readText(path.join(d, ref[1]), 4096) || '').trim();
    if (HEX40.test(v)) return v;
  }
  for (const d of dirs) {
    const packed = readText(path.join(d, 'packed-refs'), 4 * 1024 * 1024) || '';
    for (const l of packed.split('\n')) {
      const parts = l.trim().split(' ');
      if (parts.length === 2 && parts[1] === ref[1] && HEX40.test(parts[0])) return parts[0];
    }
  }
  return null;
}

const hashCache = new Map(); // file -> { mtime, size, sha }
function sha256File(file) {
  const st = statSafe(file);
  if (!st || !st.isFile() || st.size > 8 * 1024 * 1024) return null;
  const c = hashCache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.sha;
  let sha = null;
  try { sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (e) { sha = null; }
  hashCache.set(file, { mtime: st.mtimeMs, size: st.size, sha });
  return sha;
}

// The last /done time from the marker, valid or not (work after /done invalidates the
// marker's DONE band, but the /done still happened): the card's "inbox M new" basis.
function readDoneAt(project) {
  const raw = readText(path.join(project.dir, DONE_MARKER_REL), 16384);
  if (!raw) return null;
  try {
    const at = Date.parse(JSON.parse(raw).at);
    return Number.isFinite(at) ? at : null;
  } catch (e) { return null; }
}

function readDoneMarker(project, opts) {
  const headFn = (opts && opts.head) || readHead;
  const raw = readText(path.join(project.dir, DONE_MARKER_REL), 16384);
  if (!raw) return null;
  let j;
  try { j = JSON.parse(raw); } catch (e) { return null; }
  if (!j || typeof j !== 'object' || j.schema !== 1) return null;
  if (j.status !== 'done' && j.status !== 'failed') return null;
  if (j.status === 'done' && j.safe_to_clear !== true) return null; // rule 1
  const at = Date.parse(j.at);
  const session = Number.isInteger(j.session) ? j.session : null;
  if (!Number.isFinite(at) || session === null) return null;
  const handoff = j.handoff;
  if (typeof j.commit !== 'string' || !HEX40.test(j.commit)) return null;
  if (typeof handoff !== 'string' || !/-NEXT-SESSION\.txt$/.test(handoff) || /[\/]/.test(handoff)) return null;
  if (typeof j.handoff_sha256 !== 'string' || !HEX64.test(j.handoff_sha256)) return null;
  if (headFn(project.dir) !== j.commit) return null; // rule 3: work after /done
  if (sha256File(path.join(project.dir, handoff)) !== j.handoff_sha256) return null;
  return {
    verdict: j.status === 'done' ? 'DONE' : 'FAIL',
    session,
    reason: j.status === 'failed' ? clip(j.reason || 'failed', 200) : null,
    at,
    // Binding fields stay on the server (never in the status snapshot).
    pane: typeof j.pane === 'string' && /^[0-9a-f]{8}$/.test(j.pane) ? j.pane : null,
    sessionId: typeof j.session_id === 'string' && UUID_RE.test(j.session_id) ? j.session_id : null,
  };
}


// ---------- git ----------
function readGit(dir, timeoutMs) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'status', '--porcelain=v1', '-b'],
      { timeout: timeoutMs || 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ error: clip(err.message, 160) });
        const lines = String(stdout).split('\n').filter((l) => l.length);
        let branch = null;
        let ahead = 0;
        let behind = 0;
        if (lines[0] && lines[0].startsWith('## ')) {
          const h = lines.shift().slice(3);
          branch = h.replace(/^No commits yet on /, '').split('...')[0].split(' ')[0] || h;
          const a = /ahead (\d+)/.exec(h);
          const b = /behind (\d+)/.exec(h);
          ahead = a ? +a[1] : 0;
          behind = b ? +b[1] : 0;
        }
        resolve({ branch, dirty: lines.length, ahead, behind });
      });
  });
}

// ---------- quota (quota state file, numbers only) ----------
const uuidCache = new Map();

function accountUuidFor(configDir) {
  const file = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  const st = statSafe(file);
  if (!st) return null;
  const c = uuidCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.uuid;
  let uuid = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    uuid = (j && j.oauthAccount && j.oauthAccount.accountUuid) || null;
  } catch (e) {
    uuid = null;
  }
  uuidCache.set(file, { mtime: st.mtimeMs, uuid });
  return uuid;
}

const QUOTA_FIELDS = ['unified5h', 'unified7d', 'unified7dSonnet', 'unified7dFable', 'unified5hReset', 'unified7dReset', 'unified7dSonnetReset', 'unified7dFableReset', 'unifiedStatus', 'tokensLimit', 'tokensRemaining', 'requestsLimit', 'requestsRemaining', 'resetsAt'];

function readQuota(stateFile, accounts, uuidResolver) {
  const st = statSafe(stateFile);
  if (!st) return null;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    return { error: 'unreadable', mtime: st.mtimeMs, accounts: [] };
  }
  const resolve = uuidResolver || accountUuidFor;
  const byUuid = {};
  for (const [id, a] of Object.entries(accounts || {})) {
    const u = resolve(a.configDir);
    if (u) byUuid[u] = { id, label: a.label || id };
  }
  const list = Array.isArray(j && j.quota) ? j.quota : [];
  const out = list.map((q, i) => {
    const known = byUuid[q && q.accountUuid];
    const nums = {};
    const src = (q && q.quota) || {};
    for (const f of QUOTA_FIELDS) {
      const v = src[f];
      nums[f] = typeof v === 'number' || v === null ? v : typeof v === 'string' ? clip(v, 40) : null;
    }
    // Only the quota numbers and our own account label leave this function: no names, emails or org ids.
    return { id: known ? known.id : 'quota' + (i + 1), label: known ? known.label : 'Quota ' + (i + 1), quota: nums };
  });
  return { mtime: st.mtimeMs, accounts: out };
}

// ---------- service ----------
class StatusService {
  constructor(cfg, getProjects) {
    this.cfg = cfg;
    this.getProjects = getProjects;
    this.git = {};
    this.snapshot = { at: 0, projects: [], quota: null };
    this.timers = [];
    this.gitBusy = false;
    this.markers = {}; // project id -> readDoneMarker result (server side only)
  }

  // The console's own checkout: flagged so the status panel can leave it out
  // (it is still a project for opening panes).
  isSelf(dir) {
    if (!this.cfg.root || !dir) return false;
    const norm = (d) => { let r = path.resolve(d); try { r = fs.realpathSync.native(r); } catch (e) { /* keep */ } return r.toLowerCase(); };
    if (this.selfDir === undefined) this.selfDir = norm(this.cfg.root);
    return norm(dir) === this.selfDir;
  }

  refreshFiles() {
    const now = Date.now();
    const markers = {};
    let boardMap = {};
    try { boardMap = readBoardsFile(this.cfg); } catch (e) { boardMap = {}; }
    const projects = this.getProjects().map((p) => {
      let handoff = null;
      let progress = { total: 0, items: [] };
      let inbox = null;
      try { handoff = readHandoff(p); } catch (e) { handoff = null; }
      try {
        progress = readProgress(p, {
          now,
          maxAgeHours: this.cfg.progressMaxAgeHours,
          maxPerProject: this.cfg.progressMaxPerProject,
          doneMaxAgeHours: this.cfg.progressDoneMaxAgeHours,
          staleMaxAgeHours: this.cfg.progressStaleMaxAgeHours,
        });
      } catch (e) { /* keep empty */ }
      let since = null;
      try { since = readDoneAt(p); } catch (e) { since = null; }
      try { inbox = readInbox(p, this.cfg.inboxDir, { now, since }); } catch (e) { inbox = null; }
      let headless = null;
      try { headless = readHeadless(p, { now }); } catch (e) { headless = null; }
      let marker = null;
      try { marker = readDoneMarker(p); } catch (e) { marker = null; }
      markers[p.id] = marker;
      const done = marker ? { verdict: marker.verdict, session: marker.session, reason: marker.reason, at: marker.at } : null;
      let board = null;
      try { board = resolveBoard(p, this.cfg, { mapping: boardMap }); } catch (e) { board = null; }
      const row = { id: p.id, name: p.name, code: p.code, retired: p.retired, self: this.isSelf(p.dir), handoff, progress, inbox, headless, done, board, git: this.git[p.id] || null };
      return row;
    });
    this.markers = markers;
    let quota = null;
    try { quota = readQuota(this.cfg.quotaStateFile, this.cfg.accounts); } catch (e) { quota = null; }
    this.snapshot = { at: now, projects, quota };
    return this.snapshot;
  }

  async refreshGit() {
    if (this.gitBusy) return;
    this.gitBusy = true;
    try {
      const ps = this.getProjects();
      const res = await Promise.all(ps.map((p) => readGit(p.dir)));
      ps.forEach((p, i) => { this.git[p.id] = Object.assign({ at: Date.now() }, res[i]); });
      for (const sp of this.snapshot.projects) sp.git = this.git[sp.id] || null;
    } finally {
      this.gitBusy = false;
    }
  }

  start() {
    this.refreshFiles();
    this.refreshGit();
    this.timers.push(setInterval(() => this.refreshFiles(), (this.cfg.statusIntervalSec || 5) * 1000));
    this.timers.push(setInterval(() => this.refreshGit(), (this.cfg.gitIntervalSec || 20) * 1000));
    for (const t of this.timers) t.unref();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}

module.exports = {
  StatusService, readHandoff, parseHandoff, findHandoffFile, readProgress, normalizeProgress,
  readInbox, readGit, readQuota, accountUuidFor, clip, readHeadless, readHead, readDoneMarker,
  readDoneAt, noteLabel,
};
