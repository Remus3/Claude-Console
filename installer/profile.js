'use strict';
// Setup profile engine, part 1 (CON-013 L3): load + validate the shipped profile, presets
// and user overrides; selection state (enable / disable / presets / dependency closure);
// variable resolution and template rendering. Pure apart from reading files and the
// small selection / override writers at the bottom. Planning is profile-plan.js, the
// transaction is profile-tx.js, read-back is profile-verify.js, presets and updates are
// profile-update.js. openEngine() at the end is the one facade the CLI, the server
// routes (L5) and adopt (L3x) call.
//
// State never lives in the install dir: <dataDir>/profile/ holds selection.json,
// overrides/<module>/<template>, tx/<stamp>/, locks/user.json and targets.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const schema = require('./profile-schema');
const { readJson, exists, writeJsonAtomic } = require('./fsutil');

const VAR_REF = /(?<!\$)\{([a-z][a-z0-9_]*)\}/g;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ load

// Loads and validates a profile directory. Returns {ok, errors, profile, modules,
// items: Map id -> {item, module}, order: [item ids], presets: {name: {modules, items}}, dir}.
function loadProfile(dir) {
  const v = schema.validateProfileDir(dir);
  const model = { ok: v.ok, errors: v.errors, dir: path.resolve(dir), profile: v.profile, modules: [], items: new Map(), order: [], presets: {} };
  if (!v.profile) return model;
  const byId = new Map(v.modules.filter(isObj).map((m) => [m.id, m]));
  for (const id of v.profile.modules || []) {
    const m = byId.get(id);
    if (!m) continue;
    model.modules.push(m);
    for (const it of Array.isArray(m.items) ? m.items : []) {
      if (!isObj(it) || typeof it.id !== 'string') continue;
      model.items.set(it.id, { item: it, module: m });
      model.order.push(it.id);
    }
  }
  model.presets = loadPresets(dir, v.profile);
  return model;
}

// Presets: profile.json lists module ids (or "*"); presets/<name>.json (generated, e.g. the
// author's preset) may carry an item-level map. Both shapes end up as {modules, items}.
function loadPresets(dir, profile) {
  const out = {};
  const all = Array.isArray(profile.modules) ? profile.modules.slice() : [];
  for (const [name, v] of Object.entries(isObj(profile.presets) ? profile.presets : {})) {
    if (v === '*') out[name] = { name, modules: all, items: {} };
    else if (Array.isArray(v)) out[name] = { name, modules: v.slice(), items: {} };
  }
  const pdir = path.join(dir, 'presets');
  let names = [];
  try { names = fs.readdirSync(pdir).filter((f) => /^[a-z][a-z0-9-]*\.json$/.test(f)); } catch (e) { /* none */ }
  for (const f of names) {
    const j = readJson(path.join(pdir, f), null);
    if (!isObj(j)) continue;
    const name = f.replace(/\.json$/, '');
    const items = isObj(j.items) ? j.items : {};
    const modules = Array.isArray(j.modules) ? j.modules : j.modules === '*' ? all : (out[name] ? out[name].modules : all);
    out[name] = { name, modules, items: normaliseItemMap(items), variables: presetValues(j.variables),
      version: j.version || null, generated_from: j.generated_from || null, source_sha: j.source_sha || null, title: typeof j.title === 'string' ? j.title : null };
  }
  return out;
}

// A preset file records each variable as {value: v} (the author's value) or {ask: step}
// (asked of the user): only the values become selection variables. A bare value is kept.
// (013-VERIFY sandbox F: the raw {value} / {ask} objects were assigned as values.)
function presetValues(vars) {
  const out = {};
  if (!isObj(vars)) return out;
  for (const [k, v] of Object.entries(vars)) {
    if (isObj(v)) { if (Object.prototype.hasOwnProperty.call(v, 'value') && v.value !== null && v.value !== undefined) out[k] = v.value; }
    else if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function normaliseItemMap(items) {
  const out = {};
  for (const [id, v] of Object.entries(items)) {
    const s = isObj(v) ? v.state : v;
    if (s === 'on' || s === true) out[id] = 'on';
    else if (s === 'off' || s === false) out[id] = 'off';
  }
  return out;
}

// ------------------------------------------------------------------ selection state

function emptySelection(model) {
  return { schema: 1, profile: model.profile ? model.profile.profile : null, version: model.profile ? model.profile.version : null,
    path: null, preset: null, modules: {}, items: {}, variables: {}, review_ack: null };
}

function normaliseSelection(sel, model) {
  const s = Object.assign(emptySelection(model), isObj(sel) ? sel : {});
  for (const k of ['modules', 'items', 'variables']) if (!isObj(s[k])) s[k] = {};
  return s;
}

function moduleOn(model, sel, m) {
  if (m.locked === true) return true;
  const v = sel.modules[m.id];
  if (v === 'on' || v === 'off') return v === 'on';
  if (sel.preset && model.presets[sel.preset]) return model.presets[sel.preset].modules.includes(m.id);
  return m.default === 'on';
}

// Map id -> {on, why} with why one of locked | item | preset-item | module | default.
// Item state wins over module state; a locked module's items are always on.
function effectiveState(model, sel) {
  sel = normaliseSelection(sel, model);
  const out = new Map();
  const preset = sel.preset ? model.presets[sel.preset] : null;
  for (const id of model.order) {
    const { item, module: m } = model.items.get(id);
    if (m.locked === true) { out.set(id, { on: true, why: 'locked' }); continue; }
    const v = sel.items[id];
    if (v === 'on' || v === 'off') { out.set(id, { on: v === 'on', why: 'item' }); continue; }
    if (preset && preset.items[id] && sel.modules[m.id] === undefined) { out.set(id, { on: preset.items[id] === 'on', why: 'preset-item' }); continue; }
    const mon = moduleOn(model, sel, m);
    out.set(id, { on: mon && item.default === 'on', why: mon ? 'module' : 'default' });
  }
  return out;
}

function onIds(model, sel) {
  const st = effectiveState(model, sel);
  return model.order.filter((id) => st.get(id).on);
}

const deps = (model, id) => { const e = model.items.get(id); return e && Array.isArray(e.item.depends_on) ? e.item.depends_on : []; };

// Transitive dependencies of ids (excluding ids), in profile order.
function dependencyClosure(model, ids) {
  const seen = new Set(ids);
  const add = [];
  const stack = ids.slice();
  while (stack.length) {
    for (const d of deps(model, stack.pop())) if (!seen.has(d) && model.items.has(d)) { seen.add(d); add.push(d); stack.push(d); }
  }
  return model.order.filter((id) => add.includes(id));
}

// Items that (transitively) depend on any of ids, excluding ids.
function dependants(model, ids) {
  const set = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of model.order) {
      if (set.has(id)) continue;
      if (deps(model, id).some((d) => set.has(d))) { set.add(id); grew = true; }
    }
  }
  return model.order.filter((id) => set.has(id) && !ids.includes(id));
}

// Expands module ids to their items (items whose default is on, or every item of a
// locked module); item ids stay. Unknown ids are returned in `unknown`.
function expandIds(model, ids) {
  const out = [];
  const unknown = [];
  for (const id of ids) {
    if (model.items.has(id)) { if (!out.includes(id)) out.push(id); continue; }
    const m = model.modules.find((x) => x.id === id);
    if (!m) { unknown.push(id); continue; }
    for (const it of m.items) if ((m.locked || it.default === 'on') && !out.includes(it.id)) out.push(it.id);
  }
  return { ids: model.order.filter((id) => out.includes(id)), unknown };
}

// enable/disable edit the selection only (nothing reaches a target until apply).
// enable returns the dependencies it also turned on and the conflicts it found;
// disable returns the dependants that went off with it. Locked items refuse.
function enable(model, sel, ids) {
  sel = normaliseSelection(JSON.parse(JSON.stringify(sel || {})), model);
  const ex = expandIds(model, ids);
  if (ex.unknown.length) return { ok: false, reason: 'unknown id: ' + ex.unknown.join(', '), selection: sel };
  const added = dependencyClosure(model, ex.ids).filter((id) => !effectiveState(model, sel).get(id).on);
  for (const id of ex.ids.concat(added)) sel.items[id] = 'on';
  for (const id of ids) if (model.modules.some((m) => m.id === id)) sel.modules[id] = 'on';
  const on = new Set(onIds(model, sel));
  const conflicts = [];
  for (const id of ex.ids.concat(added)) {
    const e = model.items.get(id).item;
    for (const c of e.conflicts_with || []) if (on.has(c)) conflicts.push([id, c]);
  }
  return { ok: conflicts.length === 0, selection: sel, added, conflicts, reason: conflicts.length ? 'conflict: ' + conflicts.map((p) => p.join(' vs ')).join('; ') : null };
}

function disable(model, sel, ids) {
  sel = normaliseSelection(JSON.parse(JSON.stringify(sel || {})), model);
  const items = [];
  for (const id of ids) {
    if (model.items.has(id)) items.push(id);
    else {
      const m = model.modules.find((x) => x.id === id);
      if (!m) return { ok: false, reason: 'unknown id: ' + id, selection: sel };
      if (m.locked) return { ok: false, reason: id + ' is always on (locked)', selection: sel };
      sel.modules[id] = 'off';
      for (const it of m.items) items.push(it.id);
    }
  }
  for (const id of items) if (model.items.get(id).module.locked) return { ok: false, reason: id + ' is always on (locked)', selection: sel };
  const cur = effectiveState(model, sel);
  const removed = dependants(model, items).filter((id) => cur.get(id).on);
  for (const id of removed) if (model.items.get(id).module.locked) return { ok: false, reason: id + ' (locked) depends on it', selection: sel };
  for (const id of items.concat(removed)) sel.items[id] = 'off';
  return { ok: true, selection: sel, removed };
}

// Conflicting pairs among an on-set (each pair once).
function conflictsAmong(model, ids) {
  const on = new Set(ids);
  const out = [];
  for (const id of ids) for (const c of model.items.get(id).item.conflicts_with || []) if (on.has(c) && id < c) out.push([id, c]);
  return out;
}

// ------------------------------------------------------------------ variables

function builtins(o) {
  o = o || {};
  const home = o.home || os.homedir();
  const fwd = (p) => String(p).replace(/\\/g, '/');
  return {
    home: fwd(home),
    documents: fwd(o.documents || path.join(home, 'Documents')),
    temp: fwd(o.temp || os.tmpdir()),
    data_dir: fwd(o.dataDir || path.join(home, '.claude-console-data')),
  };
}

// values: user values (selection.variables + CLI); ctx: {builtins, repoRoot, configDir,
// detect(name, kind)}. Returns {vars: {name: string}, errors: [{name, msg}], asks: {name: ask}}.
function resolveVariables(model, values, ctx) {
  ctx = ctx || {};
  const decl = (model.profile && isObj(model.profile.variables)) ? model.profile.variables : {};
  const vars = Object.assign({}, ctx.builtins || builtins(ctx));
  const errors = [];
  const asks = {};
  const str = (v) => (isObj(v) || Array.isArray(v) ? JSON.stringify(v) : String(v));
  for (const [name, d] of Object.entries(decl)) {
    asks[name] = d.ask || null;
    if (d.type === 'derived') continue;
    let v = values && values[name] !== undefined && values[name] !== null && values[name] !== '' ? values[name] : undefined;
    if (v === undefined && name === 'repo_root' && ctx.repoRoot) v = String(ctx.repoRoot).replace(/\\/g, '/');
    if (v === undefined && name === 'config_dir' && ctx.configDir) v = String(ctx.configDir).replace(/\\/g, '/');
    if (v === undefined && d.detect === 'claude-project-slug' && ctx.repoRoot) v = projectSlug(ctx.repoRoot);
    if (v === undefined && d.detect && typeof ctx.detect === 'function') {
      const got = ctx.detect(d.detect, d.type);
      if (got) v = String(got).replace(/\\/g, '/');
    }
    if (v === undefined && d.default !== undefined && d.default !== null) v = d.default;
    if (v === undefined) continue;
    if (d.secret === true) { errors.push({ name, msg: 'a secret is never a template value (use a reference)' }); continue; }
    if (d.type === 'int') {
      const n = Number(v);
      if (!Number.isInteger(n) || (Number.isInteger(d.min) && n < d.min) || (Number.isInteger(d.max) && n > d.max)) { errors.push({ name, msg: 'must be an integer in range' }); continue; }
      v = n;
    }
    let s = str(v);
    if (typeof v === 'string' && /\{[a-z]/.test(v)) s = renderText(v, vars).text;
    if (d.pattern && !new RegExp(d.pattern).test(s)) { errors.push({ name, msg: 'does not match ' + d.pattern }); continue; }
    vars[name] = s;
  }
  // Derived values, resolved until stable (no cycles: the schema refuses self-reference).
  for (let pass = 0; pass < 5; pass++) {
    for (const [name, d] of Object.entries(decl)) {
      if (d.type !== 'derived' || vars[name] !== undefined) continue;
      const r = renderText(d.value, vars);
      if (!r.missing.length) vars[name] = r.text;
    }
  }
  return { vars, errors, asks };
}

// The folder name Claude Code uses for a repo's transcripts and memory under
// <config>/projects/: the absolute repo path with every non-alphanumeric byte as '-'
// (C:\Work\app -> C--Work-app). Same rule as the preset generator's memory probe.
function projectSlug(repoRoot) {
  const abs = path.resolve(String(repoRoot));
  return abs.replace(/[^A-Za-z0-9]/g, '-');
}

// Bare command names for exe-typed variables, used in TRACKED files (a repo's
// .claude/settings.json is committed and shared): no machine path is ever written there;
// the name resolves on PATH at run time.
const BARE_EXE = { python: process.platform === 'win32' ? 'python' : 'python3', node: 'node' };
function trackedVars(model, vars) {
  const decl = (model && model.profile && isObj(model.profile.variables)) ? model.profile.variables : {};
  const o = Object.assign({}, vars);
  for (const [name, d] of Object.entries(decl)) if (d && d.type === 'exe' && o[name] !== undefined) o[name] = BARE_EXE[name] || path.basename(String(o[name])).replace(/\.exe$/i, '');
  return o;
}

// Replaces {name} (never ${name}); unknown names stay as written and are listed in missing.
function renderText(text, vars) {
  const missing = [];
  const out = String(text).replace(VAR_REF, (m, name) => {
    if (vars && Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (!missing.includes(name)) missing.push(name);
    return m;
  });
  return { text: out, missing };
}

// ------------------------------------------------------------------ templates and overrides

function profileStateDir(dataDir) { return path.join(dataDir, 'profile'); }
function overridePath(dataDir, moduleId, template) { return path.join(profileStateDir(dataDir), 'overrides', moduleId, ...template.split('/')); }

// Returns {text, source: 'override'|'shipped', file}. Throws when the shipped file is missing.
function readTemplate(model, moduleId, template, dataDir) {
  if (dataDir) {
    const o = overridePath(dataDir, moduleId, template);
    if (exists(o)) return { text: fs.readFileSync(o, 'utf8'), source: 'override', file: o };
  }
  const f = path.join(model.dir, 'modules', moduleId, ...template.split('/'));
  return { text: fs.readFileSync(f, 'utf8'), source: 'shipped', file: f };
}

// Validates override text the way shipped templates are validated.
function checkTemplateText(model, text) {
  const errors = [];
  const declared = new Set([...Object.keys((model.profile && model.profile.variables) || {}), ...schema.BUILTIN_VARIABLES]);
  if (/\r/.test(text)) errors.push('CR byte (LF only)');
  String(text).split('\n').forEach((line, i) => {
    if (/[^\x09\x20-\x7e]/.test(line)) errors.push('non-ASCII at line ' + (i + 1));
    for (const v of schema.varRefs(line)) if (!declared.has(v)) errors.push('unknown variable {' + v + '} at line ' + (i + 1));
    for (const h of schema.literalHits(line)) errors.push('literal ' + h + ' at line ' + (i + 1));
  });
  return errors;
}

function templatesOf(model, itemId) {
  const e = model.items.get(itemId);
  if (!e) return [];
  return (e.item.contributes || []).filter((c) => typeof c.template === 'string').map((c) => c.template);
}

// edit: writes ONLY overrides/<module>/<template>. reset drops it (to the Recycle Bin
// through deps.recycle when given; an override is the user's own text).
async function editTemplate(model, dataDir, itemId, o) {
  o = o || {};
  const e = model.items.get(itemId);
  if (!e) return { ok: false, reason: 'unknown item ' + itemId };
  const list = templatesOf(model, itemId);
  const template = o.template || list[0];
  if (!template || !list.includes(template)) return { ok: false, reason: 'item ' + itemId + ' has no template ' + (o.template || '') };
  const file = overridePath(dataDir, e.module.id, template);
  if (o.reset) {
    if (!exists(file)) return { ok: true, reset: false, file, template };
    if (o.recycle) await o.recycle(file);
    else fs.renameSync(file, file + '.reset-' + Date.now());
    return { ok: true, reset: true, file, template };
  }
  if (typeof o.text !== 'string') return { ok: true, file, template, text: readTemplate(model, e.module.id, template, dataDir).text };
  const errs = checkTemplateText(model, o.text);
  if (errs.length) return { ok: false, reason: errs[0], errors: errs, template };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, o.text);
  fs.renameSync(tmp, file);
  return { ok: true, file, template };
}

// ------------------------------------------------------------------ selection file

function selectionFile(dataDir) { return path.join(profileStateDir(dataDir), 'selection.json'); }

// A corrupt selection.json reads as empty (recovery reads the journals instead).
function readSelection(dataDir, model) {
  const j = readJson(selectionFile(dataDir), null);
  return normaliseSelection(isObj(j) ? j : {}, model);
}

function writeSelection(dataDir, sel) { writeJsonAtomic(selectionFile(dataDir), sel); }

// ------------------------------------------------------------------ view / list

function itemView(model, id, state) {
  const e = model.items.get(id);
  if (!e) return null;
  const it = e.item;
  const st = state ? state.get(id) : null;
  return {
    id, order: it.order, module: e.module.id, title: it.title, does: it.does, why: it.why, risk: it.risk,
    default: it.default, locked: e.module.locked === true, platform: it.platform, scope: it.scope || 'generic',
    depends_on: it.depends_on || [], pairs_with: it.pairs_with || [], conflicts_with: it.conflicts_with || [],
    contributes: (it.contributes || []).map((c) => Object.assign({}, c)),
    state: st ? (st.on ? 'on' : 'off') : null, state_why: st ? st.why : null,
  };
}

function listView(model, sel) {
  const st = effectiveState(model, sel);
  return model.modules.map((m) => ({
    id: m.id, order: m.order, title: m.title, summary: m.summary, locked: m.locked === true,
    on: m.items.filter((it) => st.get(it.id).on).length, total: m.items.length,
    items: m.items.map((it) => itemView(model, it.id, st)),
  }));
}

// ------------------------------------------------------------------ engine facade

// The one API the CLI, the server routes (L5) and adopt (L3x) call. o: {profileDir,
// dataDir, configDir, deps: {env, tasks, git, recycle, appConfig, runHook}, platform, ctx}.
// Every method is read-only unless it says it writes; writes need confirm: true.
function openEngine(o) {
  const PL = require('./profile-plan');
  const TX = require('./profile-tx');
  const PV = require('./profile-verify');
  const PU = require('./profile-update');
  const model = loadProfile(o.profileDir);
  const dataDir = o.dataDir;
  const deps = Object.assign({}, o.deps || {});
  const targetOf = (t) => ({ repo: t && t.repo ? path.resolve(t.repo) : null, configDir: t && t.configDir !== undefined ? t.configDir : (o.configDir || null) });
  const eng = {
    model, dataDir,
    selection: () => readSelection(dataDir, model),
    saveSelection: (sel) => writeSelection(dataDir, normaliseSelection(sel, model)), // writes selection.json only
    list: (sel) => listView(model, sel || readSelection(dataDir, model)),
    view: (id) => {
      const st = effectiveState(model, readSelection(dataDir, model));
      if (model.items.has(id)) return { kind: 'item', item: itemView(model, id, st) };
      const m = model.modules.find((x) => x.id === id);
      return m ? { kind: 'module', module: listView(model, readSelection(dataDir, model)).find((x) => x.id === id) } : null;
    },
    // p = {target: {repo, configDir}, only, remove, values, resolve, selection}
    plan: (p) => PL.plan(Object.assign({ model, dataDir, deps, platform: o.platform, ctx: o.ctx, selection: (p && p.selection) || readSelection(dataDir, model) }, p || {}, { target: targetOf(p && p.target) })),
    verdict: (plan) => PL.planVerdict(plan),
    diff: (plan) => PL.diffText(plan),
    planLines: (plan) => PL.planLines(plan),
    // Writes. a = {confirm, acks, groupedConsent, taskConsent, selection}; taskConsent is
    // {mode: 'per-task', tasks: {<name>: true}} or {mode: 'grouped', yes, listed: [names]}
    // (profile-tx.js tasksNeedingConsent(plan) lists the tasks to ask about).
    apply: (plan, a) => TX.applyPlan(plan, Object.assign({ model, dataDir, deps }, a || {})),
    revert: (txId, a) => TX.revertTx(dataDir, txId || 'last', Object.assign({ deps }, a || {})),
    txList: () => TX.listTx(dataDir),
    journal: (txId) => TX.readJournal(dataDir, txId),
    enable: (ids) => { const r = enable(model, readSelection(dataDir, model), ids); if (r.ok) writeSelection(dataDir, r.selection); return r; },
    disable: (ids) => { const r = disable(model, readSelection(dataDir, model), ids); if (r.ok) writeSelection(dataDir, r.selection); return r; },
    edit: (itemId, a) => editTemplate(model, dataDir, itemId, Object.assign({ recycle: deps.recycle }, a || {})),
    uninstall: (ids, t) => PL.plan({ model, dataDir, deps, platform: o.platform, ctx: o.ctx, selection: readSelection(dataDir, model), target: targetOf(t), remove: ids === 'all' ? model.order.slice() : ids }),
    verify: (t, a) => ({ items: PV.verifyItems(Object.assign({ model, dataDir, deps, platform: o.platform, ctx: o.ctx, selection: readSelection(dataDir, model), target: targetOf(t) }, a || {})), lock: PV.verifyLock({ model, dataDir, target: targetOf(t) }) }),
    status: (t) => {
      const target = targetOf(t);
      // Applied = this repo's lock (or, with no repo given, every repo the profile was
      // applied to) plus the user lock.
      const tj = readJson(path.join(profileStateDir(dataDir), 'targets.json'), null);
      const repos = target.repo ? [target.repo] : (tj && Array.isArray(tj.repos) ? tj.repos : []);
      const lockUser = PL.readLock(PL.userLockFile(dataDir), model);
      const drift = PV.verifyLock({ model, dataDir, target });
      const sel = readSelection(dataDir, model);
      const on = onIds(model, sel);
      const applied = new Set(lockUser.items);
      for (const r of repos) for (const id of PL.readLock(PL.repoLockFile(r), model).items) applied.add(id);
      const pending = on.filter((id) => !applied.has(id)).concat([...applied].filter((id) => !on.includes(id)));
      const txs = TX.listTx(dataDir);
      return { profile: model.profile ? model.profile.version : null, on: on.length, total: model.order.length, applied: [...applied], pending,
        drift: drift.rows.filter((r) => r.state !== 'ok'), lastTx: txs.length ? txs[txs.length - 1] : null, preset: sel.preset, path: sel.path };
    },
    // Path A / B and updates (profile-update.js).
    presetSelection: (name, a) => PU.presetSelection(model, name, a),
    switchToCustom: (sel) => PU.switchToCustom(model, sel || readSelection(dataDir, model)),
    switchBackToPreset: (custom, preset) => PU.switchBackToPreset(model, custom, preset),
    updateOffer: (newProfileDir) => PU.updateOffer(model, loadProfile(newProfileDir), readSelection(dataDir, model), dataDir),
    mergeOverrides: (newProfileDir, a) => PU.mergeOverrides(model, loadProfile(newProfileDir), dataDir, a),
    inputsOf: (id) => PU.inputsOf(model, id),
  };
  return eng;
}

module.exports = {
  openEngine,
  loadProfile, loadPresets, emptySelection, normaliseSelection, effectiveState, onIds, moduleOn,
  dependencyClosure, dependants, expandIds, enable, disable, conflictsAmong,
  builtins, resolveVariables, renderText, projectSlug, trackedVars, BARE_EXE, readTemplate, checkTemplateText, templatesOf, editTemplate,
  profileStateDir, overridePath, selectionFile, readSelection, writeSelection, itemView, listView,
};
