'use strict';
// Pane manager: owns node-pty processes, scrollback ring, and the idle/attention state.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { buildPaneEnv, hookSettings, claudeMissingMessage, paneTmpDir } = require('./claudeenv');

let pty = null;
function loadPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

// CON-PTY-STALE-KILL (found chasing PROFILE-ADOPT-E3, 2026-10-21). node-pty 1.1.0's
// conpty kill() forks a console-list agent and closes the pseudoconsole in the same
// tick; the shell is dead before the agent attaches ("AttachConsole failed"), so the
// agent never answers and 5 s later node-pty process.kill()s the shell pid it timed
// out on. That pid was released when the shell exited and is free for reuse: closing
// a pane killed whatever process got the number next (in the suite: a git child, a
// test-file process, a function-check run; on the machine: anything). Here the list
// is read while the shell is alive (node-pty holds its process handle until exit, so
// the pid cannot be recycled yet), its members are killed at once, and node-pty's own
// late list kill is disarmed. The list agent is our own fork, so its pid (it is on the
// list: it was attached when it read it) is known and never killed after it exited.
// Exited processes get no list kill at all.
const EXITED = new WeakSet();
const LIST_AGENT_MS = 5000;

// {pids, agentPid} of the console the shell runs in; resolves after the agent exited.
// pids is [] when the agent could not attach or timed out (nothing is guessed).
function consoleList(shellPid) {
  return new Promise((resolve) => {
    let agent;
    try {
      agent = require('child_process').fork(require.resolve('node-pty/lib/conpty_console_list_agent'), [String(shellPid)], { silent: true, windowsHide: true });
    } catch (e) { return resolve({ pids: [], agentPid: null }); }
    let pids = [];
    let settled = false;
    const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve({ pids, agentPid: agent.pid }); };
    // The timer settles on its own: an agent that already exited may never emit 'close'
    // (stage 0.1.4: a pane's pseudoconsole stayed open and held a test process for 10+
    // min), and 'exit' settles too, one turn later so a last IPC message is still read.
    const timer = setTimeout(() => { pids = []; try { agent.kill(); } catch (e) { /* gone */ } done(); }, LIST_AGENT_MS);
    agent.on('message', (m) => { if (m && Array.isArray(m.consoleProcessList)) pids = m.consoleProcessList; });
    agent.on('close', done);
    agent.on('exit', () => setImmediate(done));
    agent.on('error', done);
  });
}

// CON-SCROLL-CONPTY: node-pty 1.1.0 with the bundled conpty.dll never frees its conout
// worker and pipe after a kill (it waits for output that never comes) nor after the
// process exits on its own (it does not close the pseudoconsole then): every ended pane
// leaked a worker thread and kept node alive (test files hung for good). After the end
// the pseudoconsole is closed once and the worker and pipe released RELEASE_MS later,
// so the last output is still read.
const CLOSED = new WeakSet();
const RELEASE_MS = 500;
function releaseDllPty(proc, viaExit) {
  const a = proc && proc._agent;
  if (!a || !a._useConptyDll || CLOSED.has(proc)) return;
  CLOSED.add(proc);
  if (viaExit) { try { proc.kill(); } catch (e) { /* already closed */ } }
  const t = setTimeout(() => {
    try { if (a._conoutSocketWorker) a._conoutSocketWorker.dispose(); } catch (e) { /* gone */ }
    try { if (a._outSocket) a._outSocket.destroy(); } catch (e) { /* gone */ }
  }, RELEASE_MS);
  if (t.unref) t.unref();
}

// o: {platform, list(shellPid) -> Promise<{pids, agentPid}>} (tests).
function killPty(proc, o) {
  o = o || {};
  const a = proc && proc._agent;
  if (a && a._useConptyDll) {
    if (!CLOSED.has(proc)) { try { proc.kill(); } catch (e) { /* already gone */ } releaseDllPty(proc, false); }
    return Promise.resolve();
  }
  const listable = (o.platform || process.platform) === 'win32' && a && typeof a._getConsoleProcessList === 'function' && !a._useConptyDll;
  const close = () => { try { proc.kill(); } catch (e) { /* already gone */ } };
  if (!listable) { close(); return Promise.resolve(); }
  a._getConsoleProcessList = () => Promise.resolve([]);
  if (EXITED.has(proc)) { close(); return Promise.resolve(); }
  return Promise.resolve().then(() => (o.list || consoleList)(proc.pid)).then((r) => {
    if (EXITED.has(proc)) return; // exited while listing: the pids may be stale now
    for (const pid of (r && r.pids) || []) {
      if (pid === process.pid || pid === r.agentPid) continue;
      try { process.kill(pid); } catch (e) { /* gone */ }
    }
  }, () => {}).then(close);
}

const ECHO_MS = 1000; // output this soon after input is treated as echo, not activity
const HOOK_GRACE_MS = 1500;
const BURST_WINDOW_MS = 2000;
const BURST_MIN_CHUNKS = 3;

function rid(n) {
  return crypto.randomBytes(n || 4).toString('hex');
}

// CON-SCROLL-CONPTY (2026-10-25): Windows 10's inbox ConPTY (build 19045) re-renders its
// own viewport after every resize while xterm.js reflows the same lines, so scrolling up
// showed repeated, overwritten and missing lines and the scrollback lost history (search
// found nothing). Measured on this box with cmd.exe, 150 long lines and 8 resizes:
// inbox ConPTY 8 repeated ids, 3 out of order, 3 missing; xterm windowsPty mode instead
// 0 repeated but 14 missing; node-pty's bundled conpty.dll (1.23) 0 / 0 / 0. Every pty
// pane uses the bundled conpty.dll when it is there (cfg.conptyDll false turns it off).
function conptyDllPath() {
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    for (const d of [path.join(root, 'build', 'Release', 'conpty'), path.join(root, 'prebuilds', process.platform + '-' + process.arch, 'conpty')]) {
      if (fs.existsSync(path.join(d, 'conpty.dll')) && fs.existsSync(path.join(d, 'OpenConsole.exe'))) return d;
    }
  } catch (e) { /* node-pty missing */ }
  return null;
}
// o: {platform, dllPath} (tests).
function useConptyDll(cfg, o) {
  o = o || {};
  if ((o.platform || process.platform) !== 'win32') return false;
  if (cfg && cfg.conptyDll === false) return false;
  return !!(o.dllPath !== undefined ? o.dllPath : conptyDllPath());
}

// xterm.js windowsPty hint for a pane's terminal: the bundled conpty.dll behaves like
// the ConPTY of Windows 11 22H2 (22621: reflow on, grown rows come back from scrollback
// the ConPTY way); the inbox one gets the real build (xterm turns reflow off below 21376).
function windowsPtyFor(dll, o) {
  o = o || {};
  if ((o.platform || process.platform) !== 'win32') return null;
  const build = parseInt(String(o.release || require('os').release()).split('.')[2], 10) || 0;
  return { backend: 'conpty', buildNumber: dll ? 22621 : build };
}

const RING_BYTES_PER_LINE = 200;
const RING_MAX_BYTES = 8 * 1024 * 1024;
function ringBytesFor(lines, floor) {
  return Math.min(RING_MAX_BYTES, Math.max(floor || 400000, Math.round(lines) * RING_BYTES_PER_LINE));
}

class Pane extends EventEmitter {
  constructor(spec, mgr) {
    super();
    this.id = spec.id || rid(4);
    this.kind = spec.kind; // 'claude' | 'shell' | 'log' | 'run' (CON-HOM-5)
    this.svc = spec.svc || null; // log pane: the integration's log name
    this.recipe = spec.recipe || null; // run pane: the recipe id
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
    this.buf = []; // output strings, plus {c, r} size markers (CON-SCROLL-REPLAY)
    this.bufBytes = 0;
    this.headSize = { c: this.cols, r: this.rows }; // pty size at the oldest ring entry
    this.maxBytes = mgr.ringBytes || mgr.cfg.scrollbackBytes || 400000;
    this.state = 'starting';
    this.unseen = false;
    this.exitCode = null;
    this.startedAt = Date.now();
    this.stateAt = this.startedAt; // CON-ATTENTION-PANEL: when the current state began
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
    this.clearReopens = 0; // CON-CLEAR-MODE: restarts done by Settings "After /clear" = reopen
    this.done = null; // { kind: 'done' | 'failed', session, reason } or null
  }

  info() {
    return {
      id: this.id, kind: this.kind, projectId: this.projectId, title: this.title, cwd: this.cwd,
      account: this.account, shell: this.shell, args: this.args, state: this.state, unseen: this.unseen, stateAt: this.stateAt,
      exitCode: this.exitCode, startedAt: this.startedAt, cols: this.cols, rows: this.rows, note: this.note,
      sessionId: this.sessionId, hooks: this.hookSeen, done: this.done, clearedAt: this.clearedAt,
      // CON-CLEAR-NORESUME: the /clear is the newest prompt / session event of this process,
      // so there is nothing to continue (no reopen chip, no Resume button).
      clearedLast: !!this.clearedAt && this.clearedAt >= this.clearAt,
      busySince: this.busySince, tool: this.tool, toolSince: this.toolSince,
      pid: this.proc ? this.proc.pid : null, openedBy: this.openedBy, clearReopens: this.clearReopens,
      svc: this.svc, recipe: this.recipe, windowsPty: this.windowsPty || null,
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
      machineFile: this.mgr.cfg.dataDir ? path.join(this.mgr.cfg.dataDir, 'machine', 'spec.json') : null,
      tmpDir: this.kind === 'claude' ? this.mgr.paneTmpDir(this.cwd) : null,
    });
    this.state = 'busy';
    this.stateAt = Date.now();
    this.clearAt = Date.now();
    this.doneTitle = null;
    this.oscTail = '';
    this.done = null;
    this.busySince = Date.now();
    this.lastActivity = Date.now();
    this.exitCode = null;
    this.exitedAt = 0;
    const dll = useConptyDll(this.mgr.cfg);
    this.windowsPty = windowsPtyFor(dll);
    this.proc = P.spawn(this.file, this.args, {
      name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env,
      useConptyDll: dll,
    });
    const proc = this.proc;
    // HEALTH: every pane process is logged {pid, startedAt, endedAt} so the orphan
    // step can tell a child left behind by an ended pane (health.js findOrphans).
    const rec = { pid: proc.pid, paneId: this.id, startedAt: Date.now(), endedAt: null };
    if (typeof this.mgr.recordPid === 'function') this.mgr.recordPid(rec);
    try { proc.onExit(() => { rec.endedAt = Date.now(); EXITED.add(proc); releaseDllPty(proc, true); }); } catch (e) { /* no exit event */ }
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
      const x = this.buf.shift();
      if (typeof x === 'string') this.bufBytes -= x.length;
      else this.headSize = x;
    }
  }

  // CON-SCROLL-REPLAY: the ring remembers each pty resize, so a reload replays every
  // stretch of output at the size it was written for (wrapping and cursor moves land
  // where they did live) instead of all of it at the page's current size.
  pushSize(cols, rows) {
    const last = this.buf[this.buf.length - 1];
    if (last && typeof last !== 'string') this.buf[this.buf.length - 1] = { c: cols, r: rows };
    else if (this.buf.length) this.buf.push({ c: cols, r: rows });
    else this.headSize = { c: cols, r: rows };
  }

  replay() {
    return this.buf.filter((x) => typeof x === 'string').join('');
  }

  // [{cols, rows, d}] oldest first; consecutive output at one size is one segment.
  replaySegments() {
    const segs = [{ cols: this.headSize.c, rows: this.headSize.r, d: '' }];
    for (const x of this.buf) {
      if (typeof x === 'string') segs[segs.length - 1].d += x;
      else if (segs[segs.length - 1].d === '') { segs[segs.length - 1].cols = x.c; segs[segs.length - 1].rows = x.r; }
      else segs.push({ cols: x.c, rows: x.r, d: '' });
    }
    return segs;
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
    if (s !== this.state) this.stateAt = Date.now();
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
    // CON-SCROLL-CONPTY: the bundled ConPTY turns on focus reporting (CSI ? 1004 h), so
    // xterm sends CSI I / CSI O on every focus change. Passed on, but not operator input:
    // it must not mark the pane seen or look like typing.
    if (/^(?:\x1b\[[IO])+$/.test(d)) {
      try { this.proc.write(d); } catch (e) { /* gone */ }
      return true;
    }
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
    // CON-SCROLL-CONPTY: a resize to the same size is not passed on - every pty resize
    // makes ConPTY and claude repaint, and each page sends one on (re)connect.
    if (cols === this.cols && rows === this.rows && this.proc) return;
    this.cols = cols;
    this.rows = rows;
    this.pushSize(cols, rows);
    if (this.proc && this.state !== 'exited') {
      try {
        this.proc.resize(cols, rows);
      } catch (e) { /* process may be gone */ }
    }
  }

  kill() {
    if (this.proc) killPty(this.proc);
  }
}

// CON-HOM-5 / HOM-PANEL-2: a `log` pane follows one integration log file, no pty and no
// input (write() refuses). It polls the file (default every 500 ms), streams the bytes
// appended since the last read, and starts over with a marker when the file shrinks or
// is replaced (truncate / rotate). The file is opened only for each read, so closing the
// pane holds no handle. The path comes from the server (homctl paneSpec), never a client.
const LOG_POLL_MS = 500;
const LOG_FIRST_BYTES = 64 * 1024;
const LOG_CHUNK_BYTES = 256 * 1024;
class LogPane extends Pane {
  constructor(spec, mgr) {
    super(spec, mgr);
    this.logFile = spec.logFile;
    this.svc = spec.svc || null;
    this.offset = 0;
    this.ino = null;
    this.timer = null;
    this.missing = false;
    this.pollMs = (mgr && mgr.logPollMs) || LOG_POLL_MS;
  }

  start() {
    this.state = 'waiting';
    this.exitCode = null;
    this.startedAt = Date.now();
    this.offset = -1; // first read: the tail only
    this.readMore();
    this.timer = setInterval(() => this.readMore(), this.pollMs);
    if (this.timer.unref) this.timer.unref();
  }

  out(text) {
    const d = String(text).replace(/\r?\n/g, '\r\n');
    this.push(d);
    this.emit('data', d);
  }

  readMore() {
    let st = null;
    try { st = fs.statSync(this.logFile); } catch (e) { st = null; }
    if (!st || !st.isFile()) {
      if (!this.missing) this.out('\x1b[90m--- waiting for ' + path.basename(this.logFile) + ' ---\x1b[0m\n');
      this.missing = true;
      this.offset = 0;
      this.ino = null;
      return;
    }
    if (this.missing) this.missing = false;
    const rotated = this.ino !== null && st.ino !== this.ino;
    if (this.offset >= 0 && (rotated || st.size < this.offset)) {
      this.out('\x1b[90m--- log restarted ---\x1b[0m\n');
      this.offset = 0;
    }
    this.ino = st.ino;
    if (this.offset < 0) this.offset = Math.max(0, st.size - LOG_FIRST_BYTES);
    if (st.size <= this.offset) return;
    const len = Math.min(st.size - this.offset, LOG_CHUNK_BYTES);
    let fd = null;
    try {
      fd = fs.openSync(this.logFile, 'r');
      const b = Buffer.alloc(len);
      const n = fs.readSync(fd, b, 0, len, this.offset);
      this.offset += n;
      if (n) {
        this.lastActivity = Date.now();
        // CON-AUDIT SEC-4: colour (SGR) escapes pass, every other escape sequence and
        // control byte from another tree's log is dropped (no fake screens, no OSC).
        this.out(b.slice(0, n).toString('utf8').replace(/\x1b(?!\[[0-9;]*m)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, ''));
      }
    } catch (e) { /* the next tick tries again */ } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
    }
  }

  write() { return false; } // a log pane takes no input
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  tick() {}
  kill() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

class PaneManager extends EventEmitter {
  // SIDECAR-TEMP-SESSION: the claude pane's CLAUDE_CODE_TMPDIR (claudeenv.paneTmpDir);
  // cfg.paneTmpDir === false switches it off, cfg.sidecarRoot / cfg.fleetRoster override.
  paneTmpDir(cwd) {
    const cfg = this.cfg || {};
    if (cfg.paneTmpDir === false) return null;
    const rosterFile = cfg.fleetRoster || path.join(cfg.root || path.resolve(__dirname, '..'), '..', 'ops', 'fleet_roster.json');
    try {
      return paneTmpDir(cwd, { rosterFile, sidecarRoot: cfg.sidecarRoot });
    } catch (e) {
      return null; // a sidecar problem never blocks a pane
    }
  }

  constructor(cfg, opts) {
    super();
    this.cfg = cfg;
    this.panes = new Map();
    // Processes killed by close()/restart() whose conpty teardown has not reported
    // exit yet; closeAll() waits for them too (CON-E2E-FLAKY: node exiting while a
    // pane closed moments earlier was still tearing down crashed with 0xC0000005).
    this.dying = new Set();
    this.stopping = new Set(); // CON-AUDIT SEC-5: run panes closed but still in their graceful stop
    this.pidLog = []; // HEALTH: {pid, paneId, startedAt, endedAt} of every pane process, newest 500
    this.hookUrl = null;
    this.markerFor = null; // projectId -> validated /done marker (status.js), set by the server
    // CON-CLEAR-MODE: () => 'refresh' | 'reopen' (Settings "After /clear"), set by the server.
    this.clearMode = () => 'refresh';
    // CON-SCROLLBACK: the replay ring a reload / reconnect rebuilds a pane from. It follows
    // the Settings scrollback lines (setRingLines), never below cfg.scrollbackBytes.
    this.ringBytes = cfg.scrollbackBytes || 400000;
    this.clearReopenDelayMs = 400;
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

  // CON-SCROLLBACK: size the replay ring from the Settings scrollback lines. Raw claude
  // output measured 87-148 bytes per newline on 2026-10-25 (escape codes, redraws), so
  // RING_BYTES_PER_LINE bytes a line, at least cfg.scrollbackBytes, at most RING_MAX_BYTES.
  // Applies to open panes too (a shrink trims on their next output).
  setRingLines(lines) {
    const n = Number.isFinite(lines) && lines > 0 ? lines : 10000;
    this.ringBytes = ringBytesFor(n, this.cfg.scrollbackBytes);
    for (const p of this.panes.values()) p.maxBytes = this.ringBytes;
    return this.ringBytes;
  }

  hookSettingsFile() {
    const file = path.join(this.cfg.runDir, 'pane-hooks.json');
    fs.mkdirSync(this.cfg.runDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(hookSettings(this.nodePath, this.hookScript), null, 2) + '\n');
    return file;
  }

  buildSpec(req) {
    // CON-HOM-5: log / run panes come from an integration's pane spec (server-side recipes
    // and log names only; a client argv or path is ignored).
    if (req.kind === 'log' || req.kind === 'run') {
      if (typeof this.homSpec !== 'function') throw new Error('log / run panes are not configured');
      const hs = this.homSpec({ kind: req.kind, svc: req.svc, recipe: req.recipe });
      if (hs.single) {
        for (const o of [...this.panes.values(), ...this.stopping]) {
          if (o.id !== req.selfId && o.recipe === hs.recipe && o.state !== 'exited') throw new Error(hs.title + ' is already open in this console' + (this.stopping.has(o) ? ' (still stopping)' : ''));
        }
      }
      const spec = { kind: hs.kind, projectId: req.projectId || null, cwd: hs.cwd, cols: req.cols, rows: req.rows, file: hs.file, args: hs.args.slice(), title: hs.title, svc: hs.svc || null, recipe: hs.recipe || null, logFile: hs.logFile || null, stop: !!hs.stop };
      spec.openedBy = typeof req.client === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(req.client) ? req.client : null;
      return spec;
    }
    const kind = req.kind === 'claude' ? 'claude' : 'shell';
    const spec = { kind, projectId: req.projectId || null, cwd: req.cwd, cols: req.cols, rows: req.rows };
    spec.openedBy = typeof req.client === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(req.client) ? req.client : null;
    const extra = Array.isArray(req.args) ? req.args.filter((a) => typeof a === 'string').slice(0, 20) : [];
    if (kind === 'claude') {
      if (!this.claudePath) this.claudePath = require('./claudeenv').resolveClaude(this.cfg);
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
    const pane = spec.kind === 'log' ? new LogPane(spec, this) : new Pane(spec, this);
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
    const req = Object.assign({}, p.req, { cols: p.cols, rows: p.rows, resume: opts.resume && !opts.fresh && p.sessionId ? p.sessionId : null, selfId: p.id });
    if (Array.isArray(opts.args)) req.args = opts.args;
    const spec = this.buildSpec(req);
    p.file = spec.file;
    p.args = spec.args;
    p.sessionId = spec.sessionId || null;
    p.req = req;
    p.proc = null;
    if (opts.wipe) {
      // CON-CLEAR-MODE 'reopen': a fresh pane in the same slot - drop the replay buffer and
      // clear the screen and scrollback of every attached terminal (data-ordered).
      p.buf = [];
      p.bufBytes = 0;
      p.headSize = { c: p.cols, r: p.rows };
      const cls = '\x1b[2J\x1b[3J\x1b[H';
      p.push(cls);
      p.emit('data', cls);
    } else {
      p.push('\r\n\x1b[90m--- restarted ' + new Date().toLocaleTimeString() + ' ---\x1b[0m\r\n');
      p.emit('data', '\r\n\x1b[90m--- restarted ---\x1b[0m\r\n');
    }
    p.start();
    this.emit('state', p.info());
    return p;
  }

  close(id) {
    const p = this.panes.get(id);
    if (!p) return false;
    this.trackDeath(p);
    // HOM-PANEL-4: a run pane with a graceful stop (the driver) gets it first; the pty is
    // killed after runStopGraceMs if the process has not ended by then.
    if (p.spec && p.spec.stop && p.state !== 'exited' && typeof this.homStop === 'function' && this.homStop(p.recipe)) {
      this.stopping.add(p);
      p.once('exit', () => this.stopping.delete(p));
      const t = setTimeout(() => { this.stopping.delete(p); if (p.state !== 'exited') p.kill(); }, this.runStopGraceMs === undefined ? 10000 : this.runStopGraceMs);
      if (t.unref) t.unref();
    } else p.kill();
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
    if (event === 'ready' && source === 'clear' && p.kind === 'claude') this.maybeClearReopen(p);
    return true;
  }

  // CON-CLEAR-MODE: with Settings "After /clear" = reopen, a /clear restarts the claude
  // process fresh (new session id, wiped buffer) in the same pane, once. Deferred so the
  // hook request returns first; skipped when the pane closed, exited, was prompted again
  // or restarted meanwhile. The server is the one actor however many pages are open.
  maybeClearReopen(p) {
    let mode = 'refresh';
    try { mode = this.clearMode(); } catch (e) { mode = 'refresh'; }
    if (mode !== 'reopen') return false;
    const at = p.clearedAt;
    const t = setTimeout(() => {
      if (this.panes.get(p.id) !== p || p.state === 'exited' || p.clearedAt !== at || !p.info().clearedLast) return;
      p.clearReopens += 1;
      this.restart(p.id, { fresh: true, wipe: true });
    }, this.clearReopenDelayMs);
    if (t.unref) t.unref();
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

module.exports = { PaneManager, Pane, LogPane, killPty, EXITED, ringBytesFor, RING_BYTES_PER_LINE, RING_MAX_BYTES, useConptyDll, conptyDllPath, windowsPtyFor, releaseDllPty };
