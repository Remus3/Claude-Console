'use strict';
// Setup profile engine, part 4 (CON-013 L3): read-back. verifyItems() runs each on item's
// `verify` entries against the target; verifyLock() reads back every file the lock lists
// (lock vs disk drift). Read-only: hooks are smoke-run only through deps.runHook (a sample
// stdin, exit 0, at most one output line), machine state only through the adapters.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./profile');
const PL = require('./profile-plan');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Budget names -> the file they bound (budgets variable in KB). A verify value may also be
// "<budget>:<repo|user>:<path>".
const BUDGET_FILES = { claude_md_kb: 'repo:CLAUDE.md', roadmap_kb: 'repo:ROADMAP.md', handoff_kb: 'repo:{handoff_name}', memory_index_kb: 'repo:memory/MEMORY.md' };

function resolveT(t, vars, target) {
  const m = /^(repo|user):(.+)$/.exec(String(t));
  if (!m) return null;
  const root = m[1] === 'repo' ? target.repo : target.configDir;
  if (!root) return null;
  const r = P.renderText(m[2], vars);
  if (r.missing.length) return { missing: r.missing };
  return { abs: path.join(root, ...r.text.split('/')), display: m[1] + ':' + r.text };
}

function read(abs) { try { return fs.readFileSync(abs); } catch (e) { return null; } }

// o: {model, selection, target, values, ctx, deps: {env, tasks, git, runHook}, only, platform}
function verifyItems(o) {
  const model = o.model;
  const target = o.target || {};
  const deps = o.deps || {};
  const platform = o.platform || process.platform;
  const sel = P.normaliseSelection(o.selection, model);
  const vr = P.resolveVariables(model, Object.assign({}, sel.variables, o.values || {}), Object.assign({ repoRoot: target.repo, configDir: target.configDir, dataDir: o.dataDir }, o.ctx || {}));
  const vars = vr.vars;
  let ids = P.onIds(model, sel);
  if (Array.isArray(o.only) && o.only.length) ids = ids.filter((id) => P.expandIds(model, o.only).ids.includes(id));
  const rows = [];
  const add = (item, check, ok, reason) => rows.push({ item, check, ok: ok === true, skipped: ok === null, reason: reason || null });
  const budgets = (() => { try { return JSON.parse(vars.budgets || '{}'); } catch (e) { return {}; } })();
  for (const id of ids) {
    const it = model.items.get(id).item;
    if (!it.platform.includes(platform)) continue;
    for (const v of it.verify || []) {
      const kind = Object.keys(v).find((k) => k !== 'line1' && k !== 'match');
      const val = v[kind];
      try {
        if (kind === 'file-ascii-lf' || kind === 'json-parse' || kind === 'regex') {
          const t = resolveT(val, vars, target);
          if (!t) { add(id, kind, null, 'no target'); continue; }
          if (t.missing) { add(id, kind, false, 'needs {' + t.missing.join('}, {') + '}'); continue; }
          const b = read(t.abs);
          if (b === null) { add(id, kind + ' ' + t.display, false, 'missing'); continue; }
          if (kind === 'file-ascii-lf') {
            const bad = b.includes(13) ? 'CR byte' : /[^\x09\x0a\x20-\x7e]/.test(b.toString('latin1')) ? 'non-ASCII byte' : null;
            add(id, kind + ' ' + t.display, !bad, bad);
          } else if (kind === 'json-parse') {
            try { JSON.parse(b.toString('utf8')); add(id, kind + ' ' + t.display, true); } catch (e) { add(id, kind + ' ' + t.display, false, 'not parsable'); }
          } else {
            const text = b.toString('utf8');
            if (v.line1 !== undefined) add(id, 'regex ' + t.display, new RegExp(v.line1).test(text.split('\n')[0].replace(/\r$/, '')), 'line 1 does not match');
            else add(id, 'regex ' + t.display, new RegExp(v.match, 'm').test(text), 'no match');
          }
        } else if (kind === 'git-hooks') {
          const t = resolveT(val, vars, target);
          if (!t || t.missing) { add(id, kind, null, 'no repo target'); continue; }
          const rel = path.relative(target.repo, t.abs).replace(/\\/g, '/');
          const git = deps.git;
          const hp = git ? git.get(target.repo, 'core.hooksPath') : null;
          const ok = fs.existsSync(t.abs) && fs.statSync(t.abs).isDirectory() && (!git || hp === rel);
          add(id, 'git-hooks ' + t.display, ok, ok ? null : (hp !== rel ? 'core.hooksPath is not ' + rel : 'hooks dir missing'));
        } else if (kind === 'env-readback') {
          if (!deps.env) { add(id, 'env ' + val, null, 'env adapter not installed'); continue; }
          const g = deps.env.get(val) || {};
          add(id, 'env ' + val, !!g.present, 'not set');
        } else if (kind === 'task-readback') {
          if (!deps.tasks) { add(id, 'task ' + val, null, 'task adapter not installed'); continue; }
          const g = deps.tasks.get(val) || {};
          add(id, 'task ' + val, !!g.present, 'not registered');
        } else if (kind === 'hook-smoke') {
          if (!deps.runHook) { add(id, 'hook ' + val, null, 'smoke runner not given'); continue; }
          const r = deps.runHook(P.renderText(String(val), vars).text, '{"hook_event_name":"SessionStart","session_id":"smoke"}');
          const lines = String((r && r.stdout) || '').split('\n').filter((l) => l.trim()).length;
          add(id, 'hook ' + val, !!r && r.status === 0 && lines <= 1, r && r.status !== 0 ? 'exit ' + r.status : 'more than one output line');
        } else if (kind === 'budget') {
          const [name, ...rest] = String(val).split(':');
          const tgt = rest.length ? rest.join(':') : BUDGET_FILES[name];
          const kb = budgets[name];
          if (!tgt || !Number.isFinite(kb)) { add(id, 'budget ' + name, null, 'unknown budget'); continue; }
          const t = resolveT(tgt, vars, target);
          if (!t || t.missing) { add(id, 'budget ' + name, null, 'no target'); continue; }
          const b = read(t.abs);
          if (b === null) { add(id, 'budget ' + name, true, 'absent'); continue; }
          add(id, 'budget ' + name + ' ' + t.display, b.length <= kb * 1024, Math.ceil(b.length / 1024) + ' KB > ' + kb + ' KB');
        } else add(id, kind, null, 'unknown verify kind');
      } catch (e) { add(id, kind, false, String(e.message || e).slice(0, 120)); }
    }
  }
  return { ok: rows.every((r) => r.ok || r.skipped), rows: rows.map((r) => (r.ok ? Object.assign({}, r, { reason: null }) : r)) };
}

// Lock vs disk: every managed file's sha. Returns {rows: [{side, rel, state: ok|drift|missing}]}.
function verifyLock(o) {
  const model = o.model;
  const rows = [];
  const target = o.target || {};
  const sides = [];
  if (target.repo) sides.push(['repo', target.repo, PL.readLock(PL.repoLockFile(target.repo), model)]);
  if (o.dataDir && target.configDir) sides.push(['user', target.configDir, PL.readLock(PL.userLockFile(o.dataDir, target.configDir, o.primaryConfigDir), model)]);
  for (const [side, root, lock] of sides) {
    for (const [rel, e] of Object.entries(lock.files)) {
      const b = read(path.join(root, ...rel.split('/')));
      rows.push({ side, rel, state: b === null ? 'missing' : sha(b) === e.sha ? 'ok' : 'drift' });
    }
  }
  return { ok: rows.every((r) => r.state === 'ok'), rows };
}

module.exports = { verifyItems, verifyLock, BUDGET_FILES };
