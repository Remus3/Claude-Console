'use strict';
// Pane manager: owns node-pty processes, scrollback ring, and the idle/attention state.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { buildPaneEnv, hookSettings, claudeMissingMessage } = require('./claudeenv');

let pty = null;
function loadPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

const ECHO_MS = 1000; // output this soon after input is treated as echo, not activity
const HOOK_GRACE_MS = 1500;
const BURST_WINDOW_MS = 2000;
const BURST_MIN_CHUNKS = 3;

function rid(n) {
  return crypto.randomBytes(n || 4).toString('hex');
}

class Pane extends EventEmitter {
  constructor(spec, mgr) {
    super();
    this.id = spec.id || rid(4);
    this.kind = spec.kind; // 'claude' | 'shell'
    this.projectId = spec.projectId || null;
    this.title = spec.title || this.kind;
    this.cwd = spec.cwd;
    this.account = spec.account || null;
    this.shell = spec.shell || null;
    this.args = spec.args || [];
    this.file = spec.file;
    this.cols = spec.cols || 120;
    this.rows = spec.rows || 30;
    this.mgr = mgr;
    this.secret = rid(16);
    this.buf = [];
    this.bufBytes = 0;
    this.maxBytes = mgr.cfg.scrollbackBytes || 400000;
    this.state = 'starting';
    this.unseen = false;
    this.exitCode = null;
    this.startedAt = Date.now();
    this.lastInput = 0;
    this.lastActivity = 0;
    this.busySince = 0;
    // R5: the tool claude is running (PreToolUse .. PostToolUse), else null.
    this.tool = null;
    this.toolSince = 0;
    this.lastSubmit = 0;
    this.hookAt = 0;
    this.hookSeen = false;
    this.chunks = [];
    this.note = null;
    this.proc = null;
    this.sessionId = spec.sessionId || null;
    // CON-PANE-VANISH: the page that asked for this pane (its per-load client id), or
    // null for an API caller. A page tiles only its own new panes; any other new pane
    // arrives minimized there, so it never re-tiles the grid under the operator's pointer.
    this.openedBy = spec.openedBy || null;
    // /done band (UI/UX standard sections 2 and 4): hook times and the last DONE tab
    // title seen in the pty output, checked against the tree's session_done.json.
    this.clearAt = 0; // last UserPromptSubmit / SessionStart hook or process start
    this.stopAt = 0; // last Stop hook
    this.clearedAt = 0; // CON-UX-CLEAR: last SessionStart with source 'clear' (/clear)
    this.doneTitle = null; // { n, at } from an OSC 0/2 title `<CODE> DONE S<n> - ...`
    this.oscTail = '';
    this.done = null; // { kind: 'done' | 'failed', session, reason } or null
  }

  info() {
    return {
      id: this.id, kind: this.kind, projectId: this.projectId, title: this.title, cwd: this.cwd,
      account: this.account, shell: this.shell, args: this.args, state: this.state, unseen: this.unseen,
      exitCode: this.exitCode, startedAt: this.startedAt, cols: this.cols, rows: this.rows, note: this.note,
      sessionId: this.sessionId, hooks: this.hookSeen, done: this.done, clearedAt: this.clearedAt,
      busySince: this.busySince, tool: this.tool, toolSince: this.toolSince,
      pid: this.proc ? this.proc.pid : null, openedBy: this.openedBy,
    };
  }

  start() {
    const P = loadPty();
    const env = buildPaneEnv(process.env, {
      kind: this.kind,
      account: this.kind === 'claude' ? this.mgr.cfg.accounts[this.account] : null,
      paneId: this.id,
      hookUrl: this.mgr.hookUrl,
      hookSecret: this.secret,
    });
    this.state = 'busy';
    this.clearAt = Date.now();
    this.doneTitle = null;
    this.oscTail = '';
    this.done = null;
    this.busySince = Date.now();
    this.lastActivity = Date.now();
    this.exitCode = null;
    this.exitedAt = 0;
    this.proc = P.spawn(this.file, this.args, {
      name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env,
    });
    const proc = this.proc;
    // HEALTH: every pane process is logged {pid, startedAt, endedAt} so the orphan
    // step can tell a child left behind by an ended pane (health.js findOrphans).
    const rec = { pid: proc.pid, paneId: this.id, startedAt: Date.now(), endedAt: null };
    if (typeof this.mgr.recordPid === 'function') this.mgr.recordPid(rec);
    try { proc.onExit(() => { rec.endedAt = Date.now(); }); } catch (e) { /* no exit event */ }
    proc.onData((d) => {
      if (this.proc !== proc) return;
      this.push(d);
      this.scanTitle(d);
      this.onOutput(d);
      this.emit('data', d);
    });
    proc.onExit((e) => {
      if (this.proc !== proc) return;
      this.exitCode = e && typeof e.exitCode === 'number' ? e.exitCode : null;
      this.exitedAt = Date.now();
      this.setState('exited', true);
      this.emit('exit', this.exitCode);
    });
  }

  push(d) {
    this.buf.push(d);
    this.bufBytes += d.length;
    while (this.bufBytes > this.maxBytes && this.buf.length > 1) {
      this.bufBytes -= this.buf.shift().length;
    }
  }

  replay() {
    return this.buf.join('');
  }

  // OSC 0/2 window titles in the output; only a DONE title is remembered.
  scanTitle(d) {
    if (this.kind !== 'claude' || (!this.oscTail && !d.includes('\x1b]'))) return;
    const s = this.oscTail + d;
    const re = /\x1b\][02];([^\x07\x1b]{0,300})(?:\x07|\x1b\\)/g;
    let m;
    let end = 0;
    while ((m = re.exec(s))) {
      end = re.lastIndex;
      const t = /\bDONE S(\d+)\b/.exec(m[1]);
      // Kept when claude retitles the tab afterwards; a prompt or session start clears the band.
      if (t) this.doneTitle = { n: parseInt(t[1], 10), at: Date.now() };
    }
    const open = s.lastIndexOf('\x1b]');
    this.oscTail = open >= end && s.length - open < 400 ? s.slice(open) : '';
  }

  // Validation rules 2 and 4 for a marker that already passed rules 1 and 3
  // (status.js readDoneMarker): bound to this pane or its hook-reported session,
  // no prompt / session start since, a Stop after it, and for DONE the kit Stop
  // hook's tab title for the same session seen after it.
  doneFor(m) {
    if (!m || this.kind !== 'claude' || this.state === 'exited') return null;
    if (m.pane !== this.id && !(m.sessionId && m.sessionId === this.sessionId)) return null;
    if (this.clearAt > m.at || this.stopAt < m.at) return null;
    if (m.verdict === 'DONE') {
      const t = this.doneTitle;
      if (!t || t.n !== m.session || t.at < m.at) return null;
      return { kind: 'done', session: m.session, reason: null };
    }
    return { kind: 'failed', session: m.session, reason: m.reason || 'failed' };
  }

  refreshDone(m) {
    const d = this.doneFor(m);
    if (JSON.stringify(d) === JSON.stringify(this.done)) return;
    this.done = d;
    this.emit('state', this.info());
  }

  onOutput() {
    const now = Date.now();
    if (now - this.lastInput < ECHO_MS) return; // keystroke echo / input-box redraw
    if (now - this.hookAt < HOOK_GRACE_MS) return;
    this.chunks.push(now);
    while (this.chunks.length && now - this.chunks[0] > BURST_WINDOW_MS) this.chunks.shift();
    this.lastActivity = now;
    // Claude's TUI repaints now and then while idle, so it needs a burst; a shell does not.
    const need = this.kind === 'claude' ? BURST_MIN_CHUNKS : 1;
    if (this.state !== 'busy' && this.state !== 'exited' && this.chunks.length >= need) {
      this.busySince = now;
      this.setState('busy', false);
    }
  }

  tick(now, idleMs) {
    if (this.state === 'busy' && now - this.lastActivity >= idleMs && now - this.lastInput >= idleMs) {
      // Badge only when output came well after the last submitted line (a command or
      // turn that took time), not a blip. Once claude's hooks have reported, they own the
      // badge for that pane and the heuristic only moves the dot.
      const real = this.lastSubmit > 0 && !(this.kind === 'claude' && this.hookSeen) && this.lastActivity - this.lastSubmit > 1500;
      this.setState('waiting', real);
    }
  }

  hook(event, note, sessionId, toolName, source) {
    this.hookAt = Date.now();
    if (event === 'tool' || event === 'tooldone') {
      // R5: tool start / end. A tool starting means the turn is busy; the turn's
      // busySince is kept so the header can still show the whole stretch.
      this.hookSeen = true;
      if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) this.sessionId = sessionId;
      const name = event === 'tool' && typeof toolName === 'string' ? toolName.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || null : null;
      const changed = name !== this.tool;
      this.tool = name;
      this.toolSince = name ? this.hookAt : 0;
      this.lastActivity = this.hookAt;
      // From attention too: a tool ending after a permission prompt means it was granted.
      if (this.state !== 'busy' && this.state !== 'exited') {
        if (this.state !== 'attention') this.busySince = this.hookAt;
        this.setState('busy', false);
      } else if (changed) this.emit('state', this.info());
      return;
    }
    if (event === 'busy' || event === 'ready') this.clearAt = this.hookAt;
    if (event === 'ready' && source === 'clear') this.clearedAt = this.hookAt;
    else if (event === 'waiting') this.stopAt = this.hookAt;
    this.hookSeen = true;
    // The 60s idle Notification is not a permission request: treat it as plain waiting.
    if (event === 'attention' && note && /waiting for your input/i.test(note)) {
      event = 'waiting';
      note = null;
    }
    if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) this.sessionId = sessionId;
    this.chunks = [];
    if (event === 'busy') {
      this.busySince = Date.now();
      this.lastActivity = Date.now();
      this.setState('busy', false);
    } else if (event === 'waiting') {
      this.setState('waiting', this.state === 'busy' || this.state === 'attention');
    } else if (event === 'ready') {
      const st = this.state;
      this.setState('waiting', false);
      // /clear in an idle pane changes no state; the clients still need clearedAt
      if (source === 'clear' && st === 'waiting') this.emit('state', this.info());
    } else if (event === 'attention') {
      this.note = note || null;
      this.setState('attention', true);
    }
  }

  setState(s, markUnseen) {
    const changed = s !== this.state || (markUnseen && !this.unseen);
    this.state = s;
    if (s !== 'attention') this.note = null;
    if (s !== 'busy' && s !== 'attention') { this.tool = null; this.toolSince = 0; }
    if (markUnseen) this.unseen = true;
    if (changed) this.emit('state', this.info());
  }

  seen() {
    if (this.unseen) {
      this.unseen = false;
      this.emit('state', this.info());
    }
  }

  write(d) {
    if (!this.proc || this.state === 'exited') return false;
    const now = Date.now();
    this.lastInput = now;
    if (this.unseen) this.seen();
    if (d.includes('\r')) {
      // A submitted line starts a work stretch; quiet afterwards means "waiting".
      this.lastSubmit = now;
      this.busySince = now;
      this.lastActivity = now;
      this.chunks = [];
      if (this.state !== 'busy') this.setState('busy', false);
    }
    this.proc.write(d);
    return true;
  }

  resize(cols, rows) {
    cols = Math.max(10, Math.min(500, cols | 0));
    rows = Math.max(4, Math.min(300, rows | 0));
    this.cols = cols;
    this.rows = rows;
    if (this.proc && this.state !== 'exited') {
      try {
        this.proc.resize(cols, rows);
      } catch (e) { /* process may be gone */ }
    }
  }

  kill() {
    const p = this.proc;
    if (p) {
      try {
        p.kill();
      } catch (e) { /* already gone */ }
    }
  }
}

class PaneManager extends EventEmitter {
  constructor(cfg, opts) {
    super();
    this.cfg = cfg;
    this.panes = new Map();
    // Processes killed by close()/restart() whose conpty teardown has not reported
    // exit yet; closeAll() waits for them too (CON-E2E-FLAKY: node exiting while a
    // pane closed moments earlier was still tearing down crashed with 0xC0000005).
    this.dying = new Set();
    this.pidLog = []; // HEALTH: {pid, paneId, startedAt, endedAt} of every pane process, newest 500
    this.hookUrl = null;
    this.markerFor = null; // projectId -> validated /done marker (status.js), set by the server
    this.claudePath = opts && opts.claudePath;
    this.nodePath = process.execPath;
    this.hookScript = path.join(__dirname, 'hook.js');
    this.timer = setInterval(() => {
      const now = Date.now();
      const idleMs = (cfg.idleSeconds || 4) * 1000;
      for (const p of this.panes.values()) {
        p.tick(now, idleMs);
        this.refreshDone(p);
      }
    }, 1000);
    this.timer.unref();
  }

  recordPid(rec) {
    this.pidLog.push(rec);
    if (this.pidLog.length > 500) this.pidLog.splice(0, this.pidLog.length - 500);
  }

  refreshDone(p) {
    let m = null;
    try { m = this.markerFor && p.projectId ? this.markerFor(p.projectId) : null; } catch (e) { m = null; }
    p.refreshDone(m);
  }

  hookSettingsFile() {
    const file = path.join(this.cfg.runDir, 'pane-hooks.json');
    fs.mkdirSync(this.cfg.runDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(hookSettings(this.nodePath, this.hookScript), null, 2) + '\n');
    return file;
  }

  buildSpec(req) {
    const kind = req.kind === 'claude' ? 'claude' : 'shell';
    const spec = { kind, projectId: req.projectId || null, cwd: req.cwd, cols: req.cols, rows: req.rows };
    spec.openedBy = typeof req.client === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(req.client) ? req.client : null;
    const extra = Array.isArray(req.args) ? req.args.filter((a) => typeof a === 'string').slice(0, 20) : [];
    if (kind === 'claude') {
      if (!this.claudePath) throw new Error(claudeMissingMessage(this.cfg));
      const account = req.account && this.cfg.accounts[req.account] ? req.account : this.cfg.defaultAccount;
      if (!this.cfg.accounts[account]) throw new Error('unknown account ' + account);
      const args = [].concat(this.cfg.claudeArgs || []);
      if (req.name) args.push('--name', String(req.name).slice(0, 60));
      // Every claude pane gets a known session id so it can be resumed exactly later
      // (never --continue: headless lanes share these directories).
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (req.resume && UUID.test(req.resume)) {
        args.push('--resume', req.resume);
        spec.sessionId = req.resume;
      } else {
        spec.sessionId = crypto.randomUUID();
        args.push('--session-id', spec.sessionId);
      }
      if (this.cfg.useHooks && this.hookUrl) args.push('--settings', this.hookSettingsFile());
      spec.file = this.claudePath;
      spec.args = args.concat(extra);
      spec.account = account;
      spec.title = req.title || 'claude';
    } else {
      const shells = this.cfg.shells || {};
      let key = req.shell && shells[req.shell] ? req.shell : this.cfg.defaultShell;
      if (!shells[key] || !fs.existsSync(shells[key].file)) {
        key = Object.keys(shells).find((k) => fs.existsSync(shells[k].file));
      }
      if (!key) throw new Error('no shell available');
      spec.file = shells[key].file;
      spec.args = (shells[key].args || []).concat(extra);
      spec.shell = key;
      spec.title = req.title || shells[key].label || key;
    }
    return spec;
  }

  create(req) {
    const spec = this.buildSpec(req);
    let st;
    try {
      st = fs.statSync(spec.cwd);
    } catch (e) {
      st = null;
    }
    if (!st || !st.isDirectory()) throw new Error('cwd is not a directory');
    const pane = new Pane(spec, this);
    pane.spec = spec;
    pane.req = req;
    this.panes.set(pane.id, pane);
    pane.on('state', (info) => this.emit('state', info));
    pane.on('exit', () => this.emit('state', pane.info()));
    pane.start();
    this.emit('added', pane.info());
    return pane;
  }

  // Remember a live process that is about to be killed until it reports exit.
  trackDeath(p) {
    const proc = p.proc;
    if (!proc || p.state === 'exited' || typeof proc.onExit !== 'function') return;
    let done = null;
    const w = new Promise((r) => { done = r; });
    this.dying.add(w);
    try { proc.onExit(() => done()); } catch (e) { done(); }
    w.then(() => this.dying.delete(w));
  }

  restart(id, opts) {
    const p = this.panes.get(id);
    if (!p) return null;
    opts = opts || {};
    this.trackDeath(p);
    p.kill();
    const req = Object.assign({}, p.req, { cols: p.cols, rows: p.rows, resume: opts.resume && p.sessionId ? p.sessionId : null });
    if (Array.isArray(opts.args)) req.args = opts.args;
    const spec = this.buildSpec(req);
    p.file = spec.file;
    p.args = spec.args;
    p.sessionId = spec.sessionId || null;
    p.req = req;
    p.proc = null;
    p.push('\r\n\x1b[90m--- restarted ' + new Date().toLocaleTimeString() + ' ---\x1b[0m\r\n');
    p.emit('data', '\r\n\x1b[90m--- restarted ---\x1b[0m\r\n');
    p.start();
    this.emit('state', p.info());
    return p;
  }

  close(id) {
    const p = this.panes.get(id);
    if (!p) return false;
    this.trackDeath(p);
    p.kill();
    this.panes.delete(id);
    p.emit('closed');
    this.emit('removed', { id });
    return true;
  }

  get(id) {
    return this.panes.get(id) || null;
  }

  list() {
    return [...this.panes.values()].map((p) => p.info());
  }

  hook(id, secret, event, note, sessionId, toolName, source) {
    const p = this.panes.get(id);
    if (!p) return false;
    const a = Buffer.from(String(secret || ''));
    const b = Buffer.from(p.secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    if (!['busy', 'waiting', 'attention', 'ready', 'tool', 'tooldone'].includes(event)) return false;
    p.hook(event, note, sessionId, toolName, source);
    if (event !== 'tool' && event !== 'tooldone') this.refreshDone(p);
    return true;
  }

  // Kill every pane and wait (bounded) for the processes to report exit; exiting node
  // while node-pty is still tearing a conpty down trips a libuv assertion.
  async closeAll(timeoutMs) {
    for (const id of [...this.panes.keys()]) this.close(id);
    const waits = [...this.dying];
    clearInterval(this.timer);
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, timeoutMs || 3000))]);
    await new Promise((r) => setTimeout(r, 300));
  }
}

module.exports = { PaneManager, Pane };
