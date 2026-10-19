'use strict';
// Setup profile engine, part 3 (CON-013 L3): the transaction. applyPlan() writes a plan
// from profile-plan.js; revertTx() undoes one transaction from its journal.
//
//   <dataDir>/profile/tx/<stamp>/plan.json      the rows (no file contents, no values)
//                               journal.jsonl   one intent line BEFORE each write, one
//                                               done line after its read-back
//                               pre/            pre-images and prior values (files,
//                                               JSON keys, git values, task XML, env
//                                               snapshots from the env adapter)
//                               report.json     result + the suggested commit
//                               revert.json     written when the tx is reverted
//
// Floors: dry run unless confirm === true; high-risk items need an ack each (or the
// grouped consent of the preset path); an unreadable target or an unresolved conflict
// refuses the whole plan; writes are atomic (temp + rename) and read back, the first
// mismatch rolls the whole transaction back; created files leave through the Recycle
// Bin (deps.recycle), never a direct unlink; env values never reach the journal; the
// engine never commits - it prints the suggested message and the paths to stage.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./profile');
const PL = require('./profile-plan');
const { stamp } = require('./paths');
const { readJson, exists, recycleWindows } = require('./fsutil');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Registered contribution kinds (closed list, design a.3 + addendum a.3). Each kind is
// planned by profile-plan.js and written here; app-config is delegated to deps.appConfig
// (L9's adapter), env / task to L4's adapters, git to the built-in local git adapter.
const KINDS = Object.freeze({
  file: 'file', block: 'file', 'json-merge': 'file', kit: 'file',
  env: 'machine', git: 'machine', task: 'machine', 'app-config': 'machine',
});

function txRoot(dataDir) { return path.join(P.profileStateDir(dataDir), 'tx'); }
function targetsFile(dataDir) { return path.join(P.profileStateDir(dataDir), 'targets.json'); }

function newTxId(dataDir, now) {
  const base = stamp(now);
  fs.mkdirSync(txRoot(dataDir), { recursive: true });
  for (let i = 1; i < 1000; i++) {
    const id = base + '-' + String(i).padStart(3, '0');
    const d = path.join(txRoot(dataDir), id);
    try { fs.mkdirSync(d); return id; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('no free transaction id');
}

function atomicWrite(file, buf) {
  const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

// Missing ancestor dirs of file, deepest first (created by the write, removed again by a
// revert only while empty).
function missingDirs(file) {
  const out = [];
  let d = path.dirname(file);
  while (!exists(d)) { out.push(d); const up = path.dirname(d); if (up === d) break; d = up; }
  return out;
}

function defaultRecycle(dataDir) {
  if (process.platform === 'win32') return recycleWindows;
  // Elsewhere: a move into the profile's own trash folder (never an unlink).
  return async (p) => {
    const dst = path.join(P.profileStateDir(dataDir), 'trash', stamp() + '-' + crypto.randomBytes(3).toString('hex'), path.basename(p));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(p, dst);
    return true;
  };
}

// Built-in git adapter: `git -C <repo> config --local`. Values here are never secrets
// (the schema refuses secret-like git values).
function gitAdapter(runner) {
  const { spawnSync } = require('child_process');
  const run = runner || ((args) => spawnSync('git', args, { windowsHide: true, encoding: 'utf8' }));
  return {
    get(repo, key) { const r = run(['-C', repo, 'config', '--local', '--get', key]); return r.status === 0 ? String(r.stdout).replace(/\r?\n$/, '') : null; },
    set(repo, key, value) { const r = run(['-C', repo, 'config', '--local', key, value]); if (r.status !== 0) throw new Error('git config failed'); },
    unset(repo, key) { run(['-C', repo, 'config', '--local', '--unset', key]); },
  };
}

// Default adapters: L4's modules when present, else none (env / task items then plan as
// unreadable - never a silent no-op). INTEGRATE-1: each module's createAdapter(o) is its
// synchronous engine surface (o.dataDir gives the env adapter its secret store).
function defaultAdapters(o) {
  o = o || {};
  const out = { git: gitAdapter() };
  for (const [k, mod] of [['env', './profile-env'], ['tasks', './profile-tasks'], ['appConfig', './profile-appconfig']]) {
    try { const m = require(mod); out[k] = typeof m.createAdapter === 'function' ? m.createAdapter(o) : m; } catch (e) { /* not installed */ }
  }
  return out;
}

// ------------------------------------------------------------------ gate

function gate(p, o) {
  if (!o || o.confirm !== true) return { ok: false, code: 1, line: 'dry run: nothing written (add --apply --yes after reviewing the plan)' };
  const v = PL.planVerdict(p);
  if (v.code) return { ok: false, code: v.code, line: v.line };
  const acks = new Set(o.acks || []);
  for (const a of p.needsAck) if (!acks.has(a)) return { ok: false, code: 1, line: 'refused: ' + a + ' needs the typed acknowledgement --ack ' + a };
  if (!o.groupedConsent) for (const id of p.highRisk) if (!acks.has(id)) return { ok: false, code: 1, line: 'refused: ' + id + ' is high risk; add --ack ' + id + ' after reading what it does' };
  const tc = taskConsentCheck(p, o.taskConsent, o.groupedConsent === true);
  if (!tc.ok) return { ok: false, code: 1, line: tc.line };
  return { ok: true, consent: tc.record };
}

// ------------------------------------------------------------------ per-task consent
// (L3x fix b, L4's rule restored) Registering or replacing a scheduled task needs the
// user's consent for THAT task; the high-risk ack never stands in for it.
//   custom path: taskConsent = {mode: 'per-task', tasks: {<name>: true, ...}}
//                (one unticked box per task; a select-all such as "*" is refused)
//   preset path: taskConsent = {mode: 'grouped', yes: true, listed: [<names>]}
//                (ONE yes / no shown with the list of every task; the list the user saw
//                must name every task the plan registers)
// Both are journaled as the transaction's first line (seq 0, op "consent").
function tasksNeedingConsent(p) {
  return (p.machine || []).filter((m) => m.kind === 'task' && m.op === 'set').map((m) => ({ name: m.name, item: m.item, status: m.status }));
}

function taskConsentCheck(p, c, presetPath) {
  const need = tasksNeedingConsent(p);
  if (!need.length) return { ok: true, record: null };
  const names = need.map((t) => t.name);
  const isObj2 = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj2(c) && c.mode === 'grouped') {
    if (c.yes !== true) return { ok: false, line: 'refused: the grouped scheduled-task consent was answered no; nothing written' };
    const listed = new Set(Array.isArray(c.listed) ? c.listed : []);
    const miss = names.find((n) => !listed.has(n));
    if (miss) return { ok: false, line: 'refused: the grouped consent did not list ' + miss + '; show every task and ask again' };
    return { ok: true, record: { mode: 'grouped', yes: true, tasks: names } };
  }
  if (isObj2(c) && c.mode === 'per-task' && isObj2(c.tasks)) {
    if (Object.prototype.hasOwnProperty.call(c.tasks, '*')) return { ok: false, line: 'refused: scheduled tasks need one consent each (no select-all)' };
    const miss = names.find((n) => c.tasks[n] !== true);
    if (miss) return { ok: false, line: 'refused: scheduled task ' + miss + ' needs its own consent (--consent-task ' + miss + ')' };
    return { ok: true, record: { mode: 'per-task', tasks: names } };
  }
  // Nothing usable (absent, true, a list, a bare ack): the preset path (groupedConsent)
  // names the grouped ask, the custom path names the first task.
  return { ok: false, line: presetPath ? 'refused: the preset path needs one grouped consent that lists every scheduled task (' + names.join(', ') + ')' : 'refused: scheduled task ' + names[0] + ' needs its own consent (--consent-task ' + names[0] + ')' };
}

// ------------------------------------------------------------------ apply

// o: {model, dataDir, confirm, acks, groupedConsent, selection, deps, now}
async function applyPlan(p, o) {
  o = o || {};
  const g = gate(p, o);
  if (!g.ok) return Object.assign({ applied: false }, g);
  const dataDir = o.dataDir;
  const deps = Object.assign({}, o.deps || {});
  const recycle = deps.recycle || defaultRecycle(dataDir);
  const id = newTxId(dataDir, o.now);
  const dir = path.join(txRoot(dataDir), id);
  const preDir = path.join(dir, 'pre');
  fs.mkdirSync(preDir, { recursive: true });
  const journalFile = path.join(dir, 'journal.jsonl');
  const journal = [];
  const log = (obj) => { fs.appendFileSync(journalFile, JSON.stringify(obj) + '\n'); };
  let seq = 0;
  const savePre = (name, buf) => { fs.writeFileSync(path.join(preDir, name), buf); return name; };
  const ref = (name) => ({ tx: id, ref: name });
  writeJsonPlain(path.join(dir, 'plan.json'), { tx: id, target: p.target, rows: p.rows, counts: p.counts, desired: p.desired, removing: p.removing, at: (o.now || new Date()).toISOString() });
  // The scheduled-task consent the user gave, before any write (seq 0; nothing to undo).
  if (g.consent) log(Object.assign({ seq: 0, op: 'consent', kind: 'tasks' }, g.consent, { at: (o.now || new Date()).toISOString() }));

  const lockNext = JSON.parse(JSON.stringify(p.lockNext));
  const written = [];
  const flagged = [];
  let failure = null;

  async function doWrite(e, after) {
    e.dirs = missingDirs(e.abs);
    log(e);
    journal.push(e);
    if (after === null) {
      await recycle(e.abs);
      if (exists(e.abs)) throw new Error('read-back: ' + e.display + ' still present after the Recycle Bin move');
    } else {
      fs.mkdirSync(path.dirname(e.abs), { recursive: true });
      atomicWrite(e.abs, after);
      if (sha(fs.readFileSync(e.abs)) !== e.applied_sha) throw new Error('read-back mismatch: ' + e.display);
    }
    e.done = true;
    log({ seq: e.seq, done: true });
    written.push(e.display);
  }

  try {
    // 1) Files.
    for (const f of p.files) {
      if (!['new', 'differs', 'removed'].includes(f.status) || f.keep) {
        if (f.keep && f.removedSide) {
          const pre = PL.readPre(dataDir, f.removedSide);
          if (pre) {
            const s = ++seq;
            await doWrite({ seq: s, op: 'write', abs: f.abs + '.profile-removed', display: f.display + '.profile-removed', items: f.items, created: true, pre: null, applied_sha: sha(pre) }, pre);
          }
        }
        if (f.flag) flagged.push(f.display + ': ' + f.flag);
        continue;
      }
      const s = ++seq;
      const e = { seq: s, op: f.after === null ? 'delete' : 'write', abs: f.abs, display: f.display, items: f.items, created: f.before === null,
        pre: f.before === null ? null : savePre(String(s), f.before), applied_sha: f.after === null ? null : sha(f.after) };
      // Prior JSON key values (for the lock and for a key-level revert of an edited file).
      const lockSide = f.side === 'repo' ? lockNext.repo : lockNext.user;
      const le = lockSide && lockSide.files[f.rel];
      if (le) {
        if (le.pre === 'PENDING') le.pre = ref(e.pre);
        let k = 0;
        for (const [kp, kv] of Object.entries(le.keys || {})) {
          if (kv.prior === 'PENDING') {
            const pr = f.keysPrior[kp];
            kv.prior = pr && !pr.absent ? ref(savePre(s + '-k' + (k++) + '.json', Buffer.from(JSON.stringify({ v: pr.value })))) : 'absent';
          }
        }
        e.keys = le.keys || null;
        e.blocks = le.blocks || null;
        if (e.blocks && f.before) {
          for (const [name] of Object.entries(e.blocks)) {
            const mk = PL.markersFor(f.abs, name);
            const found = mk ? PL.findBlock(f.before.toString('utf8'), mk) : null;
            e.blocks[name] = Object.assign({}, e.blocks[name], { prior: found && !found.bad ? ref(savePre(s + '-b-' + name + '.txt', Buffer.from(found.inner, 'utf8'))) : 'absent' });
          }
        }
      }
      await doWrite(e, f.after);
    }
    // 2) Machine effects.
    for (const m of p.machine) {
      if (m.op === 'none') continue;
      const s = ++seq;
      if (m.kind === 'env') await machineEnv(m, s);
      else if (m.kind === 'git') await machineGit(m, s);
      else if (m.kind === 'task') await machineTask(m, s);
      else if (m.kind === 'app-config') await machineApp(m, s);
    }
    // 3) Locks (with the dirs the profile created, swept again once empty), targets, selection.
    for (const side of ['repo', 'user']) {
      const lock = lockNext[side];
      const root = p.roots && p.roots[side];
      const lockPath = p.lockPaths[side];
      if (!lock || !lockPath) continue;
      if (root) {
        const mine = new Set(lock.dirs || []);
        const lockDirs = exists(lockPath) ? [] : missingDirs(lockPath);
        for (const e of journal.concat([{ dirs: lockDirs }])) for (const d of e.dirs || []) {
          const rel = path.relative(root, d).replace(/\\/g, '/');
          if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) mine.add(rel);
        }
        lock.dirs = [...mine].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
      }
      const empty = isEmptyLock(lock);
      if (!empty && root) sweepDirs(lock, root, lockPath);
      await writeState(lockPath, side === 'repo' ? 'repo:' + PL.LOCK_REL : 'data:profile/locks/user.json', lock, true);
      if (empty && root) sweepDirs(lock, root);
    }
    if (p.target.repo) {
      const tf = targetsFile(dataDir);
      const cur = readJson(tf, null);
      const list = isObj(cur) && Array.isArray(cur.repos) ? cur.repos.slice() : [];
      const norm = path.resolve(p.target.repo);
      if (!list.some((r) => path.resolve(r) === norm)) await writeState(tf, 'data:profile/targets.json', { schema: 1, repos: list.concat([norm]) }, false);
    }
    if (o.selection) await writeState(P.selectionFile(dataDir), 'data:profile/selection.json', o.selection, false);
  } catch (err) {
    failure = { item: (journal[journal.length - 1] || {}).items ? journal[journal.length - 1].items[0] : null, reason: String(err.message || err).slice(0, 200) };
  }

  async function machineEnv(m, s) {
    const a = deps.env;
    if (!a) throw new Error('env adapter not installed');
    if (m.op === 'set') {
      const snap = a.snapshot(m.name);
      const e = { seq: s, op: 'env', name: m.name, items: [m.item], prior: savePre(s + '.env.json', Buffer.from(JSON.stringify(snap || { absent: true }))) };
      log(e); journal.push(e);
      a.set(m.name, m.secret !== undefined ? { secret: m.secret } : { value: m.value });
      const g = a.get(m.name) || {};
      if (!g.present || (m.value !== undefined && g.sha256 !== sha(Buffer.from(m.value, 'utf8')))) throw new Error('read-back mismatch: env ' + m.name);
      setLockPrior(lockNext.user, 'env', m.name, snap && snap.absent ? 'absent' : ref(e.prior));
      // What the next plan compares against (L3x fix a): the variable's sha256 and, for
      // a secret mirror, the reference and the sha256 of the DPAPI file it came from.
      const le = lockNext.user && lockNext.user.env ? lockNext.user.env[m.name] : null;
      if (le && g.sha256) {
        le.sha256 = g.sha256;
        if (m.secret !== undefined) { le.secret = m.secret; le.secretFileSha = PL.secretFileSha(dataDir, m.secret); }
      }
      e.done = true; log({ seq: s, done: true }); written.push('env:' + m.name);
    } else {
      const now = a.snapshot(m.name);
      const e = { seq: s, op: 'env', name: m.name, items: [m.item], prior: savePre(s + '.env.json', Buffer.from(JSON.stringify(now || { absent: true }))) };
      log(e); journal.push(e);
      if (m.prior === 'absent' || !m.prior) a.unset(m.name);
      else {
        const pre = PL.readPre(dataDir, m.prior);
        if (!pre) throw new Error('prior value missing: env ' + m.name);
        a.restore(m.name, JSON.parse(pre.toString('utf8')));
      }
      e.done = true; log({ seq: s, done: true }); written.push('env:' + m.name);
    }
  }

  async function machineGit(m, s) {
    const a = deps.git || gitAdapter();
    const repo = p.target.repo;
    const cur = a.get(repo, m.key);
    const e = { seq: s, op: 'git', repo, key: m.key, items: [m.item], prior: cur === null ? 'absent' : savePre(s + '.git.json', Buffer.from(JSON.stringify({ v: cur }))) };
    log(e); journal.push(e);
    let want;
    if (m.op === 'set') want = m.value;
    else if (m.prior === 'absent' || !m.prior) want = null;
    else { const pre = PL.readPre(dataDir, m.prior); if (!pre) throw new Error('prior value missing: git ' + m.key); want = JSON.parse(pre.toString('utf8')).v; }
    if (want === null) a.unset(repo, m.key); else a.set(repo, m.key, want);
    if (a.get(repo, m.key) !== want) throw new Error('read-back mismatch: git ' + m.key);
    if (m.op === 'set') setLockPrior(lockNext.repo, 'git', m.key, e.prior === 'absent' ? 'absent' : ref(e.prior));
    e.done = true; log({ seq: s, done: true }); written.push('git:' + m.key);
  }

  async function machineTask(m, s) {
    const a = deps.tasks;
    if (!a) throw new Error('task adapter not installed');
    const xml = a.exportXml(m.name); // backup before any change
    const e = { seq: s, op: 'task', name: m.name, items: [m.item], prior: xml === null || xml === undefined ? 'absent' : savePre(s + '.task.xml', Buffer.from(String(xml), 'utf8')) };
    log(e); journal.push(e);
    if (m.op === 'set') {
      a.register(m.name, m.xml);
      if (!(a.get(m.name) || {}).present) throw new Error('read-back: task ' + m.name + ' not registered');
      setLockPrior(lockNext.user, 'tasks', m.name, e.prior === 'absent' ? 'absent' : ref(e.prior));
    } else if (m.prior === 'absent' || !m.prior) {
      a.remove(m.name);
      if ((a.get(m.name) || {}).present) throw new Error('read-back: task ' + m.name + ' still present');
    } else {
      const pre = PL.readPre(dataDir, m.prior);
      if (!pre) throw new Error('prior XML missing: task ' + m.name);
      a.register(m.name, pre.toString('utf8'));
    }
    e.done = true; log({ seq: s, done: true }); written.push('task:' + m.name);
  }

  async function machineApp(m, s) {
    const a = deps.appConfig;
    if (!a) throw new Error('app-config adapter not installed');
    const e = { seq: s, op: 'app-config', items: [m.item], token: null };
    log(e); journal.push(e);
    const r = await a.apply(m, { preDir, seq: s });
    e.token = r && r.token !== undefined ? r.token : null;
    e.done = true; log({ seq: s, done: true, token: e.token }); written.push('app-config:' + (m.display || m.item));
  }

  // Removes the profile-created dirs that are empty now (deepest first), journaled so a
  // revert recreates them. Only empty dirs: no file is ever deleted here.
  function sweepDirs(lock, root, lockPath) {
    const keep = [];
    for (const rel of lock.dirs || []) {
      const abs = path.join(root, ...rel.split('/'));
      let empty = false;
      try { empty = fs.readdirSync(abs).length === 0; } catch (e) {
        // Not there (yet): kept only when the lock file about to be written lives in it.
        if (lockPath && path.resolve(lockPath).startsWith(path.resolve(abs) + path.sep)) keep.push(rel);
        continue;
      }
      if (!empty) { keep.push(rel); continue; }
      const s = ++seq;
      const e = { seq: s, op: 'rmdir', abs, display: rel, items: [] };
      log(e); journal.push(e);
      fs.rmdirSync(abs);
      e.done = true; log({ seq: s, done: true });
    }
    lock.dirs = keep;
  }

  async function writeState(file, display, obj, dropWhenEmpty) {
    const before = exists(file) ? fs.readFileSync(file) : null;
    const empty = dropWhenEmpty && isEmptyLock(obj);
    if (empty && before === null) return;
    const after = empty ? null : Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8');
    if (before && after && Buffer.compare(before, after) === 0) return;
    const s = ++seq;
    await doWrite({ seq: s, op: after === null ? 'delete' : 'write', abs: file, display, items: [], created: before === null, pre: before ? savePre(String(s), before) : null, applied_sha: after ? sha(after) : null, state: true }, after);
  }

  if (failure) {
    const rb = await undoJournal(journal, { dataDir, deps, recycle, force: true, txId: id });
    const report = { tx: id, ok: false, failed: failure, rolledBack: rb.ok, rollbackFlags: rb.flagged };
    writeJsonPlain(path.join(dir, 'report.json'), report);
    writeJsonPlain(path.join(dir, 'revert.json'), { at: new Date().toISOString(), ok: rb.ok, rollback: true, flagged: rb.flagged });
    return { applied: false, ok: false, code: 1, tx: id, line: 'failed at ' + (failure.item || '?') + ': ' + failure.reason + ' - rolled back' + (rb.ok ? '' : ' (with flags)'), report };
  }
  const repoPaths = p.target.repo ? written.filter((w) => w.startsWith('repo:')).map((w) => w.slice(5)) : [];
  const commit = repoPaths.length ? {
    message: 'Apply setup profile ' + (o.model && o.model.profile ? o.model.profile.version : '') + ': ' + p.desired.length + ' item(s) on' + (p.removing.length ? ', ' + p.removing.length + ' removed' : ''),
    paths: [...new Set(repoPaths)],
  } : null;
  const report = { tx: id, ok: true, written, flagged, counts: p.counts, commit, at: new Date().toISOString() };
  writeJsonPlain(path.join(dir, 'report.json'), report);
  return { applied: true, ok: true, code: 0, tx: id, written, flagged, commit, report, line: 'applied tx ' + id + ': ' + written.length + ' write(s)' + (flagged.length ? ', ' + flagged.length + ' kept and flagged' : '') };
}

function isEmptyLock(l) {
  return !l.items.length && !Object.keys(l.files || {}).length && !Object.keys(l.env || {}).length && !Object.keys(l.tasks || {}).length && !Object.keys(l.git || {}).length;
}

function setLockPrior(lock, map, key, prior) {
  if (!lock || !lock[map] || !lock[map][key]) return;
  if (lock[map][key].prior === 'PENDING') lock[map][key].prior = prior;
}

function writeJsonPlain(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, Buffer.from(JSON.stringify(obj, null, 2) + '\n', 'utf8'));
}

// ------------------------------------------------------------------ revert

function readJournal(dataDir, txId) {
  const f = path.join(txRoot(dataDir), txId, 'journal.jsonl');
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
  const bySeq = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; } // a torn last line
    if (j.done === true && !j.op) { const e = bySeq.get(j.seq); if (e) { e.done = true; if (j.token !== undefined) e.token = j.token; } continue; }
    bySeq.set(j.seq, j);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function listTx(dataDir) {
  let names = [];
  try { names = fs.readdirSync(txRoot(dataDir)).filter((n) => /^[0-9]{8}-[0-9]{6}-[0-9]{3}$/.test(n)).sort(); } catch (e) { return []; }
  return names.map((n) => {
    const d = path.join(txRoot(dataDir), n);
    const rep = readJson(path.join(d, 'report.json'), null);
    const rev = readJson(path.join(d, 'revert.json'), null);
    return { id: n, ok: rep ? rep.ok === true : null, reverted: !!rev, written: rep && rep.written ? rep.written.length : 0, at: rep ? rep.at : null };
  });
}

// Undo journal entries in reverse. force: undo even when a file changed since (the
// rollback of a transaction that just failed). Returns {ok, flagged, undone}.
async function undoJournal(entries, o) {
  const dataDir = o.dataDir;
  const deps = o.deps || {};
  const recycle = o.recycle || deps.recycle || defaultRecycle(dataDir);
  const preOf = (name) => (name ? fs.readFileSync(path.join(txRoot(dataDir), o.txId, 'pre', name)) : null);
  const flagged = [];
  const undone = [];
  let ok = true;
  for (const e of entries.slice().reverse()) {
    try {
      if (e.op === 'write' || e.op === 'delete') {
        const cur = exists(e.abs) ? fs.readFileSync(e.abs) : null;
        const applied = e.op === 'delete' ? cur === null : cur !== null && sha(cur) === e.applied_sha;
        const untouched = e.op === 'write' && !e.done && (cur === null ? e.created : e.pre && sha(cur) === sha(preOf(e.pre)));
        if (untouched) continue; // intent logged, write never happened
        if (applied || o.force) {
          if (e.pre) { fs.mkdirSync(path.dirname(e.abs), { recursive: true }); atomicWrite(e.abs, preOf(e.pre)); }
          else if (cur !== null) await recycle(e.abs);
          for (const d of e.dirs || []) { try { fs.rmdirSync(d); } catch (x) { /* not empty or gone */ } }
          undone.push(e.display);
          continue;
        }
        // Changed since the profile wrote it: key-level / block-level where possible.
        const partial = cur !== null ? partialRevert(e, cur, preOf, dataDir) : null;
        if (partial) { atomicWrite(e.abs, partial.buf); undone.push(e.display + ' (' + partial.how + ')'); if (partial.flag) flagged.push(e.display + ': ' + partial.flag); continue; }
        if (e.pre) atomicWrite(e.abs + '.profile-removed', preOf(e.pre));
        flagged.push(e.display + ': edited since the profile wrote it; kept' + (e.pre ? ' (previous content in ' + path.basename(e.abs) + '.profile-removed)' : ''));
        continue;
      }
      if (e.op === 'rmdir') {
        fs.mkdirSync(e.abs, { recursive: true });
        undone.push('dir ' + e.display);
        continue;
      }
      if (e.op === 'env') {
        const a = deps.env;
        if (!a) throw new Error('env adapter not installed');
        const snap = JSON.parse(preOf(e.prior).toString('utf8'));
        if (snap.absent) a.unset(e.name); else a.restore(e.name, snap);
        undone.push('env:' + e.name);
        continue;
      }
      if (e.op === 'git') {
        const a = deps.git || gitAdapter();
        if (e.prior === 'absent') a.unset(e.repo, e.key); else a.set(e.repo, e.key, JSON.parse(preOf(e.prior).toString('utf8')).v);
        undone.push('git:' + e.key);
        continue;
      }
      if (e.op === 'task') {
        const a = deps.tasks;
        if (!a) throw new Error('task adapter not installed');
        if (e.prior === 'absent') a.remove(e.name); else a.register(e.name, preOf(e.prior).toString('utf8'));
        undone.push('task:' + e.name);
        continue;
      }
      if (e.op === 'app-config') {
        if (!deps.appConfig) throw new Error('app-config adapter not installed');
        await deps.appConfig.revert(e.token, { preDir: path.join(txRoot(dataDir), o.txId, 'pre'), seq: e.seq });
        undone.push('app-config');
      }
    } catch (err) {
      ok = false;
      flagged.push((e.display || e.name || e.key || e.op) + ': ' + String(err.message || err).slice(0, 160));
    }
  }
  return { ok, flagged, undone };
}

// A file edited after the profile wrote it: restore only what the profile owns.
function partialRevert(e, cur, preOf, dataDir) {
  let text = cur.toString('utf8');
  let how = null;
  const flags = [];
  if (e.keys && /\.json$/i.test(e.abs)) {
    let obj;
    try { obj = JSON.parse(text); } catch (x) { return null; }
    for (const [kp, kv] of Object.entries(e.keys)) {
      const keys = kp.split('.');
      let o = obj;
      let found = true;
      for (const k of keys) { if (!isObj(o) || !(k in o)) { found = false; break; } o = o[k]; }
      if (kv.array) continue;
      if (!found) continue;
      if (sha(Buffer.from(PL.canon(o))) !== kv.sha) { flags.push(kp + ' edited; kept'); continue; }
      let parent = obj;
      for (const k of keys.slice(0, -1)) parent = parent[k];
      if (kv.prior === 'absent' || !kv.prior) delete parent[keys[keys.length - 1]];
      else { const pre = PL.readPre(dataDir, kv.prior); if (pre) parent[keys[keys.length - 1]] = JSON.parse(pre.toString('utf8')).v; }
    }
    text = JSON.stringify(obj, null, 2) + '\n';
    how = 'key-level';
  }
  if (e.blocks) {
    for (const [name, b] of Object.entries(e.blocks)) {
      const mk = PL.markersFor(e.abs, name);
      const found = mk ? PL.findBlock(text, mk) : null;
      if (!found || found.bad) continue;
      if (sha(Buffer.from(found.inner, 'utf8')) !== b.sha) { flags.push('block ' + name + ' edited; kept'); continue; }
      if (b.prior === 'absent' || !b.prior) text = PL.removeBlock(text, mk, b.sep);
      else { const pre = PL.readPre(dataDir, b.prior); if (pre) text = PL.setBlock(text, mk, pre.toString('utf8'), false).text; }
    }
    how = how ? how + '+block-level' : 'block-level';
  }
  if (!how) return null;
  return { buf: Buffer.from(text, 'utf8'), how, flag: flags.length ? flags.join('; ') : null };
}

// Revert one transaction (txId or 'last'). Dry run unless confirm === true.
async function revertTx(dataDir, txId, o) {
  o = o || {};
  const list = listTx(dataDir);
  if (txId === 'last' || !txId) {
    const open = list.filter((t) => t.ok && !t.reverted);
    if (!open.length) return { ok: true, code: 0, line: 'nothing to revert', undone: [] };
    txId = open[open.length - 1].id;
  }
  if (!/^[0-9]{8}-[0-9]{6}-[0-9]{3}$/.test(String(txId))) return { ok: false, code: 1, line: 'refused: bad transaction id' };
  const t = list.find((x) => x.id === txId);
  if (!t) return { ok: false, code: 1, line: 'refused: no transaction ' + txId };
  if (t.reverted) return { ok: false, code: 1, line: 'refused: transaction ' + txId + ' is already reverted' };
  const entries = (readJournal(dataDir, txId) || []).filter((e) => e.op !== 'consent');
  if (o.confirm !== true) {
    return { ok: true, code: 0, dryRun: true, tx: txId, entries: entries.map((e) => ({ op: e.op, target: e.display || e.name || e.key })), line: 'dry run: revert ' + txId + ' would undo ' + entries.length + ' change(s) (add --apply --yes)' };
  }
  const r = await undoJournal(entries, { dataDir, deps: o.deps, recycle: o.deps && o.deps.recycle, txId });
  writeJsonPlain(path.join(txRoot(dataDir), txId, 'revert.json'), { at: (o.now || new Date()).toISOString(), ok: r.ok, flagged: r.flagged, undone: r.undone });
  return { ok: r.ok, code: r.ok ? 0 : 1, tx: txId, undone: r.undone, flagged: r.flagged, line: 'reverted ' + txId + ': ' + r.undone.length + ' change(s) undone' + (r.flagged.length ? ', ' + r.flagged.length + ' kept and flagged' : '') };
}

module.exports = { KINDS, applyPlan, revertTx, listTx, readJournal, undoJournal, gate, gitAdapter, defaultAdapters, txRoot, targetsFile, defaultRecycle, tasksNeedingConsent, taskConsentCheck };
