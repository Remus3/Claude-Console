'use strict';
// CON-013 L4: scheduled-task adapter of the setup profile, built on
// server/scheduler.js (its injected runner, its XML backup and its read-back).
// Windows only (Q10). Contract: profile-oscommon.js.
//
// - Only tasks named ClaudeProfile-<x> in the root folder are ever touched: the
//   profile never alters a task it did not create.
// - Per-task consent: opts.consent must be an object with that exact task name set to
//   true. A select-all (true, "*", a list) is refused (wizard step 8: one unticked box
//   per task).
// - Every task card says what the task runs, its trigger, its runtime cap, whether it
//   is hidden, and what it may delete and how (required text).
// - Profile tasks run with least privilege; an elevated run level is refused.
// - Replacing an existing task exports its XML first (no backup = no write), keeps a
//   copy in <txDir>/pre/tasks/, and a read-back mismatch restores it; a new task that
//   does not read back is deleted again.
// - setEnabled(name, false) is the "Stop everything" disable (never a delete).
const fs = require('fs');
const path = require('path');
const S = require('../server/scheduler');
const C = require('./profile-oscommon');

const NAME_RE = /^ClaudeProfile-[A-Za-z0-9._-]{1,66}$/;
const FOLDER = '\\';
const ASCII_RE = /^[\x09\x0a\x0d\x20-\x7e]*$/;

function unxml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const m = new RegExp('<' + name + '>([^<]*)</' + name + '>').exec(xml);
  return m ? unxml(m[1]) : '';
}

function minutes(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (+(m[1] || 0)) * 60 + (+(m[2] || 0)) + Math.round((+(m[3] || 0)) / 60);
}

// What a task XML does, for the consent card and the read-back compare.
function summarize(xml) {
  const triggers = [];
  // An empty trigger may be self-closing (<IdleTrigger />, the atlas refresh task):
  // 013-VERIFY sandbox F2 refused that task as "needs a trigger".
  const re = /<(TimeTrigger|CalendarTrigger|LogonTrigger|BootTrigger|IdleTrigger)(?:\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const body = m[2] || '';
    let kind = { TimeTrigger: 'once', LogonTrigger: 'logon', BootTrigger: 'boot', IdleTrigger: 'idle' }[m[1]];
    if (m[1] === 'CalendarTrigger') kind = /ScheduleByWeek/.test(body) ? 'weekly' : /ScheduleByMonth/.test(body) ? 'monthly' : 'daily';
    const sb = /<StartBoundary>[^<T]*T(\d{2}:\d{2})/.exec(body);
    const every = minutes(tag(body, 'Interval'));
    const delay = minutes(tag(body, 'Delay'));
    triggers.push({ kind, at: sb ? sb[1] : null, everyMinutes: every, delayMinutes: delay });
  }
  const execs = xml.match(/<Exec>/g) || [];
  const settings = (/<Settings>([\s\S]*?)<\/Settings>/.exec(xml) || [])[1] || '';
  return {
    triggers,
    execCount: execs.length,
    exe: tag(xml, 'Command'), args: tag(xml, 'Arguments'), workdir: tag(xml, 'WorkingDirectory'),
    enabled: !/<Enabled>false<\/Enabled>/.test(settings),
    hidden: /<Hidden>true<\/Hidden>/.test(settings),
    limitMinutes: minutes(tag(settings, 'ExecutionTimeLimit')),
    runLevel: tag(xml, 'RunLevel') || 'LeastPrivilege',
    userId: tag(xml, 'UserId'),
  };
}

function triggerText(t) {
  const parts = [t.kind + (t.at ? ' at ' + t.at : '')];
  if (t.everyMinutes) parts.push('every ' + t.everyMinutes + ' min');
  if (t.delayMinutes) parts.push('delayed ' + t.delayMinutes + ' min');
  return parts.join(', ');
}

// The XML rules every profile task meets; returns its summary, throws one line.
function checkXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('task XML required');
  if (!ASCII_RE.test(xml)) throw new Error('task XML must be ASCII');
  const sum = summarize(xml);
  if (sum.execCount !== 1 || !sum.exe) throw new Error('a profile task runs exactly one program');
  if (sum.runLevel !== 'LeastPrivilege') throw new Error('profile tasks run with least privilege (no HighestAvailable)');
  if (/^(SYSTEM|S-1-5-18|S-1-5-19|S-1-5-20)$/i.test(sum.userId)) throw new Error('profile tasks run as the user, never as a system account');
  if (!sum.triggers.length) throw new Error('a profile task needs a trigger');
  return sum;
}

function createTaskAdapter(opts) {
  opts = opts || {};
  const sched = opts.scheduler;
  if (!sched) throw new Error('scheduler required');
  const platform = opts.platform || process.platform;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = opts.now || (() => Date.now());

  // Contribution -> {name, xml, sum, deletes}; throws with one line on anything invalid.
  function normalize(c) {
    if (!c || typeof c !== 'object') throw new Error('task contribution required');
    if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) throw new Error('profile task names start with ClaudeProfile- (letters, digits, . _ -)');
    if (c.path !== undefined && c.path !== FOLDER) throw new Error('profile tasks live in the root task folder only');
    if (typeof c.deletes !== 'string' || !c.deletes.trim()) throw new Error('a task card must say what the task may delete and how (or "nothing")');
    let xml = c.xml;
    if (xml === undefined && c.spec) {
      const v = S.validateSpec(Object.assign({}, c.spec, { name: c.name, path: FOLDER }), { exists: opts.exists });
      if (!v.ok) throw new Error(v.error);
      xml = S.buildXml(v.spec, now());
    }
    const sum = checkXml(xml);
    return { name: c.name, full: FOLDER + c.name, ref: { path: FOLDER, name: c.name }, xml, sum, deletes: c.deletes.trim() };
  }

  function card(c) {
    const n = normalize(c);
    return {
      name: n.name,
      trigger: n.sum.triggers.map(triggerText).join('; '),
      runs: (n.sum.exe + (n.sum.args ? ' ' + n.sum.args : '')).trim(),
      workdir: n.sum.workdir,
      deletes: n.deletes,
      limitMinutes: n.sum.limitMinutes,
      hidden: n.sum.hidden,
      enabled: n.sum.enabled,
      consent: 'unticked',
    };
  }

  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  function matches(task, sum) {
    if (!task || task.actions.length !== 1) return false;
    const a = task.actions[0];
    return same(a.exe, sum.exe) && (a.args || '') === sum.args && same(a.workdir, sum.workdir) && task.enabled === sum.enabled
      && task.triggers.map((t) => t.kind).join(',') === sum.triggers.map((t) => t.kind).join(',');
  }

  function consentOk(consent, name) {
    if (!consent || typeof consent !== 'object' || Array.isArray(consent)) return false;
    if (Object.prototype.hasOwnProperty.call(consent, '*')) return false;
    return consent[name] === true;
  }

  async function plan(c) {
    const off = C.windowsOnly(platform);
    if (off) return Object.assign({ kind: 'task', name: c && c.name }, off);
    let n;
    try { n = normalize(c); } catch (e) { return { kind: 'task', name: c && c.name, status: 'refused', reason: e.message }; }
    const f = await sched.find(n.ref);
    if (!f.list.available) return { kind: 'task', name: n.name, status: 'unreadable', reason: f.list.error };
    const status = !f.task ? 'new' : matches(f.task, n.sum) ? 'same' : 'differs';
    return { kind: 'task', name: n.name, status, card: card(c) };
  }

  // Runs fn inside the scheduler's one-write-at-a-time lock; unwraps our result.
  async function locked(label, fn) {
    const r = await sched.write(label, async () => {
      const res = await fn();
      return { status: res.status === 'applied' || res.status === 'reverted' ? 200 : 500, error: res.reason, res };
    });
    return r.res || { status: 'failed', reason: r.error || 'scheduler busy or not available' };
  }

  function keepBackup(file, txDir, name) {
    const pre = C.preFile(txDir, 'tasks', name + '.xml');
    fs.copyFileSync(file, pre.abs);
    return pre.rel;
  }

  async function apply(c, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    let n;
    try { n = normalize(c); } catch (e) { return { status: 'refused', name: c && c.name, reason: e.message }; }
    const p = await plan(c);
    if (p.status === 'unreadable') return { status: 'failed', name: n.name, reason: p.reason };
    if (o.apply !== true) return { status: 'dry-run', name: n.name, plan: p };
    if (!consentOk(o.consent, n.name)) return { status: 'refused', name: n.name, reason: 'task ' + n.name + ' needs its own consent box ticked (no select-all)' };
    if (p.status === 'same') return { status: 'same', name: n.name, plan: p };
    const existing = p.status === 'differs';
    return locked('profile task ' + n.full, async () => {
      let prior = { present: false };
      let backup = null;
      if (existing) {
        const b = await sched.backup(n.ref);
        if (!b.ok) return { status: 'failed', name: n.name, reason: b.error + '; nothing written' };
        backup = b.file;
        const before = (await sched.find(n.ref)).task;
        prior = { present: true, pre: keepBackup(b.file, o.txDir, n.name), enabled: before ? before.enabled : true };
      }
      const entry = C.journalWrite(o, { kind: 'task', name: n.name, path: FOLDER, prior, applied: { sha256: C.sha256(n.xml) } });
      const w = await sched.createXml(n.full, n.xml, existing);
      const back = w.ok ? (await sched.find(n.ref)).task : null;
      if (back && matches(back, n.sum)) {
        log('task ' + n.name + (existing ? ' replaced' : ' added') + ' ok');
        return { status: 'applied', name: n.name, entry, backup };
      }
      let rolledBack;
      if (existing) rolledBack = (await sched.createXml(n.full, S.readUtf16(backup), true)).ok;
      else rolledBack = !back && !w.ok ? true : (await sched.schtasks(['/Delete', '/TN', n.full, '/F'])).ok;
      log('task ' + n.name + ' failed, rolled back ' + rolledBack);
      return { status: 'failed', name: n.name, reason: w.ok ? 'read-back did not match the task XML' : w.error, rolledBack, entry };
    });
  }

  function checkName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('only ClaudeProfile- tasks are managed by the profile');
    return { path: FOLDER, name };
  }

  async function setEnabled(name, enabled, o) {
    o = o || {};
    const ref = checkName(name);
    const off = C.windowsOnly(platform);
    if (off) return off;
    const f = await sched.find(ref);
    if (!f.list.available) return { status: 'failed', name, reason: f.list.error };
    if (!f.task) return { status: 'refused', name, reason: 'no such profile task' };
    if (f.task.enabled === enabled) return { status: 'same', name };
    if (o.apply !== true) return { status: 'dry-run', name, action: enabled ? 'enable' : 'disable' };
    const entry = C.journalWrite(o, { kind: 'task', op: 'enabled', name, path: FOLDER, prior: { present: true, enabled: f.task.enabled }, applied: { enabled } });
    const r = await sched.alter(ref, { enabled });
    if (r.status === 200) { log('task ' + name + (enabled ? ' enabled' : ' disabled')); return { status: 'applied', name, entry, backup: r.backup }; }
    return { status: 'failed', name, reason: r.error || 'alter failed', entry };
  }

  async function remove(name, o) {
    o = o || {};
    const ref = checkName(name);
    const off = C.windowsOnly(platform);
    if (off) return off;
    const f = await sched.find(ref);
    if (!f.list.available) return { status: 'failed', name, reason: f.list.error };
    if (!f.task) return { status: 'same', name };
    if (o.apply !== true) return { status: 'dry-run', name, action: 'remove (XML backup first)' };
    const b = await sched.backup(ref);
    if (!b.ok) return { status: 'failed', name, reason: b.error };
    const entry = C.journalWrite(o, { kind: 'task', name, path: FOLDER, prior: { present: true, pre: keepBackup(b.file, o.txDir, name), enabled: f.task.enabled }, applied: { present: false } });
    const r = await sched.remove(ref);
    return r.status === 200 ? { status: 'applied', name, entry } : { status: 'failed', name, reason: r.error, entry };
  }

  async function revert(entry, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    if (!entry || entry.kind !== 'task' || !entry.prior) return { status: 'refused', reason: 'not a task journal entry' };
    const ref = checkName(entry.name);
    if (entry.op === 'enabled') {
      if (o.apply !== true) return { status: 'dry-run', name: entry.name, action: entry.prior.enabled ? 'enable' : 'disable' };
      const r = await sched.alter(ref, { enabled: entry.prior.enabled });
      return r.status === 200 || (r.status === 400 && /nothing/.test(r.error || '')) ? { status: 'reverted', name: entry.name } : { status: 'failed', name: entry.name, reason: r.error };
    }
    if (!entry.prior.present) {
      if (o.apply !== true) return { status: 'dry-run', name: entry.name, action: 'remove (XML backup first)' };
      const r = await sched.remove(ref);
      if (r.status === 200 || r.status === 404) { log('task ' + entry.name + ' revert removed'); return { status: 'reverted', name: entry.name, backup: r.backup || null }; }
      return { status: 'failed', name: entry.name, reason: r.error };
    }
    if (o.apply !== true) return { status: 'dry-run', name: entry.name, action: 'restore the exported XML' };
    const xml = S.readUtf16(path.join(o.txDir, ...entry.prior.pre.split('/')));
    return locked('profile task revert ' + FOLDER + entry.name, async () => {
      const w = await sched.createXml(FOLDER + entry.name, xml, true);
      const back = w.ok ? (await sched.find(ref)).task : null;
      const ok = !!back && back.enabled === entry.prior.enabled;
      log('task ' + entry.name + ' revert ' + (ok ? 'ok' : 'failed'));
      return ok ? { status: 'reverted', name: entry.name } : { status: 'failed', name: entry.name, reason: w.error || 'restore did not read back' };
    });
  }

  return { card, plan, apply, setEnabled, remove, revert, summarize };
}

// ------------------------------------------------------------------ engine adapter
// INTEGRATE-1: the synchronous surface installer/profile-tx.js, profile-plan.js,
// profile-verify.js and recover.js call (deps.tasks), straight onto schtasks.exe through
// an injected sync runner, with the same rules as createTaskAdapter: ClaudeProfile-
// names in the root folder only, and register() refuses XML that fails checkXml (one
// program, least privilege, user account, a trigger, ASCII).
//   get(name)            -> {present: false} | {present: true, enabled, xml}
//   exportXml(name)      -> the task XML (the engine's backup before any change) | null
//   register(name, xml)  create, or replace (/F) when present; read back present
//   remove(name)         schtasks /Delete; read back absent
//   setEnabled(name, on) /ENABLE | /DISABLE (the "Stop everything" disable); read back
// A failed /Query is "absent" only when the full task list reads and lacks the name;
// any other failure throws (never a silent overwrite). Per-task consent is the engine's
// high-risk ack gate here; createTaskAdapter keeps its own consent object.
const SCHTASKS = S.SCHTASKS;

function createAdapter(o) {
  o = o || {};
  const runner = o.runnerSync || C.realRunnerSync;
  const platform = o.platform || process.platform;
  const tmp = o.tmpDir || require('os').tmpdir();

  function st(args) {
    if (C.windowsOnly(platform)) throw new Error('task adapter: Windows only');
    const r = runner(SCHTASKS, args, { timeoutMs: 60000 });
    return { ok: r.code === 0, out: String(r.stdout || ''), err: 'schtasks: ' + (C.firstLine(r.stderr) || C.firstLine(r.stdout) || 'exit ' + r.code) };
  }

  const full = (name) => {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('only ClaudeProfile- tasks are managed by the profile');
    return FOLDER + name;
  };

  function exportXml(name) {
    const tn = full(name);
    const q = st(['/Query', '/TN', tn, '/XML']);
    if (q.ok) return q.out;
    const all = st(['/Query', '/FO', 'CSV', '/NH']);
    if (!all.ok) throw new Error(q.err);
    const listed = all.out.split(/\r?\n/).some((l) => ((/^"([^"]*)"/.exec(l) || [])[1] || '').toLowerCase() === tn.toLowerCase());
    if (listed) throw new Error(q.err);
    return null;
  }

  function get(name) {
    const xml = exportXml(name);
    if (xml === null) return { present: false };
    return { present: true, enabled: summarize(xml).enabled, xml };
  }

  function register(name, xml) {
    const tn = full(name);
    checkXml(xml);
    const exists = get(name).present;
    const f = path.join(tmp, 'cc-task-' + process.pid + '-' + Date.now() + '.xml');
    fs.writeFileSync(f, S.utf16(xml));
    let w;
    try { w = st(['/Create', '/TN', tn, '/XML', f].concat(exists ? ['/F'] : [])); } finally { try { fs.rmSync(f, { force: true }); } catch (e) { /* scratch */ } }
    if (!w.ok) throw new Error(w.err);
    if (!get(name).present) throw new Error('task ' + name + ' did not read back');
  }

  function remove(name) {
    const w = st(['/Delete', '/TN', full(name), '/F']);
    if (!w.ok && get(name).present) throw new Error(w.err);
    if (get(name).present) throw new Error('task ' + name + ' still present');
  }

  function setEnabled(name, on) {
    const w = st(['/Change', '/TN', full(name), on ? '/ENABLE' : '/DISABLE']);
    if (!w.ok) throw new Error(w.err);
    if (get(name).enabled !== !!on) throw new Error('task ' + name + ' did not read back ' + (on ? 'enabled' : 'disabled'));
  }

  return { get, exportXml, register, remove, setEnabled };
}

module.exports = { createTaskAdapter, createAdapter, checkXml, summarize, NAME_RE };
