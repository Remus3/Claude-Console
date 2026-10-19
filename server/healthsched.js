'use strict';
// CON-HEALTH-SCHED (S49 operator intake 2026-10-18): the machine health check runs from
// the v19.1 Health & cleanup button (server/health.js) OR on a schedule. The schedule is
// ONE Windows task, registered, altered and disabled only through the CON-SCHEDULER
// service (server/scheduler.js: backup first, read back, roll back), whose action is the
// fixed argv `<pythonw> "<plugin root>\<plugin script>" scheduled`. That subcommand runs
// the delete-free step set, appends the run to ops/insights/health/<day>.json (source
// "scheduled") and writes ONE status line to ops/insights/health/status.txt, which this
// module shows. Main-only: it needs the optional plugin config (root + full python
// path); without it the state says why and every write is refused.
const fs = require('fs');
const path = require('path');
const S = require('./scheduler');

const TASK = Object.freeze({ path: '\\', name: 'ClaudeConsole-HealthCheck' });
const DEFAULT_AT = '07:30';
// The script is the plugin config's (mc.script, relative to mc.root).
const description = (script) => 'Scheduled machine health check (console CON-HEALTH-SCHED): ' + String(script).replace(/\\/g, '/') + ' scheduled, read-only steps.';

class HealthSchedule {
  // opts: {scheduler, mc: {root, python, reportDir} | null, exists}
  constructor(opts) {
    opts = opts || {};
    this.scheduler = opts.scheduler || null;
    this.mc = opts.mc || null;
    this.exists = opts.exists || fs.existsSync;
  }

  // Why the schedule cannot be used, or null.
  unavailable() {
    if (!this.mc) return 'the scheduled health check needs a plugin (plugins.main in the console config)';
    if (typeof this.mc.script !== 'string' || !this.mc.script || path.isAbsolute(this.mc.script) || this.mc.script.includes('..')) return 'the plugin config names no health script';
    if (!this.scheduler || !this.scheduler.available) return 'the task scheduler is not available';
    if (typeof this.mc.python !== 'string' || !path.win32.isAbsolute(this.mc.python) || !this.exists(this.mc.python)) return 'plugins.main.python must be the full path to python.exe for a scheduled run';
    return null;
  }

  exe() {
    const py = this.mc.python;
    if (/python\.exe$/i.test(py)) {
      const w = py.replace(/python\.exe$/i, 'pythonw.exe');
      if (this.exists(w)) return w; // no console window for the unattended run
    }
    return py;
  }

  spec(sched) {
    const trigger = Array.isArray(sched.days) ? { kind: 'weekly', at: sched.at, days: sched.days } : { kind: 'daily', at: sched.at };
    return {
      path: TASK.path, name: TASK.name, description: description(this.mc.script), enabled: true, limitMinutes: 30,
      exe: this.exe(), args: '"' + path.join(this.mc.root, this.mc.script) + '" scheduled', workdir: this.mc.root, trigger,
    };
  }

  readStatusLine() {
    try {
      const s = fs.readFileSync(path.join(this.mc.reportDir, 'status.txt'), 'utf8').split(/\r?\n/)[0].trim();
      return s ? s.slice(0, 240) : null;
    } catch (e) { return null; }
  }

  // Newest run with source "scheduled", newest day file first.
  readLastRun() {
    let files = [];
    try { files = fs.readdirSync(this.mc.reportDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse(); } catch (e) { return null; }
    for (const f of files.slice(0, 14)) {
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(path.join(this.mc.reportDir, f), 'utf8')); } catch (e) { doc = null; }
      const runs = doc && Array.isArray(doc.runs) ? doc.runs : [];
      for (let i = runs.length - 1; i >= 0; i--) {
        const r = runs[i];
        if (r && r.source === 'scheduled') return { status: String(r.status || ''), startedAtIso: r.startedAtIso || null, findings: r.findings | 0 };
      }
    }
    return null;
  }

  async task() {
    const l = await this.scheduler.list();
    if (!l.available) return { ok: false, task: null };
    return { ok: true, task: l.tasks.find((t) => t.path.toLowerCase() === TASK.path.toLowerCase() && t.name.toLowerCase() === TASK.name.toLowerCase()) || null };
  }

  async state() {
    const why = this.unavailable();
    if (why) return { available: false, reason: why, enabled: false, task: null, schedule: null, statusLine: this.mc ? this.readStatusLine() : null, lastRun: this.mc ? this.readLastRun() : null };
    const t = await this.task();
    const task = t.task;
    let schedule = null;
    if (task && task.triggers.length === 1 && ['daily', 'weekly'].includes(task.triggers[0].kind)) {
      const m = /T(\d{2}:\d{2})/.exec(String(task.triggers[0].start || ''));
      schedule = { kind: task.triggers[0].kind, at: m ? m[1] : null };
    }
    return { available: true, reason: t.ok ? null : 'the task list could not be read', enabled: !!(task && task.enabled), task, schedule, statusLine: this.readStatusLine(), lastRun: this.readLastRun(), defaultAt: DEFAULT_AT };
  }

  // body: {enabled: bool, at?: 'HH:MM', days?: ['Mon', ...]} -> {status, error?, ...state}
  async set(body) {
    if (!body || typeof body !== 'object' || typeof body.enabled !== 'boolean') return { status: 400, error: 'enabled must be true or false' };
    if (body.at !== undefined && (typeof body.at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.at))) return { status: 400, error: 'time must be HH:MM' };
    if (body.days !== undefined && (!Array.isArray(body.days) || !body.days.length || body.days.some((d) => !S.DAYS.includes(d)))) return { status: 400, error: 'days must be a list from ' + S.DAYS.join(' ') };
    const why = this.unavailable();
    if (why) return { status: 503, error: why };
    const cur = await this.task();
    if (!cur.ok) return { status: 503, error: 'the task list could not be read' };
    let r;
    if (!body.enabled) {
      if (!cur.task) return Object.assign({ status: 200 }, await this.state());
      r = await this.scheduler.alter(TASK, { enabled: false });
    } else {
      const st = await this.state();
      const at = body.at || (st.schedule && st.schedule.at) || DEFAULT_AT;
      const sp = this.spec({ at, days: body.days });
      if (!cur.task) r = await this.scheduler.add(sp);
      else r = await this.scheduler.alter(TASK, { trigger: sp.trigger, action: { exe: sp.exe, args: sp.args, workdir: sp.workdir }, enabled: true });
    }
    if (r.status >= 300) return { status: r.status, error: r.error, rolledBack: r.rolledBack };
    return Object.assign({ status: 200 }, await this.state());
  }
}

module.exports = { TASK, DEFAULT_AT, HealthSchedule };
