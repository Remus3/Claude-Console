'use strict';
// Setup profile engine, part 2 (CON-013 L3): the READ-ONLY planner. Given the profile,
// the user's selection and a target (a repo and/or the Claude config dir), it works out
// per contribution what apply would do and why:
//   new | same | differs | conflict | unreadable | skipped (platform, target, create-only,
//   user value kept, needs a variable)
// and composes, per target file, the exact bytes after apply (file templates, marker
// blocks, key-level JSON merges), so the diff shown is the diff written. Machine effects
// (env, git config, scheduled tasks) are planned through injected adapters and never
// carry a value into the plan text. Nothing here writes.
//
// A plan covers a scope: every item (default) or `only` ids. In scope, items that are on
// are added (D) and items in the target's lock that are now off are removed (R); items
// outside the scope that the lock records keep their contributions (blocks are composed
// from (lock - R) + D, so a partial apply never drops another item's block text).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./profile');
const { readJson } = require('./fsutil');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

const LOCK_REL = '.claude/profile.lock.json';
function repoLockFile(repo) { return path.join(repo, '.claude', 'profile.lock.json'); }
// The user lock of the primary account's config dir is user.json; another account's dir
// (FB-1021: user-scope settings applied per account) gets its own user-<hash>.json.
function userLockFile(dataDir, configDir, primary) {
  const norm = (d) => path.resolve(d).toLowerCase();
  const own = configDir && primary && norm(configDir) !== norm(primary);
  return path.join(P.profileStateDir(dataDir), 'locks', own ? 'user-' + sha(Buffer.from(norm(configDir))).slice(0, 12) + '.json' : 'user.json');
}
function emptyLock(model) {
  return { schema: 1, profile: model.profile ? model.profile.profile : null, version: model.profile ? model.profile.version : null,
    items: [], files: {}, env: {}, tasks: {}, git: {}, dirs: [] };
}
function readLock(file, model) {
  const j = readJson(file, null);
  if (!isObj(j)) return emptyLock(model);
  const l = Object.assign(emptyLock(model), j);
  for (const k of ['files', 'env', 'tasks', 'git']) if (!isObj(l[k])) l[k] = {};
  if (!Array.isArray(l.items)) l.items = [];
  if (!Array.isArray(l.dirs)) l.dirs = [];
  return l;
}

// ------------------------------------------------------------------ markers (block kind)

// Comment syntax per file type. A target whose type has no comment syntax (JSON) cannot
// hold a block.
function markersFor(file, block) {
  const base = path.basename(file).toLowerCase();
  const ext = path.extname(base);
  let open;
  let close = '';
  if (['.md', '.markdown', '.html', '.htm', '.xml', '.txt'].includes(ext)) { open = '<!-- '; close = ' -->'; }
  else if (['.js', '.ts', '.mjs', '.cjs', '.c', '.h', '.cpp', '.cs', '.java', '.go', '.rs'].includes(ext)) open = '// ';
  else if (['.bat', '.cmd'].includes(ext)) open = 'REM ';
  else if (['.json'].includes(ext)) return null;
  else open = '# '; // .sh .py .ps1 .yml .yaml .toml .ini .cfg .conf .gitattributes .gitignore, hook files
  return { begin: open + 'profile:begin ' + block + close, end: open + 'profile:end ' + block + close };
}

// Finds the marker region. Returns {start, end, inner} (string offsets: start of the begin
// line, end just after the end line's newline) or null; {bad: true} when unbalanced.
function findBlock(text, mk) {
  const lines = text.split('\n');
  let off = 0;
  let b = -1;
  let bOff = -1;
  let innerStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    const lineEnd = off + lines[i].length + (i < lines.length - 1 ? 1 : 0);
    if (l === mk.begin) { if (b >= 0) return { bad: true }; b = i; bOff = off; innerStart = lineEnd; }
    else if (l === mk.end) {
      if (b < 0) return { bad: true };
      return { start: bOff, end: lineEnd, inner: text.slice(innerStart, off) };
    }
    off = lineEnd;
  }
  return b >= 0 ? { bad: true } : null;
}

// Returns {text, sep} after setting the block's inner text. A new block in a Markdown
// file goes after the first paragraph (the purpose line, CLAUDE.md layout); elsewhere at
// the end. sep: a blank separator line was added (removed again with the block).
function setBlock(text, mk, inner, isMd) {
  const region = mk.begin + '\n' + inner + mk.end + '\n';
  const f = findBlock(text, mk);
  if (f && !f.bad) return { text: text.slice(0, f.start) + region + text.slice(f.end), sep: false };
  if (text === '') return { text: region, sep: false };
  let t = text.endsWith('\n') ? text : text + '\n';
  if (isMd) {
    const m = /\n[ \t]*\n/.exec(t);
    if (m && m.index + m[0].length < t.length) {
      const at = m.index + m[0].length;
      return { text: t.slice(0, at) + region + '\n' + t.slice(at), sep: true };
    }
  }
  return { text: t + '\n' + region, sep: true };
}

function removeBlock(text, mk, sep) {
  const f = findBlock(text, mk);
  if (!f || f.bad) return text;
  let a = f.start;
  let b = f.end;
  if (sep) {
    if (text.slice(b, b + 1) === '\n' && a > 0) b += 1; // inserted after a paragraph: "region\n" + "\n"
    else if (a >= 1 && text.slice(a - 1, a) === '\n' && text.slice(a - 2, a - 1) === '\n') a -= 1; // appended
  }
  return text.slice(0, a) + text.slice(b);
}

// ------------------------------------------------------------------ unified diff

function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n * m > 4e6) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { ops.push(['-', a[i]]); i++; }
    else { ops.push(['+', b[j]]); j++; }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);
  return ops;
}

const splitLines = (t) => { if (t === '' || t == null) return []; const l = String(t).split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };

// Unified diff with 3 lines of context. null text = absent file.
function udiff(before, after, name, ctx) {
  ctx = ctx === undefined ? 3 : ctx;
  const a = splitLines(before);
  const b = splitLines(after);
  const head = ['--- ' + (before == null ? '/dev/null' : 'a/' + name), '+++ ' + (after == null ? '/dev/null' : 'b/' + name)];
  let ops = lcsDiff(a, b);
  if (!ops) ops = a.map((l) => ['-', l]).concat(b.map((l) => ['+', l]));
  if (!ops.some((o) => o[0] !== ' ')) return '';
  const out = head.slice();
  let k = 0;
  while (k < ops.length) {
    while (k < ops.length && ops[k][0] === ' ') k++;
    if (k >= ops.length) break;
    let s = Math.max(0, k - ctx);
    let e = k;
    for (;;) {
      while (e < ops.length && ops[e][0] !== ' ') e++;
      let run = 0;
      while (e + run < ops.length && ops[e + run][0] === ' ') run++;
      if (e + run < ops.length && run <= ctx * 2) { e += run; continue; }
      e = Math.min(ops.length, e + ctx);
      break;
    }
    let ai = 0;
    let bi = 0;
    for (let x = 0; x < s; x++) { if (ops[x][0] !== '+') ai++; if (ops[x][0] !== '-') bi++; }
    let ac = 0;
    let bc = 0;
    for (let x = s; x < e; x++) { if (ops[x][0] !== '+') ac++; if (ops[x][0] !== '-') bc++; }
    out.push('@@ -' + (ac ? ai + 1 : ai) + ',' + ac + ' +' + (bc ? bi + 1 : bi) + ',' + bc + ' @@');
    for (let x = s; x < e; x++) out.push(ops[x][0] + ops[x][1]);
    k = e;
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------ JSON merge helpers

// Flattens a contributed settings object into merge units:
//   {path: 'hooks', hooks: [...identities]} for hook arrays,
//   {path, array: [...]} for arrays of primitives (union), {path, value} otherwise.
// Objects are split one level (env.X, permissions.defaultMode), so two items may each add
// one env var without a conflict.
function mergeUnits(obj) {
  const units = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'hooks' && isObj(v)) {
      for (const [event, groups] of Object.entries(v)) {
        for (const g of Array.isArray(groups) ? groups : []) {
          for (const h of Array.isArray(g.hooks) ? g.hooks : []) units.push({ path: 'hooks', hook: { event, matcher: g.matcher === undefined ? null : g.matcher, entry: h } });
        }
      }
    } else if (isObj(v)) {
      for (const [k2, v2] of Object.entries(v)) units.push(unitFor(k + '.' + k2, [k, k2], v2));
    } else units.push(unitFor(k, [k], v));
  }
  return units;
}
function unitFor(p, keys, v) {
  if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) return { path: p, keys, array: v };
  return { path: p, keys, value: v };
}
function getAt(obj, keys) { let o = obj; for (const k of keys) { if (!isObj(o) || !(k in o)) return { absent: true }; o = o[k]; } return { value: o }; }
function setAt(obj, keys, v) { let o = obj; for (const k of keys.slice(0, -1)) { if (!isObj(o[k])) o[k] = {}; o = o[k]; } o[keys[keys.length - 1]] = v; }
function delAt(obj, keys) {
  const parents = [];
  let o = obj;
  for (const k of keys.slice(0, -1)) { if (!isObj(o[k])) return; parents.push([o, k]); o = o[k]; }
  delete o[keys[keys.length - 1]];
  for (let i = parents.length - 1; i >= 0; i--) { const [po, pk] = parents[i]; if (isObj(po[pk]) && !Object.keys(po[pk]).length) delete po[pk]; else break; }
}
const hookId = (h) => h.event + '|' + (h.matcher === null ? '' : h.matcher) + '|' + (h.entry && h.entry.command);
function findHook(obj, h) {
  const groups = isObj(obj.hooks) && Array.isArray(obj.hooks[h.event]) ? obj.hooks[h.event] : [];
  for (const g of groups) {
    const gm = g.matcher === undefined ? null : g.matcher;
    if (gm !== h.matcher) continue;
    if ((Array.isArray(g.hooks) ? g.hooks : []).some((x) => x && x.command === h.entry.command)) return true;
  }
  return false;
}
function addHook(obj, h) {
  if (!isObj(obj.hooks)) obj.hooks = {};
  if (!Array.isArray(obj.hooks[h.event])) obj.hooks[h.event] = [];
  let g = obj.hooks[h.event].find((x) => (x.matcher === undefined ? null : x.matcher) === h.matcher);
  if (!g) { g = h.matcher === null ? { hooks: [] } : { matcher: h.matcher, hooks: [] }; obj.hooks[h.event].push(g); }
  if (!Array.isArray(g.hooks)) g.hooks = [];
  g.hooks.push(h.entry);
}
function removeHook(obj, h) {
  if (!isObj(obj.hooks) || !Array.isArray(obj.hooks[h.event])) return;
  const groups = obj.hooks[h.event];
  for (const g of groups) {
    if ((g.matcher === undefined ? null : g.matcher) !== h.matcher || !Array.isArray(g.hooks)) continue;
    g.hooks = g.hooks.filter((x) => !(x && x.command === h.entry.command));
  }
  obj.hooks[h.event] = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length);
  if (!obj.hooks[h.event].length) delete obj.hooks[h.event];
  if (!Object.keys(obj.hooks).length) delete obj.hooks;
}

// ------------------------------------------------------------------ planner

const STATUS_RANK = { conflict: 6, unreadable: 5, new: 4, differs: 3, removed: 3, same: 1, skipped: 0 };

// o: {model, selection, dataDir, target: {repo, configDir}, only, remove, values, ctx,
//     resolve: {itemId: 'replace'|'keep'}, platform, deps: {env, git, tasks}}
function plan(o) {
  const model = o.model;
  const dataDir = o.dataDir;
  const target = o.target || {};
  const platform = o.platform || process.platform;
  const resolve = o.resolve || {};
  const adapters = o.deps || {};
  const sel = P.normaliseSelection(o.selection, model);
  const state = P.effectiveState(model, sel);

  const repoLockPath = target.repo ? repoLockFile(target.repo) : null;
  const userLockPath = dataDir ? userLockFile(dataDir, target.configDir, o.primaryConfigDir) : null;
  const locks = {
    repo: target.repo ? (o.locks && o.locks.repo) || readLock(repoLockPath, model) : null,
    user: userLockPath ? (o.locks && o.locks.user) || readLock(userLockPath, model) : null,
  };
  const lockItems = new Set([...(locks.repo ? locks.repo.items : []), ...(locks.user ? locks.user.items : [])]);

  // Scope, desired set D and removal set R.
  let scope;
  const depsAdded = [];
  if (Array.isArray(o.remove) && o.remove.length) {
    scope = expandAll(model, o.remove);
  } else if (Array.isArray(o.only) && o.only.length) {
    const ex = P.expandIds(model, o.only);
    scope = ex.ids;
    for (const d of P.dependencyClosure(model, scope)) if (!scope.includes(d)) { scope.push(d); depsAdded.push(d); }
  } else scope = model.order.slice();
  const removing = Array.isArray(o.remove) && o.remove.length;
  const D = removing ? [] : model.order.filter((id) => scope.includes(id) && state.get(id).on);
  const R = model.order.filter((id) => scope.includes(id) && lockItems.has(id) && (removing || !state.get(id).on));
  const E = model.order.filter((id) => (lockItems.has(id) && !R.includes(id)) || D.includes(id));

  const out = {
    target: { repo: target.repo || null, configDir: target.configDir || null }, scope, desired: D, removing: R, inEffect: E, depsAdded,
    conflictsPairs: P.conflictsAmong(model, D), missing: [], varErrors: [], files: [], machine: [], rows: [],
    needsAck: [], highRisk: [], locks, lockPaths: { repo: repoLockPath, user: userLockPath }, lockNext: null,
  };

  // Variables.
  const vr = P.resolveVariables(model, Object.assign({}, sel.variables, o.values || {}), Object.assign({ repoRoot: target.repo, configDir: target.configDir, dataDir }, o.ctx || {}));
  out.varErrors = vr.errors;
  const vars = vr.vars;
  const missingMap = new Map();
  // A derived variable that cannot resolve is reported as the inputs it is made of.
  const baseOf = (n, seen) => {
    const d = model.profile.variables[n];
    if (!d || d.type !== 'derived' || (seen && seen.has(n))) return [n];
    const s2 = new Set(seen || []).add(n);
    return P.renderText(d.value, vars).missing.flatMap((x) => baseOf(x, s2));
  };
  const needVar = (names0, item) => { const names = [...new Set(names0.flatMap((n) => baseOf(n)))]; for (const n of names) { if (!missingMap.has(n)) missingMap.set(n, { name: n, ask: vr.asks[n] || null, items: [] }); const m = missingMap.get(n); if (!m.items.includes(item)) m.items.push(item); } };

  const sideRoot = (side) => (side === 'repo' ? target.repo : target.configDir);
  const files = new Map(); // abs -> file state
  const row = (item, kind, tgt, status, reason) => out.rows.push({ item, kind, target: tgt, status, reason: reason || null });
  const nextLock = { repo: locks.repo ? JSON.parse(JSON.stringify(locks.repo)) : null, user: locks.user ? JSON.parse(JSON.stringify(locks.user)) : null };
  // another account's lock records its dir, so recovery can find the settings it manages
  if (nextLock.user && userLockPath && path.basename(userLockPath) !== 'user.json') nextLock.user.configDir = path.resolve(target.configDir);
  const lockFor = (side) => (side === 'repo' ? nextLock.repo : nextLock.user);

  function resolveTarget(t, item) {
    const m = /^(repo|user):(.+)$/.exec(t);
    // No root for this side (e.g. a repo file on a user-only target): the contribution is
    // skipped, so its path variables are not asked for (a user-target `setup` dry run
    // must not refuse over {repo_code}).
    const root = sideRoot(m[1]);
    if (!root) return { noTarget: m[1] };
    const r = P.renderText(m[2], vars);
    if (r.missing.length) { needVar(r.missing, item); return { missing: r.missing }; }
    const rel = r.text.replace(/\\/g, '/');
    if (rel.split('/').some((s) => s === '..' || s === '') || path.isAbsolute(rel)) return { bad: 'target escapes its root' };
    return { side: m[1], rel, abs: path.join(root, ...rel.split('/')), display: m[1] + ':' + rel };
  }

  function fileState(t) {
    if (files.has(t.abs)) return files.get(t.abs);
    let cur = null;
    let unreadable = null;
    try { cur = fs.readFileSync(t.abs); } catch (e) { if (e.code !== 'ENOENT') unreadable = e.code || 'unreadable'; }
    const lock = lockFor(t.side);
    const entry = lock && lock.files[t.rel] ? lock.files[t.rel] : null;
    const f = { abs: t.abs, rel: t.rel, side: t.side, display: t.display, before: cur, unreadable, entry,
      content: cur, fileItem: null, blocks: new Map(), json: null, items: new Set(), statuses: [], contributions: [],
      remove: false, keep: false, flag: null, removedSide: null };
    files.set(t.abs, f);
    return f;
  }

  const itemDefault = (id) => model.items.get(id);
  const isActive = (id) => {
    const it = itemDefault(id).item;
    return Array.isArray(it.platform) && it.platform.includes(platform);
  };

  // --- D: contributions of items being added.
  for (const id of E) {
    const { item, module: mod } = model.items.get(id);
    const adding = D.includes(id);
    if (!isActive(id)) { if (adding) row(id, '-', '-', 'skipped', 'platform ' + item.platform.join('/') + ' only'); continue; }
    for (const c of item.contributes || []) {
      if (c.kind === 'block') {
        const t = resolveTarget(c.target, id);
        if (!t.abs) { if (adding) row(id, c.kind, c.target, 'skipped', t.noTarget ? 'no ' + t.noTarget + ' target' : t.missing ? 'needs {' + t.missing.join('}, {') + '}' : t.bad); continue; }
        // A kept item's block stays only where that item was applied (this side's lock).
        if (!adding && !(locks[t.side] && locks[t.side].items.includes(id))) continue;
        const f = fileState(t);
        const key = c.block;
        if (!f.blocks.has(key)) f.blocks.set(key, []);
        const tpl = readTpl(model, mod.id, c.template, dataDir, vars, id, needVar);
        if (tpl === null) { if (adding) row(id, c.kind, t.display, 'skipped', 'needs a variable'); continue; }
        f.blocks.get(key).push({ item: id, slot: c.slot || 0, order: item.order, text: tpl, adding });
        f.items.add(id);
        continue;
      }
      if (!adding) continue; // non-block contributions of kept items are already on disk
      planAdd(id, item, mod, c);
    }
  }

  function planAdd(id, item, mod, c) {
    // FB-1021: another account's config dir takes its user: files only; env, tasks, git,
    // kit and app config are machine-wide and were applied with the primary account.
    if (o.configFilesOnly && !(typeof c.target === 'string' && c.target.startsWith('user:'))) {
      return row(id, c.kind, c.target || c.name || c.key || '-', 'skipped', 'machine-wide; applied with the main account');
    }
    // CON-FB-2ND: a user: contribution marked for one account (account 'second': the
    // background account's quiet keys) is skipped on the other account's plan.
    if (c.account === 'second' && !o.configFilesOnly) return row(id, c.kind, c.target, 'skipped', 'second account only; applied to the other account dir');
    if (c.account === 'main' && o.configFilesOnly) return row(id, c.kind, c.target, 'skipped', 'main account only');
    if (c.kind === 'file') {
      const t = resolveTarget(c.target, id);
      if (!t.abs) return row(id, 'file', c.target, 'skipped', t.noTarget ? 'no ' + t.noTarget + ' target' : t.missing ? 'needs {' + t.missing.join('}, {') + '}' : t.bad);
      const tpl = readTpl(model, mod.id, c.template, dataDir, vars, id, needVar);
      if (tpl === null) return row(id, 'file', t.display, 'skipped', 'needs a variable');
      return addFile(id, t, Buffer.from(tpl, 'utf8'), c.mode || 'managed');
    }
    if (c.kind === 'kit') {
      const tgt = c.target || 'repo:{kit_dir}';
      for (const name of c.files) {
        const t = resolveTarget(tgt.replace(/\/+$/, '') + '/' + name, id);
        if (!t.abs) { row(id, 'kit', tgt + '/' + name, 'skipped', t.noTarget ? 'no ' + t.noTarget + ' target' : t.missing ? 'needs {' + t.missing.join('}, {') + '}' : t.bad); continue; }
        let buf;
        try { buf = fs.readFileSync(path.join(model.dir, 'kit', name)); } catch (e) { row(id, 'kit', t.display, 'unreadable', 'kit file missing: ' + name); continue; }
        addFile(id, t, buf, 'managed');
      }
      return;
    }
    if (c.kind === 'json-merge') {
      const t = resolveTarget(c.target, id);
      if (!t.abs) return row(id, 'json-merge', c.target, 'skipped', t.noTarget ? 'no ' + t.noTarget + ' target' : t.missing ? 'needs {' + t.missing.join('}, {') + '}' : t.bad);
      let val = c.value;
      // A repo's .claude/settings.json is tracked: exe variables ({python}, {node}) are bare
      // names there, never a machine path (settings.local.json and user files keep the path).
      const jv = jsonVars(t.side === 'repo' && t.rel === '.claude/settings.json' ? P.trackedVars(model, vars) : vars);
      if (c.template) {
        const tpl = readTpl(model, mod.id, c.template, dataDir, jv, id, needVar);
        if (tpl === null) return row(id, 'json-merge', t.display, 'skipped', 'needs a variable');
        try { val = JSON.parse(tpl); } catch (e) { return row(id, 'json-merge', t.display, 'unreadable', 'template is not JSON'); }
      } else val = JSON.parse(P.renderText(JSON.stringify(val), jv).text);
      const f = fileState(t);
      f.items.add(id);
      if (!f.json) f.json = { adds: [], removes: [] };
      f.json.adds.push({ item: id, mode: c.mode || 'add', value: val });
      return;
    }
    if (c.kind === 'env') return planMachine(id, item, { kind: 'env', name: c.name, value: c.value !== undefined ? P.renderText(c.value, vars).text : undefined, secret: c.secret });
    if (c.kind === 'git') {
      if (!target.repo) return row(id, 'git', c.key, 'skipped', 'no repo target');
      const r = P.renderText(c.value, vars);
      if (r.missing.length) { needVar(r.missing, id); return row(id, 'git', c.key, 'skipped', 'needs a variable'); }
      return planMachine(id, item, { kind: 'git', key: c.key, value: r.text });
    }
    if (c.kind === 'task') {
      const tpl = readTpl(model, mod.id, c.template, dataDir, vars, id, needVar);
      if (tpl === null) return row(id, 'task', c.name, 'skipped', 'needs a variable');
      return planMachine(id, item, { kind: 'task', name: c.name, xml: tpl });
    }
    if (c.kind === 'app-config') {
      // Registered kind (addendum a.3); the adapter is L9's profile-appconfig.js.
      if (!adapters.appConfig) return row(id, 'app-config', c.target || '-', 'unreadable', 'app-config adapter not installed');
      const p = adapters.appConfig.plan(c, vars);
      out.machine.push(Object.assign({ kind: 'app-config', item: id, contribution: c }, p));
      return row(id, 'app-config', p.display || c.target, p.status, p.reason);
    }
    row(id, c.kind, '-', 'unreadable', 'unknown contribution kind ' + c.kind);
  }

  function addFile(id, t, buf, mode) {
    const f = fileState(t);
    f.items.add(id);
    if (f.unreadable) { f.statuses.push('unreadable'); return row(id, 'file', t.display, 'unreadable', f.unreadable); }
    const cur = f.before;
    let status;
    let reason = null;
    if (cur === null) status = 'new';
    else if (Buffer.compare(cur, buf) === 0) status = 'same';
    else if (mode === 'create-only') { status = 'skipped'; reason = 'exists (create-only)'; }
    else if (mode === 'managed' && f.entry && f.entry.sha === sha(cur)) status = 'differs';
    else {
      const r = resolve[id];
      if (r === 'replace') { status = 'differs'; reason = 'replace (resolved)'; }
      else if (r === 'keep') { status = 'skipped'; reason = 'user file kept (resolved)'; }
      else { status = 'conflict'; reason = f.entry ? 'edited since the profile wrote it' : 'a different file is already there'; }
    }
    if (status === 'new' || status === 'differs') { f.content = buf; f.fileItem = id; f.mode = mode; }
    if (status === 'same') { f.fileItem = id; f.mode = mode; }
    f.statuses.push(status);
    row(id, 'file', t.display, status, reason);
  }

  function planMachine(id, item, m) {
    const a = adapters[m.kind === 'task' ? 'tasks' : m.kind];
    const disp = m.kind === 'env' ? m.name : m.kind === 'git' ? m.key : m.name;
    if (!a) { row(id, m.kind, disp, 'unreadable', m.kind + ' adapter not installed'); out.machine.push(Object.assign({ item: id, op: 'none', status: 'unreadable' }, safeMachine(m))); return; }
    let status;
    let reason = null;
    try {
      if (m.kind === 'env') {
        const g = a.get(m.name) || { present: false };
        if (!g.present) status = 'new';
        else if (m.value !== undefined) status = g.sha256 === sha(Buffer.from(m.value, 'utf8')) ? 'same' : 'differs';
        else status = secretSame(a, g, m, locks.user, dataDir) ? 'same' : 'differs';
      } else if (m.kind === 'git') {
        const v = a.get(target.repo, m.key);
        if (v === null || v === undefined) status = 'new';
        else if (v === m.value) status = 'same';
        else if (resolve[id] === 'replace') { status = 'differs'; reason = 'replace (resolved)'; }
        else if (resolve[id] === 'keep') { status = 'skipped'; reason = 'user value kept (resolved)'; }
        else { status = 'conflict'; reason = 'git config ' + m.key + ' is already set to another value'; }
      } else {
        const g = a.get(m.name) || { present: false };
        if (!g.present) status = 'new';
        else if (taskSame(g.xml, m.xml)) status = 'same';
        else status = 'differs';
      }
    } catch (e) { status = 'unreadable'; reason = String(e.message || e).slice(0, 120); }
    out.machine.push(Object.assign({ item: id, op: status === 'new' || status === 'differs' ? 'set' : 'none', status, reason }, m));
    row(id, m.kind, disp, status, reason);
  }

  // --- R: removals recorded in the locks.
  for (const side of ['repo', 'user']) {
    const lock = locks[side];
    if (!lock) continue;
    for (const [rel, entry] of Object.entries(lock.files)) {
      const owners = (entry.items || []).filter((i) => R.includes(i));
      if (!owners.length) continue;
      const root = sideRoot(side);
      if (!root) continue;
      const t = { side, rel, abs: path.join(root, ...rel.split('/')), display: side + ':' + rel };
      const f = fileState(t);
      for (const i of owners) f.items.add(i);
      if (entry.fileItem && R.includes(entry.fileItem) && !f.fileItem) {
        // The whole file was the item's: delete what the profile created, restore what it replaced.
        const curSha = f.before ? sha(f.before) : null;
        if (!f.before) { row(entry.fileItem, 'file', t.display, 'same', 'already gone'); continue; }
        const edited = curSha !== entry.fileSha;
        if (edited) { f.keep = true; f.flag = 'edited since the profile wrote it; kept'; f.removedSide = entry.created ? null : entry.pre; row(entry.fileItem, 'file', t.display, 'skipped', f.flag); }
        else if (entry.created) { f.remove = true; row(entry.fileItem, 'file', t.display, 'removed', 'created by the profile; to the Recycle Bin'); }
        else { f.restorePre = entry.pre; row(entry.fileItem, 'file', t.display, 'removed', 'restore the file the profile replaced'); }
      }
      if (entry.keys || entry.hooks) {
        if (!f.json) f.json = { adds: [], removes: [] };
        for (const [k, ke] of Object.entries(entry.keys || {})) if (R.includes(ke.item)) f.json.removes.push(Object.assign({ path: k }, ke));
        for (const h of entry.hooks || []) if (R.includes(h.item)) f.json.removes.push({ hook: h, item: h.item });
      }
    }
    for (const [name, e] of Object.entries(lock.env || {})) if (R.includes(e.item)) {
      out.machine.push({ kind: 'env', item: e.item, name, op: 'restore', prior: e.prior, status: 'removed' });
      row(e.item, 'env', name, 'removed', e.prior === 'absent' ? 'unset' : 'restore the previous value');
    }
    for (const [name, e] of Object.entries(lock.tasks || {})) if (R.includes(e.item)) {
      out.machine.push({ kind: 'task', item: e.item, name, op: 'restore', prior: e.prior, status: 'removed' });
      row(e.item, 'task', name, 'removed', e.prior === 'absent' ? 'remove the task (XML backed up first)' : 'restore the previous task');
    }
    for (const [key, e] of Object.entries(lock.git || {})) if (R.includes(e.item)) {
      out.machine.push({ kind: 'git', item: e.item, key, op: 'restore', prior: e.prior, status: 'removed' });
      row(e.item, 'git', key, 'removed', e.prior === 'absent' ? 'unset' : 'restore the previous value');
    }
  }

  // --- Compose every touched file.
  for (const f of files.values()) composeFile(f);

  function composeFile(f) {
    if (f.unreadable) { f.status = 'unreadable'; return; }
    if (f.remove) { f.after = null; f.status = 'removed'; return; }
    if (f.restorePre) {
      const buf = readPre(dataDir, f.restorePre);
      if (!buf) { f.status = 'skipped'; f.flag = 'pre-image missing; kept'; return; }
      f.content = buf;
    }
    let text = f.content === null ? null : f.content;
    // Blocks.
    if (f.blocks.size || (f.entry && f.entry.blocks)) {
      const mkOk = markersFor(f.abs, 'x');
      let t = text === null ? '' : text.toString('utf8');
      const names = new Set([...f.blocks.keys(), ...Object.keys((f.entry && f.entry.blocks) || {})]);
      f.blockInfo = {};
      for (const name of names) {
        const parts = (f.blocks.get(name) || []).slice().sort((a, b) => (a.slot - b.slot) || (a.order - b.order));
        const prevEntry = f.entry && f.entry.blocks ? f.entry.blocks[name] : null;
        if (!mkOk) { for (const p of parts) if (p.adding) row(p.item, 'block', f.display, 'unreadable', 'this file type has no comment syntax'); f.blockBad = true; continue; }
        const mk = markersFor(f.abs, name);
        const found = findBlock(t, mk);
        if (found && found.bad) { for (const p of parts) row(p.item, 'block', f.display, 'unreadable', 'unbalanced profile markers'); f.blockBad = true; continue; }
        const inner = parts.map((p) => (p.text.endsWith('\n') ? p.text : p.text + '\n')).join('');
        const edited = found && prevEntry && sha(Buffer.from(found.inner, 'utf8')) !== prevEntry.sha;
        if (edited && !parts.some((p) => resolve[p.item] === 'replace')) {
          for (const p of parts) if (p.adding) row(p.item, 'block', f.display, 'conflict', 'block text edited since the profile wrote it');
          f.statuses.push('conflict');
          f.blockInfo[name] = prevEntry;
          continue;
        }
        if (!parts.length) {
          if (found) { t = removeBlock(t, mk, prevEntry && prevEntry.sep); }
          continue;
        }
        const before = found ? found.inner : null;
        const r = setBlock(t, mk, inner, /\.(md|markdown)$/i.test(f.abs));
        t = r.text;
        f.blockInfo[name] = { sha: sha(Buffer.from(inner, 'utf8')), items: parts.map((p) => p.item), sep: prevEntry ? !!prevEntry.sep : (found ? false : r.sep) };
        const st = before === null ? 'new' : before === inner ? 'same' : 'differs';
        for (const p of parts) if (p.adding) row(p.item, 'block', f.display + '#' + name, st, null);
        f.statuses.push(st);
      }
      text = Buffer.from(t, 'utf8');
      // A file that held only profile blocks and was created by the profile leaves again.
      if (t === '' && (f.before === null || (f.entry && f.entry.created && !f.fileItem))) text = null;
    }
    // JSON.
    if (f.json) {
      let obj = {};
      if (text !== null) {
        try { obj = JSON.parse(text.toString('utf8')); } catch (e) { obj = null; }
        if (!isObj(obj)) {
          for (const a of f.json.adds) row(a.item, 'json-merge', f.display, 'unreadable', 'not parsable JSON; never written');
          f.status = 'unreadable'; f.unreadable = 'unparsable JSON'; return;
        }
      }
      const prevKeys = (f.entry && f.entry.keys) || {};
      const prevHooks = (f.entry && f.entry.hooks) || [];
      f.keys = JSON.parse(JSON.stringify(prevKeys));
      f.hooks = prevHooks.slice();
      f.keysPrior = {};
      // Removals first.
      for (const r of f.json.removes) {
        if (r.hook) {
          removeHook(obj, r.hook);
          f.hooks = f.hooks.filter((h) => hookId(h) !== hookId(r.hook));
          row(r.item, 'json-merge', f.display + '#hooks', 'removed', null);
          continue;
        }
        const keys = r.path.split('.');
        const cur = getAt(obj, keys);
        if (r.array) {
          if (!cur.absent && Array.isArray(cur.value)) setAt(obj, keys, cur.value.filter((x) => !r.added.some((y) => canon(y) === canon(x))));
          const now = getAt(obj, keys);
          if (!now.absent && Array.isArray(now.value) && !now.value.length && r.created) delAt(obj, keys);
          delete f.keys[r.path];
          row(r.item, 'json-merge', f.display + '#' + r.path, 'removed', null);
          continue;
        }
        if (cur.absent || sha(Buffer.from(canon(cur.value))) !== r.sha) {
          row(r.item, 'json-merge', f.display + '#' + r.path, 'skipped', 'value edited since the profile set it; kept');
          delete f.keys[r.path];
          continue;
        }
        if (r.prior === 'absent') delAt(obj, keys);
        else {
          const p = readPre(dataDir, r.prior);
          if (p === null) { row(r.item, 'json-merge', f.display + '#' + r.path, 'skipped', 'prior value missing; kept'); delete f.keys[r.path]; continue; }
          setAt(obj, keys, JSON.parse(p.toString('utf8')).v);
        }
        delete f.keys[r.path];
        row(r.item, 'json-merge', f.display + '#' + r.path, 'removed', null);
      }
      // Additions.
      for (const a of f.json.adds) {
        for (const u of mergeUnits(a.value)) {
          if (u.hook) {
            const present = findHook(obj, u.hook);
            if (!present) addHook(obj, u.hook);
            if (!f.hooks.some((h) => hookId(h) === hookId(u.hook))) if (!present || prevHooks.some((h) => hookId(h) === hookId(u.hook))) f.hooks.push(Object.assign({ item: a.item }, u.hook));
            row(a.item, 'json-merge', f.display + '#hooks.' + u.hook.event, present ? 'same' : 'new', null);
            f.statuses.push(present ? 'same' : 'new');
            continue;
          }
          const cur = getAt(obj, u.keys);
          if (u.array) {
            const base = !cur.absent && Array.isArray(cur.value) ? cur.value.slice() : [];
            if (!cur.absent && !Array.isArray(cur.value)) { row(a.item, 'json-merge', f.display + '#' + u.path, 'conflict', 'not a list'); f.statuses.push('conflict'); continue; }
            const add = u.array.filter((x) => !base.some((y) => canon(y) === canon(x)));
            if (add.length) setAt(obj, u.keys, base.concat(add));
            const prev = f.keys[u.path];
            f.keys[u.path] = { item: a.item, array: true, added: ((prev && prev.added) || []).concat(add), created: prev ? !!prev.created : cur.absent };
            row(a.item, 'json-merge', f.display + '#' + u.path, add.length ? (cur.absent ? 'new' : 'differs') : 'same', null);
            f.statuses.push(add.length ? 'differs' : 'same');
            continue;
          }
          const want = canon(u.value);
          if (!cur.absent && canon(cur.value) === want) {
            row(a.item, 'json-merge', f.display + '#' + u.path, 'same', null); f.statuses.push('same');
            if (!f.keys[u.path] && prevKeys[u.path]) f.keys[u.path] = prevKeys[u.path];
            continue;
          }
          const ours = prevKeys[u.path] && !cur.absent && sha(Buffer.from(canon(cur.value))) === prevKeys[u.path].sha;
          if (!cur.absent && !ours) {
            const r = resolve[a.item];
            if (r !== 'replace') {
              const st = a.mode === 'add' || r === 'keep' ? 'skipped' : 'conflict';
              row(a.item, 'json-merge', f.display + '#' + u.path, st, st === 'skipped' ? 'user value kept' : 'a different value is set');
              f.statuses.push(st);
              continue;
            }
          }
          if (u.path === 'permissions.defaultMode' && u.value === 'bypassPermissions' && !out.needsAck.includes('set-bypass-permissions')) out.needsAck.push('set-bypass-permissions');
          if (!prevKeys[u.path]) f.keysPrior[u.path] = cur.absent ? { absent: true } : { value: cur.value };
          setAt(obj, u.keys, u.value);
          f.keys[u.path] = { item: a.item, sha: sha(Buffer.from(want)), prior: prevKeys[u.path] ? prevKeys[u.path].prior : null };
          row(a.item, 'json-merge', f.display + '#' + u.path, cur.absent ? 'new' : 'differs', null);
          f.statuses.push(cur.absent ? 'new' : 'differs');
        }
      }
      const was = text === null ? null : text.toString('utf8');
      const now = JSON.stringify(obj, null, 2) + '\n';
      const unchanged = was !== null && JSON.stringify(JSON.parse(was)) === JSON.stringify(obj);
      // A settings file the profile created and has now emptied leaves again.
      if (!Object.keys(obj).length && f.entry && f.entry.created && !f.fileItem) text = null;
      else text = unchanged ? text : (Object.keys(obj).length || was !== null ? Buffer.from(now, 'utf8') : null);
    }
    f.after = text;
    const changed = !(f.before === null ? f.after === null : f.after !== null && Buffer.compare(f.before, f.after) === 0);
    if (f.statuses.includes('conflict')) f.status = 'conflict';
    else if (!changed) f.status = f.keep ? 'skipped' : 'same';
    else f.status = f.before === null ? 'new' : (f.restorePre || f.json && f.json.removes.length && !f.json.adds.length ? 'removed' : 'differs');
  }

  out.missing = [...missingMap.values()];

  // --- Locks after apply (prior refs are filled by the transaction).
  for (const f of files.values()) {
    const lock = lockFor(f.side);
    if (!lock || f.status === 'unreadable' || f.status === 'conflict') continue;
    if (f.after === null) { delete lock.files[f.rel]; continue; }
    if (f.keep) continue;
    const prev = lock.files[f.rel] || null;
    const e = { sha: null, fileSha: prev ? prev.fileSha : null, created: prev ? !!prev.created : f.before === null, pre: prev ? prev.pre || null : (f.before === null ? null : 'PENDING'),
      items: [...f.items].filter((i) => E.includes(i)), fileItem: f.fileItem || (prev && E.includes(prev.fileItem) ? prev.fileItem : null) };
    if (f.restorePre) { delete lock.files[f.rel]; continue; }
    if (f.fileItem) e.fileSha = sha(f.content);
    if (f.blockInfo && Object.keys(f.blockInfo).length) e.blocks = f.blockInfo;
    if (f.keys && Object.keys(f.keys).length) {
      e.keys = {};
      for (const [k, v] of Object.entries(f.keys)) e.keys[k] = Object.assign({}, v, v.array ? {} : { prior: v.prior || (f.keysPrior[k] ? (f.keysPrior[k].absent ? 'absent' : 'PENDING') : 'absent') });
    }
    if (f.hooks && f.hooks.length) e.hooks = f.hooks;
    // Only what the profile owns is recorded (a file it left alone is not managed).
    if (!e.fileItem && !e.blocks && !e.keys && !e.hooks) { delete lock.files[f.rel]; continue; }
    e.sha = sha(f.after);
    lock.files[f.rel] = e;
  }
  for (const m of out.machine) {
    const side = m.kind === 'git' ? 'repo' : 'user';
    const lock = lockFor(side);
    if (!lock) continue;
    const map = m.kind === 'env' ? lock.env : m.kind === 'task' ? lock.tasks : m.kind === 'git' ? lock.git : null;
    if (!map) continue;
    const key = m.kind === 'git' ? m.key : m.name;
    if (m.op === 'restore') delete map[key];
    else if (m.op === 'set' && !map[key]) map[key] = { item: m.item, prior: 'PENDING' };
  }
  for (const side of ['repo', 'user']) {
    const lock = lockFor(side);
    if (!lock) continue;
    // Applied items per side: kept items of this side's lock, plus the added items that
    // contribute here (the primary side - the repo when there is one - takes them all).
    const primary = target.repo ? 'repo' : 'user';
    const kept = new Set(lock.items.filter((id) => !R.includes(id)));
    lock.items = model.order.filter((id) => kept.has(id) || (D.includes(id) && (side === primary || itemHasSide(model, id, side))));
    lock.profile = model.profile ? model.profile.profile : lock.profile;
    lock.version = model.profile ? model.profile.version : lock.version;
  }
  for (const side of ['repo', 'user']) if (nextLock[side] && !Array.isArray(nextLock[side].dirs)) nextLock[side].dirs = [];
  out.lockNext = nextLock;
  out.roots = { repo: target.repo || null, user: target.configDir || null };

  out.files = [...files.values()].map((f) => ({
    abs: f.abs, rel: f.rel, side: f.side, display: f.display, status: f.status, items: [...f.items], before: f.before, after: f.after,
    flag: f.flag || null, keysPrior: f.keysPrior || {}, restorePre: f.restorePre || null, keep: !!f.keep, removedSide: f.removedSide || null,
  }));
  for (const id of D) {
    const it = model.items.get(id).item;
    const changes = out.rows.some((r) => r.item === id && ['new', 'differs', 'removed'].includes(r.status));
    if (it.risk === 'high' && changes) out.highRisk.push(id);
  }
  out.counts = countRows(out.rows);
  return out;
}

function itemHasSide(model, id, side) {
  const it = model.items.get(id).item;
  return (it.contributes || []).some((c) => {
    if (side === 'user') return c.kind === 'env' || c.kind === 'task' || (typeof c.target === 'string' && c.target.startsWith('user:'));
    return c.kind === 'git' || c.kind === 'kit' || (typeof c.target === 'string' && c.target.startsWith('repo:'));
  });
}

function expandAll(model, ids) {
  const out = [];
  for (const id of ids) {
    if (model.items.has(id)) out.push(id);
    else { const m = model.modules.find((x) => x.id === id); if (m) for (const it of m.items) out.push(it.id); }
  }
  return model.order.filter((id) => out.includes(id));
}

function jsonVars(vars) {
  const o = {};
  for (const [k, v] of Object.entries(vars)) o[k] = JSON.stringify(String(v)).slice(1, -1);
  return o;
}

function readTpl(model, moduleId, template, dataDir, vars, item, needVar) {
  const t = P.readTemplate(model, moduleId, template, dataDir);
  const r = P.renderText(t.text, vars);
  if (r.missing.length) { needVar(r.missing, item); return null; }
  return r.text;
}

// pre ref {tx, ref} -> Buffer|null
function readPre(dataDir, ref) {
  if (!ref || typeof ref !== 'object' || !ref.tx || !ref.ref) return null;
  if (!/^[0-9A-Za-z-]+$/.test(ref.tx) || !/^[0-9A-Za-z._-]+$/.test(ref.ref)) return null;
  try { return fs.readFileSync(path.join(P.profileStateDir(dataDir), 'tx', ref.tx, 'pre', ref.ref)); } catch (e) { return null; }
}

function normXml(x) { return String(x || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').trim(); }

// ------------------------------------------------------------------ idempotent re-plan
// (L3x fix a) A secret env item never carries a value, so "same" is proven by reference
// or by sha256: the adapter reports the reference (secretRef), or the stored secret's
// sha256 (secretSha), or the user lock recorded at apply time the reference, the
// variable's sha256 and the sha256 of the DPAPI file it was mirrored from - all three
// must still hold (a re-stored secret or a hand-edited variable is "differs").
function secretFile(dataDir, ref) {
  return dataDir && /^[a-z][a-z0-9_-]{0,63}$/.test(String(ref)) ? path.join(P.profileStateDir(dataDir), 'secrets', ref + '.dpapi') : null;
}
function secretFileSha(dataDir, ref) {
  const f = secretFile(dataDir, ref);
  if (!f) return null;
  try { return sha(fs.readFileSync(f)); } catch (e) { return null; }
}
function secretSame(adapter, g, m, userLock, dataDir) {
  if (g.secretRef !== undefined && g.secretRef !== null) return g.secretRef === m.secret;
  if (typeof adapter.secretSha === 'function') {
    const s = adapter.secretSha(m.secret);
    if (s) return s === g.sha256;
  }
  const le = userLock && userLock.env ? userLock.env[m.name] : null;
  if (!le || le.secret !== m.secret || !le.sha256 || le.sha256 !== g.sha256) return false;
  if (le.secretFileSha) return le.secretFileSha === secretFileSha(dataDir, m.secret);
  return true;
}

// A scheduled task is compared by what it does, not by the bytes /Query /XML returns
// (Windows re-serialises: UTF-16 declaration, CRLF, RegistrationInfo, spelled-out
// defaults, its own element order). Normalised fields: every trigger (kind, start time,
// day / week interval, days, repetition, delay, enabled), the one action (exe without
// quotes, case or slash differences; arguments; working dir), enabled, hidden, runtime
// cap, run level, logon type. XML that does not parse falls back to normalised text.
function xmlTag(xml, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([^<]*)</' + name + '>').exec(xml);
  return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim() : '';
}
function taskSemantics(xml) {
  const x = String(xml || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!/<Task[\s>]/.test(x) || !/<Exec>/.test(x)) return null;
  const pathish = (s) => String(s || '').replace(/^"(.*)"$/, '$1').replace(/\\/g, '/').toLowerCase();
  const triggers = [];
  const re = /<(TimeTrigger|CalendarTrigger|LogonTrigger|BootTrigger|IdleTrigger|EventTrigger|SessionStateChangeTrigger)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let t;
  while ((t = re.exec(x))) {
    const b = t[2];
    const sb = /<StartBoundary>[^<T]*T(\d{2}:\d{2})/.exec(b);
    const days = (/<DaysOfWeek>([\s\S]*?)<\/DaysOfWeek>/.exec(b) || [])[1] || '';
    triggers.push({
      kind: t[1], at: sb ? sb[1] : null,
      sched: /<ScheduleByWeek>/.test(b) ? 'week' : /<ScheduleByMonth/.test(b) ? 'month' : /<ScheduleByDay>/.test(b) ? 'day' : null,
      daysInterval: xmlTag(b, 'DaysInterval') || null, weeksInterval: xmlTag(b, 'WeeksInterval') || null,
      days: (days.match(/<([A-Z][a-z]+day) ?\/>/g) || []).map((d) => d.replace(/[<\/> ]/g, '')).sort().join(','),
      every: xmlTag(b, 'Interval') || null, duration: xmlTag(b, 'Duration') || null, delay: xmlTag(b, 'Delay') || null,
      enabled: !/<Enabled>false<\/Enabled>/.test(b),
    });
  }
  triggers.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  const settings = (/<Settings>([\s\S]*?)<\/Settings>/.exec(x) || [])[1] || '';
  const execs = x.match(/<Exec>[\s\S]*?<\/Exec>/g) || [];
  return {
    triggers,
    actions: execs.map((e) => ({ exe: pathish(xmlTag(e, 'Command')), args: xmlTag(e, 'Arguments').replace(/\s+/g, ' '), workdir: pathish(xmlTag(e, 'WorkingDirectory')) })),
    enabled: !/<Enabled>false<\/Enabled>/.test(settings),
    hidden: /<Hidden>true<\/Hidden>/.test(settings),
    limit: xmlTag(settings, 'ExecutionTimeLimit') || 'PT72H',
    runLevel: xmlTag(x, 'RunLevel') || 'LeastPrivilege',
    logonType: xmlTag(x, 'LogonType') || 'InteractiveToken',
  };
}
function taskSame(a, b) {
  const sa = taskSemantics(a);
  const sb = taskSemantics(b);
  if (!sa || !sb) return normXml(a) === normXml(b);
  return canon(sa) === canon(sb);
}
function safeMachine(m) { const o = Object.assign({}, m); delete o.value; return o; }

function countRows(rows) {
  const c = { new: 0, same: 0, differs: 0, removed: 0, conflict: 0, unreadable: 0, skipped: 0 };
  for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
  return c;
}

// Exit code of a plan: 2 = conflicts need a decision (or two on items conflict), 1 = refused
// (unreadable, missing variable, variable error), 0 = ok.
function planVerdict(p) {
  if (p.conflictsPairs.length) return { code: 2, line: 'items conflict: ' + p.conflictsPairs.map((x) => x.join(' vs ')).join('; ') + ' - turn one off' };
  const conf = p.rows.find((r) => r.status === 'conflict');
  if (conf) return { code: 2, line: 'conflict: ' + conf.item + ' at ' + conf.target + ' - ' + conf.reason + ' (decide with --replace ' + conf.item + ' or --keep ' + conf.item + ')' };
  const un = p.rows.find((r) => r.status === 'unreadable');
  if (un) return { code: 1, line: 'refused: ' + un.item + ' at ' + un.target + ' - ' + un.reason };
  if (p.varErrors.length) return { code: 1, line: 'refused: variable ' + p.varErrors[0].name + ' ' + p.varErrors[0].msg };
  if (p.missing.length) { const m = p.missing[0]; return { code: 1, line: 'refused: ' + m.items[0] + ' needs {' + m.name + '}' + (m.ask ? ' (asked at ' + m.ask + ')' : '') + '; set it with --var ' + m.name + '=...' }; }
  return { code: 0, line: null };
}

function diffText(p) {
  const parts = [];
  for (const f of p.files) {
    if (f.status === 'same' || f.status === 'unreadable') continue;
    const bin = (b) => b && b.subarray(0, 8000).includes(0);
    if (bin(f.before) || bin(f.after)) { parts.push('Binary ' + f.display + ' ' + f.status + '\n'); continue; }
    const d = udiff(f.before === null ? null : f.before.toString('utf8'), f.after === null ? null : f.after.toString('utf8'), f.display);
    if (d) parts.push(d);
  }
  for (const m of p.machine) {
    if (m.status === 'same' || m.op === 'none') continue;
    if (m.kind === 'env') parts.push('env ' + m.name + ': ' + (m.op === 'restore' ? 'restore previous' : m.secret ? 'set to secret reference ' + m.secret : 'set (value not shown)') + '\n');
    else if (m.kind === 'git') parts.push('git config --local ' + m.key + ': ' + (m.op === 'restore' ? 'restore previous' : m.value) + '\n');
    else if (m.kind === 'task') parts.push('scheduled task ' + m.name + ': ' + (m.op === 'restore' ? 'remove / restore previous' : m.status === 'new' ? 'register' : 'update') + '\n');
  }
  return parts.join('\n');
}

function planLines(p) {
  const lines = [];
  lines.push('Profile plan' + (p.target.repo ? ' for repo ' + p.target.repo : '') + (p.target.configDir ? ' and ' + p.target.configDir : '') + ' (dry run; nothing written)');
  if (p.depsAdded.length) lines.push('also on (dependencies): ' + p.depsAdded.join(', '));
  for (const r of p.rows) lines.push(r.status.padEnd(10) + ' ' + r.item + '  ' + r.kind + ' ' + r.target + (r.reason ? '  - ' + r.reason : ''));
  const c = p.counts;
  lines.push('counts: new ' + c.new + ', differs ' + c.differs + ', removed ' + c.removed + ', same ' + c.same + ', conflict ' + c.conflict + ', unreadable ' + c.unreadable + ', skipped ' + c.skipped);
  if (p.highRisk.length) lines.push('high risk (needs --ack <id> each): ' + p.highRisk.join(', '));
  if (p.needsAck.length) lines.push('needs the typed acknowledgement: ' + p.needsAck.map((x) => '--ack ' + x).join(' '));
  return lines;
}

module.exports = {
  plan, planVerdict, planLines, diffText, udiff, markersFor, findBlock, setBlock, removeBlock, mergeUnits,
  readLock, emptyLock, repoLockFile, userLockFile, readPre, LOCK_REL, sha, canon, countRows,
  lcsDiff, splitLines, taskSemantics, taskSame, secretSame, secretFileSha,
};
