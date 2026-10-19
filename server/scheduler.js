'use strict';
// CON-SCHEDULER (S49 intake 2026-10-18): the
// Projects-tab task-scheduler viewport, server side. View, add, alter and remove Windows
// scheduled tasks outside \Microsoft\, map each task to the repo (or the console) its
// action runs in, and show it next to the CLAUDE.md facts (Temp file count is boot time;
// 267009 / 267011 / 2147946720 are not failures; boot / logon triggers add boot work).
//
// Every OS call goes through ONE injected runner(file, args, {env}) -> {code, stdout,
// stderr}; tests pass a fake task store and never reach the real scheduler (CLAUDE.md:
// never run a machine-reconfiguring script on this box to test it). Arguments for a
// PowerShell call travel in environment variables, never on the -Command line, and
// schtasks.exe gets an argv array (no shell), so no caller text is ever parsed as code.
//
// Writes, one at a time:
//   add    - task XML (UTF-16LE + BOM) -> schtasks /Create /XML (never /F), read back;
//            a read-back mismatch deletes what was registered.
//   alter  - Export-ScheduledTask backup FIRST (no backup = no write), then /Change
//            /ENABLE|/DISABLE or a /Create /XML /F of the backup with only its <Triggers>
//            or <Actions> block replaced; read back; a mismatch restores the backup.
//   remove - backup first, schtasks /Delete /F, read back absent.
// Backups stay in <dataDir>/scheduler/backup (never deleted here); every write is one
// line in <runDir>/scheduler.log.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SCHTASKS = 'C:\\Windows\\System32\\schtasks.exe';

// READ ONLY. One JSON array of every task outside \Microsoft\.
const PS_LIST = "$ErrorActionPreference = 'Stop'; $o = @(); "
  + "foreach ($t in (Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' })) { "
  + "$i = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue; "
  + "$o += [pscustomobject]@{ name = $t.TaskName; path = $t.TaskPath; state = [string]$t.State; author = $t.Author; description = $t.Description; "
  + "lastRun = $(if ($i -and $i.LastRunTime) { $i.LastRunTime.ToString('s') } else { $null }); "
  + "nextRun = $(if ($i -and $i.NextRunTime) { $i.NextRunTime.ToString('s') } else { $null }); "
  + "lastResult = $(if ($i) { [long]$i.LastTaskResult } else { $null }); "
  + "triggers = @($t.Triggers | ForEach-Object { [pscustomobject]@{ kind = $_.CimClass.CimClassName; start = $_.StartBoundary; enabled = $_.Enabled; delay = $_.Delay; "
  + "interval = $(if ($_.Repetition) { $_.Repetition.Interval } else { $null }) } }); "
  + "actions = @($t.Actions | ForEach-Object { [pscustomobject]@{ exe = $_.Execute; args = $_.Arguments; workdir = $_.WorkingDirectory } }) } }; "
  + 'ConvertTo-Json -InputObject $o -Depth 5 -Compress';

// READ ONLY toward the scheduler: writes the task XML to the backup file named in the env.
const PS_EXPORT = "$ErrorActionPreference = 'Stop'; "
  + 'Export-ScheduledTask -TaskName $env:CC_SCHED_NAME -TaskPath $env:CC_SCHED_PATH | Out-File -LiteralPath $env:CC_SCHED_OUT -Encoding Unicode';

const BENIGN = Object.freeze({ 0: 'ok', 267009: 'running', 267011: 'never run', 2147946720: 'repeat refused (IgnoreNew)' });

const FACTS = Object.freeze([
  'Temp file COUNT is boot time here (~0.2 ms per file at logon); the directory count matters too.',
  'Task results 267009 (running), 267011 (never run) and 2147946720 (repeat refused, IgnoreNew) are not failures.',
  'Boot and logon triggers add work to every boot: delay them or keep them short.',
  'Windows boot event 100 is dead on this machine; boot time comes from Record-BootTime.ps1 (boot-times.csv).',
]);

const KINDS = Object.freeze({
  MSFT_TaskDailyTrigger: 'daily', MSFT_TaskWeeklyTrigger: 'weekly', MSFT_TaskTimeTrigger: 'once',
  MSFT_TaskLogonTrigger: 'logon', MSFT_TaskBootTrigger: 'boot', MSFT_TaskIdleTrigger: 'idle',
  MSFT_TaskEventTrigger: 'event', MSFT_TaskSessionStateChangeTrigger: 'session', MSFT_TaskRegistrationTrigger: 'registration',
});
const WRITE_KINDS = Object.freeze(['once', 'daily', 'weekly', 'logon', 'boot']);
const DAYS = Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const DAY_EL = Object.freeze({ Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' });
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/;
const PATH_RE = /^\\(?:[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}\\)*$/;
const TEXT_RE = /^[\x20-\x7e]*$/;

function resultText(code) {
  if (code === null || code === undefined || !isFinite(code)) return { text: 'unknown', ok: true };
  const n = Number(code);
  if (Object.prototype.hasOwnProperty.call(BENIGN, n)) return { text: BENIGN[n], ok: true };
  return { text: 'failed (0x' + (n >>> 0).toString(16).toUpperCase() + ')', ok: false };
}

function triggerKind(cim) {
  return KINDS[cim] || 'other';
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDate(ms) { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function stamp(ms) { const d = new Date(ms); return localDate(ms).replace(/-/g, '') + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()); }

function validRef(ref) {
  if (!ref || typeof ref !== 'object') return { ok: false, error: 'task path and name required' };
  const tpath = ref.path === undefined ? '\\' : ref.path;
  if (typeof tpath !== 'string' || !PATH_RE.test(tpath)) return { ok: false, error: 'bad task folder (\\ or \\Folder\\)' };
  if (/^\\microsoft\\/i.test(tpath)) return { ok: false, error: 'tasks under \\Microsoft\\ are not managed here' };
  if (typeof ref.name !== 'string' || !NAME_RE.test(ref.name)) return { ok: false, error: 'bad task name (letters, digits, space . _ -, up to 80)' };
  return { ok: true, path: tpath, name: ref.name, full: tpath + ref.name };
}

function validTrigger(t) {
  if (!t || typeof t !== 'object' || !WRITE_KINDS.includes(t.kind)) return { ok: false, error: 'trigger kind must be one of ' + WRITE_KINDS.join(', ') };
  const out = { kind: t.kind };
  if (['once', 'daily', 'weekly'].includes(t.kind)) {
    if (typeof t.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.at)) return { ok: false, error: 'trigger time must be HH:MM' };
    out.at = t.at;
  }
  if (t.kind === 'once' && t.date !== undefined) {
    const m = typeof t.date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date) : null;
    if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return { ok: false, error: 'trigger date must be YYYY-MM-DD' };
    out.date = t.date;
  }
  if (t.kind === 'weekly') {
    if (!Array.isArray(t.days) || !t.days.length || t.days.some((d) => !DAYS.includes(d))) return { ok: false, error: 'weekly needs days from ' + DAYS.join(' ') };
    out.days = DAYS.filter((d) => t.days.includes(d));
  }
  if (t.everyMinutes !== undefined && t.everyMinutes !== null) {
    if (!Number.isInteger(t.everyMinutes) || t.everyMinutes < 5 || t.everyMinutes > 1440) return { ok: false, error: 'repeat must be 5 to 1440 minutes' };
    out.everyMinutes = t.everyMinutes;
  }
  if (t.delaySeconds !== undefined && t.delaySeconds !== null) {
    if (!['logon', 'boot'].includes(t.kind) || !Number.isInteger(t.delaySeconds) || t.delaySeconds < 0 || t.delaySeconds > 3600) return { ok: false, error: 'delay is 0 to 3600 s, logon / boot only' };
    out.delaySeconds = t.delaySeconds;
  }
  return { ok: true, trigger: out };
}

function validAction(a, exists) {
  if (!a || typeof a !== 'object') return { ok: false, error: 'action required' };
  if (typeof a.exe !== 'string' || !path.win32.isAbsolute(a.exe) || !TEXT_RE.test(a.exe) || a.exe.includes('"')) return { ok: false, error: 'program must be an absolute path (ASCII)' };
  if (!(exists || fs.existsSync)(a.exe)) return { ok: false, error: 'program not found' };
  const args = a.args === undefined || a.args === null ? '' : a.args;
  if (typeof args !== 'string' || args.length > 1024 || !TEXT_RE.test(args)) return { ok: false, error: 'arguments: one line of ASCII, up to 1024 characters' };
  const workdir = a.workdir === undefined || a.workdir === null ? '' : a.workdir;
  if (typeof workdir !== 'string' || (workdir && (!path.win32.isAbsolute(workdir) || !TEXT_RE.test(workdir) || workdir.includes('"')))) return { ok: false, error: 'start-in folder must be absolute (or empty)' };
  return { ok: true, action: { exe: a.exe, args, workdir } };
}

// A full add spec -> {ok, spec} | {ok:false, error}. opts.exists for tests.
function validateSpec(spec, opts) {
  opts = opts || {};
  if (!spec || typeof spec !== 'object') return { ok: false, error: 'task spec required' };
  const ref = validRef({ path: spec.path, name: spec.name });
  if (!ref.ok) return ref;
  const act = validAction(spec, opts.exists);
  if (!act.ok) return act;
  const trg = validTrigger(spec.trigger);
  if (!trg.ok) return trg;
  const description = spec.description === undefined ? '' : spec.description;
  if (typeof description !== 'string' || description.length > 200 || !TEXT_RE.test(description)) return { ok: false, error: 'description: ASCII, up to 200 characters' };
  const enabled = spec.enabled === undefined ? true : spec.enabled;
  if (typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be true or false' };
  const limitMinutes = spec.limitMinutes === undefined ? 60 : spec.limitMinutes;
  if (!Number.isInteger(limitMinutes) || limitMinutes < 1 || limitMinutes > 1440) return { ok: false, error: 'time limit is 1 to 1440 minutes' };
  return { ok: true, spec: Object.assign({ path: ref.path, name: ref.name, description, enabled, limitMinutes, trigger: trg.trigger }, act.action) };
}

// <Triggers> block for one trigger; element order follows the task schema
// (Repetition, StartBoundary, Enabled, then the kind's own elements).
function triggersXml(t, now) {
  const rep = t.everyMinutes ? '<Repetition><Interval>PT' + t.everyMinutes + 'M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>' : '';
  const start = (d) => '<StartBoundary>' + d + 'T' + t.at + ':00</StartBoundary>';
  const delay = t.delaySeconds ? '<Delay>PT' + t.delaySeconds + 'S</Delay>' : '';
  let inner;
  if (t.kind === 'once') inner = '<TimeTrigger>' + rep + start(t.date || localDate(now)) + '<Enabled>true</Enabled></TimeTrigger>';
  else if (t.kind === 'daily') inner = '<CalendarTrigger>' + rep + start(localDate(now)) + '<Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>';
  else if (t.kind === 'weekly') inner = '<CalendarTrigger>' + rep + start(localDate(now)) + '<Enabled>true</Enabled><ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek>' + t.days.map((d) => '<' + DAY_EL[d] + ' />').join('') + '</DaysOfWeek></ScheduleByWeek></CalendarTrigger>';
  else if (t.kind === 'logon') inner = '<LogonTrigger>' + rep + '<Enabled>true</Enabled>' + delay + '</LogonTrigger>';
  else inner = '<BootTrigger>' + rep + '<Enabled>true</Enabled>' + delay + '</BootTrigger>';
  return '<Triggers>\n    ' + inner + '\n  </Triggers>';
}

function actionsXml(a) {
  return '<Actions Context="Author">\n    <Exec><Command>' + xmlEsc(a.exe) + '</Command>' + (a.args ? '<Arguments>' + xmlEsc(a.args) + '</Arguments>' : '') + (a.workdir ? '<WorkingDirectory>' + xmlEsc(a.workdir) + '</WorkingDirectory>' : '') + '</Exec>\n  </Actions>';
}

function buildXml(spec, now) {
  return '<?xml version="1.0" encoding="UTF-16"?>\n'
    + '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n'
    + '  <RegistrationInfo><Author>Claude Console</Author><Description>' + xmlEsc(spec.description || '') + '</Description><URI>' + xmlEsc(spec.path + spec.name) + '</URI></RegistrationInfo>\n'
    + '  ' + triggersXml(spec.trigger, now) + '\n'
    + '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n'
    + '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>'
    + '<StartWhenAvailable>true</StartWhenAvailable><Enabled>' + (spec.enabled ? 'true' : 'false') + '</Enabled><Hidden>false</Hidden><ExecutionTimeLimit>PT' + spec.limitMinutes + 'M</ExecutionTimeLimit></Settings>\n'
    + '  ' + actionsXml(spec) + '\n'
    + '</Task>\n';
}

// Replace the whole <Triggers>/<Actions> element of an exported task XML; null when absent.
function replaceBlock(xml, tag, block) {
  const re = new RegExp('<' + tag + '\\b[^>]*?(?:/>|>[\\s\\S]*?</' + tag + '>)');
  if (!re.test(xml)) return null;
  return xml.replace(re, () => block);
}

function utf16(xml) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

function readUtf16(file) {
  const b = fs.readFileSync(file);
  if (b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le');
  return b.toString('utf8');
}

const lowerPath = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();

// The project (or 'console') whose folder the task's action names; longest path wins and
// a match must end at a separator / quote / space / end of text.
function ownerOf(task, projects, consoleRoot) {
  const hay = (task.actions || []).map((a) => [a.exe, a.args, a.workdir].map(lowerPath).join(' ')).join(' ');
  const roots = [];
  if (consoleRoot) roots.push({ id: 'console', root: lowerPath(consoleRoot).replace(/\\+$/, '') });
  // discovery.js projects carry `dir`; `path` is accepted too.
  for (const p of projects || []) if (p && p.id && (p.dir || p.path)) roots.push({ id: p.id, root: lowerPath(p.dir || p.path).replace(/\\+$/, '') });
  roots.sort((a, b) => b.root.length - a.root.length);
  for (const r of roots) {
    let i = hay.indexOf(r.root);
    while (i >= 0) {
      const next = hay.charAt(i + r.root.length);
      if (next === '' || next === '\\' || next === '"' || next === ' ' || next === "'") return r.id;
      i = hay.indexOf(r.root, i + 1);
    }
  }
  return null;
}

function normTask(r, projects, consoleRoot) {
  const triggers = (Array.isArray(r.triggers) ? r.triggers : r.triggers ? [r.triggers] : []).map((t) => ({
    kind: triggerKind(t && t.kind), start: (t && t.start) || null, interval: (t && t.interval) || null, delay: (t && t.delay) || null, enabled: !t || t.enabled !== false,
  }));
  const actions = (Array.isArray(r.actions) ? r.actions : r.actions ? [r.actions] : []).map((a) => ({ exe: (a && a.exe) || '', args: (a && a.args) || '', workdir: (a && a.workdir) || '' }));
  const task = {
    name: String(r.name || ''), path: String(r.path || '\\'), state: String(r.state || 'Unknown'),
    author: r.author || '', description: r.description || '', lastRun: r.lastRun || null, nextRun: r.nextRun || null,
    lastResult: r.lastResult === undefined ? null : r.lastResult, triggers, actions,
  };
  task.full = task.path + task.name;
  task.enabled = task.state !== 'Disabled';
  task.result = resultText(task.lastResult);
  task.owner = ownerOf(task, projects, consoleRoot);
  task.notes = [];
  if (triggers.some((t) => t.kind === 'boot' || t.kind === 'logon')) task.notes.push('runs at boot/logon: adds work to every boot (delay it or keep it short)');
  if (!task.result.ok) task.notes.push('last run ' + task.result.text);
  return task;
}

// Real runner: execFile, hidden window, no shell, bounded time and output.
function realRunner(file, args, opts) {
  return new Promise((resolve) => {
    const env = opts && opts.env ? Object.assign({}, process.env, opts.env) : process.env;
    execFile(file, args, { windowsHide: true, timeout: (opts && opts.timeoutMs) || 60000, maxBuffer: 32 * 1048576, env }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && !stdout ? err.message : '') || '') });
    });
  });
}

function firstLine(s) {
  return String(s || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ').slice(0, 200);
}

class Scheduler {
  // opts: {runner, dataDir, runDir, projects: () => [{id, path}], consoleRoot, now, exists}
  constructor(opts) {
    opts = opts || {};
    this.runner = opts.runner || null;
    this.dataDir = opts.dataDir;
    this.runDir = opts.runDir || opts.dataDir;
    this.projectsFn = opts.projects || (() => []);
    this.consoleRoot = opts.consoleRoot || null;
    this.now = opts.now || (() => Date.now());
    this.exists = opts.exists;
    this.busy = null;
  }

  get available() { return typeof this.runner === 'function'; }

  log(line) {
    try {
      fs.mkdirSync(this.runDir, { recursive: true });
      fs.appendFileSync(path.join(this.runDir, 'scheduler.log'), new Date(this.now()).toISOString() + ' ' + line + '\n');
    } catch (e) { /* the log is best effort */ }
  }

  async rawList() {
    if (!this.available) return null;
    const r = await this.runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { timeoutMs: 60000 });
    if (r.code !== 0) return null;
    const text = String(r.stdout || '').trim();
    if (!text) return [];
    let j;
    try { j = JSON.parse(text); } catch (e) { return null; }
    return Array.isArray(j) ? j : j && typeof j === 'object' ? [j] : [];
  }

  async list(opts) {
    opts = opts || {};
    const raw = await this.rawList();
    if (!raw) return { available: false, error: this.available ? 'the task list could not be read' : 'scheduler not available', facts: FACTS, tasks: [], byProject: {} };
    const projects = this.projectsFn() || [];
    let tasks = raw.map((r) => normTask(r, projects, this.consoleRoot)).sort((a, b) => a.full.localeCompare(b.full));
    const byProject = {};
    for (const t of tasks) if (t.owner) byProject[t.owner] = (byProject[t.owner] || 0) + 1;
    if (opts.project) tasks = tasks.filter((t) => t.owner === opts.project);
    return { available: true, facts: FACTS, tasks, byProject, busy: this.busy };
  }

  async find(ref) {
    const l = await this.list();
    if (!l.available) return { list: l, task: null };
    return { list: l, task: l.tasks.find((t) => t.path.toLowerCase() === ref.path.toLowerCase() && t.name.toLowerCase() === ref.name.toLowerCase()) || null };
  }

  // The compact rows a repo's own status board / inbox would carry (self-report).
  async report(project) {
    const l = await this.list({ project });
    const tasks = l.tasks.map((t) => ({ name: t.name, path: t.path, state: t.state, ok: t.result.ok, result: t.result.text, lastRun: t.lastRun, nextRun: t.nextRun }));
    const failing = tasks.filter((t) => !t.ok).length;
    return { project, available: l.available, tasks, line: project + ': ' + tasks.length + ' task' + (tasks.length === 1 ? '' : 's') + ', ' + failing + ' failing' };
  }

  tmpFile(tag) {
    const dir = path.join(this.dataDir, 'scheduler', 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, tag + '-' + process.pid + '-' + stamp(this.now()) + '.xml');
  }

  async backup(ref) {
    const dir = path.join(this.dataDir, 'scheduler', 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, (ref.path.replace(/\\/g, '_') + ref.name).replace(/[^A-Za-z0-9._-]/g, '_') + '-' + stamp(this.now()) + '.xml');
    const r = await this.runner(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', PS_EXPORT], { env: { CC_SCHED_NAME: ref.name, CC_SCHED_PATH: ref.path, CC_SCHED_OUT: file } });
    let ok = r.code === 0;
    try { ok = ok && fs.statSync(file).size > 0; } catch (e) { ok = false; }
    return ok ? { ok: true, file } : { ok: false, error: 'backup failed: ' + (firstLine(r.stderr) || 'no XML written') };
  }

  async createXml(full, xml, force) {
    const file = this.tmpFile('create');
    fs.writeFileSync(file, utf16(xml));
    try {
      return await this.schtasks(['/Create', '/TN', full, '/XML', file].concat(force ? ['/F'] : []));
    } finally {
      try { fs.rmSync(file, { force: true }); } catch (e) { /* our own transient file */ }
    }
  }

  async schtasks(args) {
    const r = await this.runner(SCHTASKS, args, { timeoutMs: 60000 });
    return { ok: r.code === 0, error: r.code === 0 ? null : 'schtasks: ' + (firstLine(r.stderr) || firstLine(r.stdout) || 'exit ' + r.code) };
  }

  // Serialize writes; fn returns the response object.
  async write(label, fn) {
    if (!this.available) return { status: 503, error: 'scheduler not available' };
    if (this.busy) return { status: 409, error: 'a scheduler change is already running (' + this.busy + ')' };
    this.busy = label;
    try {
      const r = await fn();
      this.log(label + ' ' + (r.status < 300 ? 'ok' : 'failed ' + r.status + ' ' + (r.error || '')));
      return r;
    } catch (e) {
      this.log(label + ' crashed ' + (e && e.message));
      return { status: 500, error: 'scheduler change failed: ' + (e && e.message ? e.message : e) };
    } finally {
      this.busy = null;
    }
  }

  async add(input) {
    if (!this.available) return { status: 503, error: 'scheduler not available' };
    const v = validateSpec(input, { exists: this.exists });
    if (!v.ok) return { status: 400, error: v.error };
    const spec = v.spec;
    const full = spec.path + spec.name;
    if (this.busy) return { status: 409, error: 'a scheduler change is already running (' + this.busy + ')' };
    const f = await this.find(spec);
    if (!f.list.available) return { status: 503, error: f.list.error };
    if (f.task) return { status: 409, error: 'a task with that name exists; alter it instead' };
    return this.write('add ' + full, async () => {
      const c = await this.createXml(full, buildXml(spec, this.now()), false);
      if (!c.ok) return { status: 500, error: c.error };
      const back = (await this.find(spec)).task;
      if (back && matchesSpec(back, spec)) return { status: 201, task: back, readBack: true };
      const d = back ? await this.schtasks(['/Delete', '/TN', full, '/F']) : { ok: true };
      return { status: 500, error: 'read-back did not match the request; ' + (d.ok ? 'the new task was removed' : 'removing it failed: ' + d.error), rolledBack: d.ok, task: back };
    });
  }

  // patch: {enabled?: bool, trigger?: trigger spec, action?: {exe, args, workdir}}
  async alter(refIn, patch) {
    if (!this.available) return { status: 503, error: 'scheduler not available' };
    const ref = validRef(refIn);
    if (!ref.ok) return { status: 400, error: ref.error };
    patch = patch && typeof patch === 'object' ? patch : {};
    const want = {};
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') return { status: 400, error: 'enabled must be true or false' };
      want.enabled = patch.enabled;
    }
    if (patch.trigger !== undefined) {
      const t = validTrigger(patch.trigger);
      if (!t.ok) return { status: 400, error: t.error };
      want.trigger = t.trigger;
    }
    if (patch.action !== undefined) {
      const a = validAction(patch.action, this.exists);
      if (!a.ok) return { status: 400, error: a.error };
      want.action = a.action;
    }
    if (!Object.keys(want).length) return { status: 400, error: 'nothing to change' };
    if (this.busy) return { status: 409, error: 'a scheduler change is already running (' + this.busy + ')' };
    const f = await this.find(ref);
    if (!f.list.available) return { status: 503, error: f.list.error };
    if (!f.task) return { status: 404, error: 'no such task' };
    const before = f.task;
    const full = before.full;
    const real = { path: before.path, name: before.name };
    return this.write('alter ' + full, async () => {
      const b = await this.backup(real);
      if (!b.ok) return { status: 500, error: b.error };
      if (want.trigger || want.action) {
        let xml = readUtf16(b.file);
        if (want.trigger) xml = replaceBlock(xml, 'Triggers', triggersXml(want.trigger, this.now()));
        if (xml && want.action) xml = replaceBlock(xml, 'Actions', actionsXml(want.action));
        if (!xml) return { status: 500, error: 'the task XML has no block to replace', backup: b.file };
        const c = await this.createXml(full, xml, true);
        if (!c.ok) return { status: 500, error: c.error, backup: b.file };
      }
      if (want.enabled !== undefined) {
        const c = await this.schtasks(['/Change', '/TN', full, want.enabled ? '/ENABLE' : '/DISABLE']);
        if (!c.ok) return Object.assign(await this.restore(full, b.file, before, real), { error: c.error });
      }
      const back = (await this.find(real)).task;
      if (back && matchesPatch(back, want)) return { status: 200, task: back, backup: b.file, readBack: true };
      return Object.assign(await this.restore(full, b.file, before, real), { error: 'read-back did not match the change; restored from the backup' });
    });
  }

  async restore(full, file, before, real) {
    const c = await this.createXml(full, readUtf16(file), true);
    const back = c.ok ? (await this.find(real)).task : null;
    const same = !!back && sameTask(back, before);
    return { status: 500, rolledBack: c.ok, restoreReadBack: same, backup: file, task: back };
  }

  async remove(refIn) {
    if (!this.available) return { status: 503, error: 'scheduler not available' };
    const ref = validRef(refIn);
    if (!ref.ok) return { status: 400, error: ref.error };
    if (this.busy) return { status: 409, error: 'a scheduler change is already running (' + this.busy + ')' };
    const f = await this.find(ref);
    if (!f.list.available) return { status: 503, error: f.list.error };
    if (!f.task) return { status: 404, error: 'no such task' };
    const real = { path: f.task.path, name: f.task.name };
    const full = f.task.full;
    return this.write('remove ' + full, async () => {
      const b = await this.backup(real);
      if (!b.ok) return { status: 500, error: b.error };
      const d = await this.schtasks(['/Delete', '/TN', full, '/F']);
      if (!d.ok) return { status: 500, error: d.error, backup: b.file };
      const back = await this.find(real);
      if (!back.list.available || back.task) return { status: 500, error: 'read-back still shows the task', backup: b.file };
      return { status: 200, removed: full, backup: b.file, readBack: true };
    });
  }
}

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function actionMatches(task, a) {
  const x = task.actions[0];
  return task.actions.length === 1 && !!x && same(x.exe, a.exe) && (x.args || '') === (a.args || '') && same(x.workdir, a.workdir);
}

function triggerMatches(task, t) {
  return task.triggers.length === 1 && task.triggers[0].kind === t.kind && (!t.at || String(task.triggers[0].start || '').includes('T' + t.at));
}

function matchesSpec(task, spec) {
  return actionMatches(task, spec) && triggerMatches(task, spec.trigger) && task.enabled === spec.enabled;
}

function matchesPatch(task, want) {
  if (want.enabled !== undefined && task.enabled !== want.enabled) return false;
  if (want.trigger && !triggerMatches(task, want.trigger)) return false;
  if (want.action && !actionMatches(task, want.action)) return false;
  return true;
}

function sameTask(a, b) {
  const acts = (t) => t.actions.map((x) => [x.exe, x.args, x.workdir].map(lowerPath).join('|')).join(';');
  return a.enabled === b.enabled && acts(a) === acts(b) && a.triggers.map((t) => t.kind).join(',') === b.triggers.map((t) => t.kind).join(',');
}

module.exports = {
  POWERSHELL, SCHTASKS, PS_LIST, PS_EXPORT, BENIGN, FACTS, WRITE_KINDS, DAYS,
  resultText, triggerKind, validRef, validTrigger, validAction, validateSpec, buildXml, triggersXml, actionsXml,
  replaceBlock, ownerOf, normTask, realRunner, utf16, readUtf16, Scheduler,
};
