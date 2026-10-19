'use strict';
// Setup profile engine, part 5 (CON-013 L3, addendum f): the two setup paths and the
// update behaviour.
//   Path A (preset): presetSelection() builds the selection from a preset; a skipped
//   input turns off every item that needs it (and its dependants), each named
//   `off - needs <input>`. switchToCustom() opens path B pre-filled from that baseline;
//   switchBackToPreset() drops the custom changes and says how many.
//   Updates: an untouched preset user gets presetDiff() (added / removed / changed
//   default / changed template) and the new preset; a customised user gets a 3-way merge
//   of item states (mergeSelection) and of template overrides (mergeOverrides, reusing
//   installer/merge.js) where their choices win and conflicts are listed; a path B user
//   only sees a "new items available" count. Nothing here writes a target; the merged
//   selection goes through the normal plan + apply.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./profile');
const { mergeFile } = require('./merge');
const { exists } = require('./fsutil');
const { stamp } = require('./paths');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const VAR_REF = /(?<!\$)\{([a-z][a-z0-9_]*)\}/g;

// The inputs an item needs: variables its targets, values and templates reference, and
// the secret references of its env contributions.
function inputsOf(model, id) {
  const { item, module: m } = model.items.get(id);
  const decl = (model.profile && model.profile.variables) || {};
  const names = new Set();
  const scan = (s) => { for (const x of String(s).matchAll(VAR_REF)) names.add(x[1]); };
  for (const c of item.contributes || []) {
    for (const k of ['target', 'value', 'name', 'key']) if (typeof c[k] === 'string') scan(c[k]);
    if (c.value && typeof c.value === 'object') scan(JSON.stringify(c.value));
    if (typeof c.template === 'string') { try { scan(P.readTemplate(model, m.id, c.template, null).text); } catch (e) { /* schema reports it */ } }
    if (c.kind === 'env' && c.secret) names.add('secret:' + c.secret);
  }
  // Expand derived variables to the inputs they are made of.
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of [...names]) {
      const d = decl[n];
      if (d && d.type === 'derived') for (const x of String(d.value).matchAll(VAR_REF)) if (!names.has(x[1])) { names.add(x[1]); grew = true; }
    }
  }
  return [...names].filter((n) => n.startsWith('secret:') || decl[n]);
}

// o.skipped: input names the user skipped (variables, or secret:<name>).
function presetSelection(model, name, o) {
  o = o || {};
  if (!model.presets[name]) return { ok: false, reason: 'unknown preset ' + name };
  const sel = P.emptySelection(model);
  sel.path = 'preset';
  sel.preset = name;
  Object.assign(sel.variables, model.presets[name].variables || {}, o.values || {});
  const skipped = new Set(o.skipped || []);
  const offNeeds = [];
  if (skipped.size) {
    const on = P.onIds(model, sel);
    // As the wizard's skip op: a skipped variable / secret, or a no to the item's env
    // variable (env:NAME) or scheduled task (task:NAME), turns the item off.
    const needsOf = (id) => {
      const out = inputsOf(model, id).filter((n) => skipped.has(n));
      for (const c of model.items.get(id).item.contributes || []) {
        if (c.kind === 'env' && skipped.has('env:' + c.name)) out.push('env:' + c.name);
        if (c.kind === 'task' && skipped.has('task:' + c.name)) out.push('task:' + c.name);
      }
      return out;
    };
    const direct = on.filter((id) => !model.items.get(id).module.locked && needsOf(id).length);
    const all = direct.concat(P.dependants(model, direct).filter((id) => on.includes(id)));
    for (const id of all) {
      if (model.items.get(id).module.locked) continue;
      sel.items[id] = 'off';
      const needs = needsOf(id);
      offNeeds.push({ item: id, needs: needs.length ? needs : ['(depends on ' + direct.filter((d) => P.dependencyClosure(model, [id]).includes(d)).join(', ') + ')'] });
    }
  }
  sel.needs_off = offNeeds.map((x) => x.item);
  return { ok: true, selection: sel, offNeeds };
}

// Path B baseline from the current (preset) state: every module and item explicit.
function switchToCustom(model, sel) {
  sel = P.normaliseSelection(sel, model);
  const st = P.effectiveState(model, sel);
  const out = P.emptySelection(model);
  out.path = 'custom';
  out.from_preset = sel.preset || null;
  out.variables = Object.assign({}, sel.variables);
  out.review_ack = sel.review_ack || null;
  for (const m of model.modules) out.modules[m.id] = P.moduleOn(model, sel, m) ? 'on' : 'off';
  for (const id of model.order) out.items[id] = st.get(id).on ? 'on' : 'off';
  return { selection: out };
}

// Back to path A: the preset selection wins; `dropped` counts the custom toggles that
// differ from it (the one-line confirm names this number).
function switchBackToPreset(model, customSel, presetSel) {
  const a = P.effectiveState(model, customSel);
  const b = P.effectiveState(model, presetSel);
  const dropped = model.order.filter((id) => a.get(id).on !== b.get(id).on).length;
  return { selection: P.normaliseSelection(JSON.parse(JSON.stringify(presetSel)), model), dropped };
}

function hasOverrides(dataDir) {
  const d = path.join(P.profileStateDir(dataDir), 'overrides');
  const walk = (x) => { let e = []; try { e = fs.readdirSync(x, { withFileTypes: true }); } catch (err) { return false; } return e.some((y) => (y.isDirectory() ? walk(path.join(x, y.name)) : /\.(md|txt|sh|js|py|ps1|json|xml|yml|yaml|toml)$|^[^.]+$/.test(y.name) && !/\.(new|pre-update-.*)$/.test(y.name))); };
  return walk(d);
}

// Untouched preset: path A, a preset, no module / item toggles (needs-off items aside), no overrides.
function isUntouchedPreset(sel, dataDir) {
  if (!sel || sel.path !== 'preset' || !sel.preset) return false;
  if (Object.keys(sel.modules || {}).length) return false;
  const needsOff = new Set(sel.needs_off || []);
  if (Object.keys(sel.items || {}).some((id) => !(needsOff.has(id) && sel.items[id] === 'off'))) return false;
  return !(dataDir && hasOverrides(dataDir));
}

function templateShas(model, id) {
  const e = model.items.get(id);
  if (!e) return {};
  const out = {};
  for (const c of e.item.contributes || []) {
    if (typeof c.template !== 'string') continue;
    try { out[c.template] = sha(fs.readFileSync(path.join(model.dir, 'modules', e.module.id, ...c.template.split('/')))); } catch (err) { out[c.template] = null; }
  }
  return out;
}

// Per item between two profile versions under one preset (or the module defaults when
// name is null): added | removed | changed-default | changed-template.
function presetDiff(oldModel, newModel, name) {
  const sel = name ? { preset: name, path: 'preset' } : {};
  const so = P.effectiveState(oldModel, sel);
  const sn = P.effectiveState(newModel, sel);
  const rows = [];
  for (const id of newModel.order) {
    if (!oldModel.items.has(id)) { rows.push({ item: id, change: 'added', state: sn.get(id).on ? 'on' : 'off' }); continue; }
    if (so.get(id).on !== sn.get(id).on) rows.push({ item: id, change: 'changed-default', from: so.get(id).on ? 'on' : 'off', to: sn.get(id).on ? 'on' : 'off' });
    const a = templateShas(oldModel, id);
    const b = templateShas(newModel, id);
    const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((t) => a[t] !== b[t]);
    if (changed.length) rows.push({ item: id, change: 'changed-template', templates: changed });
  }
  for (const id of oldModel.order) if (!newModel.items.has(id)) rows.push({ item: id, change: 'removed' });
  return rows;
}

// 3-way merge of item states. base = old preset, theirs = new preset, mine = the user's
// selection (old profile). Mine wins; a change on both sides that differs is a conflict
// (mine kept, listed). New items take theirs; removed items drop out.
function mergeSelection(oldModel, newModel, presetName, mine) {
  mine = P.normaliseSelection(mine, oldModel);
  const base = P.effectiveState(oldModel, { preset: presetName, path: 'preset' });
  const theirs = P.effectiveState(newModel, { preset: presetName, path: 'preset' });
  const cur = P.effectiveState(oldModel, mine);
  const out = P.emptySelection(newModel);
  out.path = 'custom';
  out.from_preset = presetName;
  out.variables = Object.assign({}, mine.variables);
  out.review_ack = mine.review_ack || null;
  const conflicts = [];
  const taken = [];
  for (const id of newModel.order) {
    const t = theirs.get(id).on;
    if (!oldModel.items.has(id)) { out.items[id] = t ? 'on' : 'off'; taken.push(id); continue; }
    const b = base.get(id).on;
    const m = cur.get(id).on;
    let v;
    if (m === b) { v = t; if (t !== b) taken.push(id); }
    else if (t === b || t === m) v = m;
    else { v = m; conflicts.push({ item: id, mine: m ? 'on' : 'off', theirs: t ? 'on' : 'off' }); }
    out.items[id] = v ? 'on' : 'off';
  }
  // With on/off states a both-sides toggle change always agrees, so the toggle conflicts
  // left are items the user has on that the new profile removed.
  for (const id of oldModel.order) {
    if (newModel.items.has(id) || !cur.get(id).on) continue;
    conflicts.push({ item: id, mine: 'on', theirs: 'removed', note: 'removed upstream; its applied files stay until you uninstall it' });
  }
  return { selection: out, conflicts, taken };
}

// 3-way merge of template overrides: local = the override, base = the old shipped
// template, new = the new shipped template. Clean = the merged text replaces the override
// (the old one kept as <override>.pre-update-<stamp>); conflict = override kept, the
// conflict text written to <override>.new, listed. o: {git, now}
function mergeOverrides(oldModel, newModel, dataDir, o) {
  o = o || {};
  const root = path.join(P.profileStateDir(dataDir), 'overrides');
  const rows = [];
  const walk = (d, rel) => { let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { return []; } return e.flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name), rel + x.name + '/') : [rel + x.name])); };
  for (const rel of walk(root, '')) {
    if (/\.new$|\.pre-update-/.test(rel) || /\.\d+\.tmp$/.test(rel)) continue;
    const [mod, ...rest] = rel.split('/');
    const template = rest.join('/');
    const ov = path.join(root, ...rel.split('/'));
    const oldT = path.join(oldModel.dir, 'modules', mod, ...template.split('/'));
    const newT = path.join(newModel.dir, 'modules', mod, ...template.split('/'));
    if (!exists(newT)) { rows.push({ module: mod, template, result: 'flagged', note: 'template removed upstream; override kept' }); continue; }
    if (!exists(oldT)) { rows.push({ module: mod, template, result: 'kept', note: 'no old base; override kept' }); continue; }
    const a = fs.readFileSync(oldT);
    const b = fs.readFileSync(newT);
    if (Buffer.compare(a, b) === 0) { rows.push({ module: mod, template, result: 'kept' }); continue; }
    const m = mergeFile(ov, oldT, newT, { git: o.git });
    if (m.status === 'clean') {
      fs.copyFileSync(ov, ov + '.pre-update-' + stamp(o.now));
      fs.writeFileSync(ov, m.text);
      rows.push({ module: mod, template, result: 'merged' });
    } else {
      if (m.text) fs.writeFileSync(ov + '.new', m.text); else fs.copyFileSync(newT, ov + '.new');
      rows.push({ module: mod, template, result: 'conflict', side: rel + '.new' });
    }
  }
  return rows;
}

// What an update offers this user. Returns {mode: 'preset'|'merge'|'custom', ...}.
function updateOffer(oldModel, newModel, sel, dataDir) {
  sel = P.normaliseSelection(sel, oldModel);
  const name = sel.preset || sel.from_preset;
  if (sel.path === 'preset' && name && isUntouchedPreset(sel, dataDir)) {
    const diff = presetDiff(oldModel, newModel, name);
    const next = presetSelection(newModel, name, { values: sel.variables, skipped: [] });
    if (next.ok) for (const id of sel.needs_off || []) if (newModel.items.has(id)) next.selection.items[id] = 'off';
    return { mode: 'preset', preset: name, diff, selection: next.ok ? next.selection : null,
      line: 'Update to the latest ' + name + ' settings: ' + diff.length + ' change(s)' };
  }
  if (name && newModel.presets[name]) {
    const m = mergeSelection(oldModel, newModel, name, sel);
    return { mode: 'merge', preset: name, selection: m.selection, conflicts: m.conflicts, taken: m.taken,
      line: 'Customised ' + name + ' setup: ' + m.taken.length + ' upstream change(s) merged, ' + m.conflicts.length + ' conflict(s) to decide' };
  }
  const added = newModel.order.filter((id) => !oldModel.items.has(id));
  return { mode: 'custom', newItems: added, line: added.length + ' new item(s) available' };
}

module.exports = { inputsOf, presetSelection, switchToCustom, switchBackToPreset, isUntouchedPreset, presetDiff, mergeSelection, mergeOverrides, updateOffer, hasOverrides };
