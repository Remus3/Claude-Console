'use strict';
// INTEGRATE-2 (CON-013 b): the L1 content -> L3 engine interfaces, planned with the REAL
// shipped profile (console/profile) into a temp repo and config dir. Dry runs only.
//   1. object variables render as JSON ({budgets} in doc-budgets.json);
//   2. {project_slug} is detected from the target repo (Claude's projects/<slug> folder);
//   3. the <!-- profile:begin X --> regions of the shipped done.md are insertion points
//      (contributions land inside them, in place, with no second region);
//   4. {python} in the tracked repo .claude/settings.json is a bare name, never a path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const P = require('../installer/profile');
const PL = require('../installer/profile-plan');

const PROFILE = path.join(__dirname, '..', 'profile');
const FAKE_PY = 'C:/Tools/Py314/python.exe';
const FAKE_NODE = 'C:/Tools/node24/node.exe';

function world() {
  const root = tmpdir('prof-ifc-');
  const repo = path.join(root, 'demo-repo');
  const cfg = path.join(root, 'cfg');
  const data = path.join(root, 'data');
  for (const d of [repo, cfg, data]) fs.mkdirSync(d, { recursive: true });
  const model = P.loadProfile(PROFILE);
  assert.ok(model.ok, JSON.stringify(model.errors));
  return { root, repo, cfg, data, model };
}

function itemsWhere(model, pred) {
  const out = [];
  for (const [id, e] of model.items) for (const c of e.item.contributes || []) if (pred(c, e)) { out.push(id); break; }
  return out;
}

function planWith(w, ids) {
  const r = P.enable(w.model, P.emptySelection(w.model), ids);
  assert.ok(r.ok, r.reason);
  const detect = (name) => (name === 'python' ? FAKE_PY : name === 'node' ? FAKE_NODE : null);
  return PL.plan({ model: w.model, selection: r.selection, dataDir: w.data, target: { repo: w.repo, configDir: w.cfg },
    values: { repo_code: 'DM', operator_ident: 'Sam Example <sam@example.com>' }, ctx: { detect }, platform: 'win32' });
}

const fileOf = (p, display) => p.files.find((f) => f.display === display);
const textOf = (f) => (f && f.after ? f.after.toString('utf8') : null);

test('object variables render as JSON: {budgets} becomes the budgets object, not [object Object]', () => {
  const w = world();
  const ids = itemsWhere(w.model, (c) => c.template === 'templates/doc-budgets.json');
  assert.ok(ids.length > 0, 'an item ships doc-budgets.json');
  const p = planWith(w, ids);
  const f = p.files.find((x) => /doc-budgets\.json$/.test(x.rel));
  assert.ok(f, JSON.stringify(p.rows.filter((r) => ids.includes(r.item))));
  const t = textOf(f);
  assert.ok(!/\[object Object\]/.test(t));
  const j = JSON.parse(t);
  assert.strictEqual(typeof j.budgets, 'object');
  assert.strictEqual(j.budgets.handoff_kb, 30);
  assert.strictEqual(j.budgets.handoff_warn_pct, 90);
  // the resolver itself: an object value is JSON text
  const vr = P.resolveVariables(w.model, {}, { repoRoot: w.repo, configDir: w.cfg });
  assert.deepStrictEqual(JSON.parse(vr.vars.budgets), w.model.profile.variables.budgets.default);
});

test('project_slug is detected from the target repo: projects/<slug>/memory lands under the config dir', () => {
  const w = world();
  const expect = path.resolve(w.repo).replace(/[^A-Za-z0-9]/g, '-');
  assert.strictEqual(P.projectSlug(w.repo), expect);
  assert.strictEqual(P.projectSlug('C:\\Work\\app'), 'C--Work-app');
  const vr = P.resolveVariables(w.model, {}, { repoRoot: w.repo, configDir: w.cfg });
  assert.strictEqual(vr.vars.project_slug, expect);
  // a typed value wins over detection
  assert.strictEqual(P.resolveVariables(w.model, { project_slug: 'typed-slug' }, { repoRoot: w.repo }).vars.project_slug, 'typed-slug');
  const ids = itemsWhere(w.model, (c) => /\{project_slug\}/.test(String(c.target || '')));
  assert.ok(ids.length > 0);
  const p = planWith(w, ids);
  const mem = p.files.find((f) => f.rel === 'projects/' + expect + '/memory/MEMORY.md' && f.side === 'user');
  assert.ok(mem, JSON.stringify(p.rows.filter((r) => ids.includes(r.item))));
  assert.ok(!p.missing.some((m) => m.name === 'project_slug'), 'never asked for: it is detected');
});

test('done.md profile:begin regions are insertion points: contributions fill them in place, no second region', () => {
  const w = world();
  const shipped = fs.readFileSync(path.join(PROFILE, 'modules', 'session', 'templates', 'commands', 'done.md'), 'utf8');
  const regions = [...shipped.matchAll(/^<!-- profile:begin ([a-z0-9-]+) -->$/gm)].map((m) => m[1]);
  assert.ok(regions.length >= 5);
  const fileItem = itemsWhere(w.model, (c) => c.kind === 'file' && c.target === 'repo:.claude/commands/done.md');
  const blockItems = itemsWhere(w.model, (c) => c.kind === 'block' && c.target === 'repo:.claude/commands/done.md');
  assert.strictEqual(fileItem.length, 1);
  assert.ok(blockItems.length >= 3);
  const p = planWith(w, fileItem.concat(blockItems));
  const t = textOf(fileOf(p, 'repo:.claude/commands/done.md'));
  assert.ok(t, 'done.md is planned');
  for (const name of regions) {
    const begins = t.split('\n').filter((l) => l === '<!-- profile:begin ' + name + ' -->').length;
    assert.strictEqual(begins, 1, 'exactly one region ' + name);
  }
  // the regions keep their place: same order as shipped, the headings between them unchanged
  const order = [...t.matchAll(/^<!-- profile:begin ([a-z0-9-]+) -->$/gm)].map((m) => m[1]);
  assert.deepStrictEqual(order, regions);
  assert.ok(t.indexOf('## 0. Pre-flight') < t.indexOf('<!-- profile:begin done-halt -->'));
  assert.ok(t.indexOf('<!-- profile:begin done-marker -->') < t.indexOf('## Last. The only chat output'));
  // at least one region is filled, and the text sits between its own markers
  const filled = regions.filter((n) => {
    const a = t.indexOf('<!-- profile:begin ' + n + ' -->\n');
    const b = t.indexOf('<!-- profile:end ' + n + ' -->');
    return b - a > ('<!-- profile:begin ' + n + ' -->\n').length;
  });
  assert.ok(filled.length >= 3, 'filled: ' + filled.join(','));
});

test('{python} in the tracked repo .claude/settings.json resolves to a bare name, never the detected machine path', () => {
  const w = world();
  const ids = itemsWhere(w.model, (c) => c.kind === 'json-merge' && c.target === 'repo:.claude/settings.json' && /\{python\}/.test(JSON.stringify(c.value || '')));
  assert.ok(ids.length > 0, 'an item puts a {python} hook into the repo settings');
  const p = planWith(w, ids);
  const t = textOf(fileOf(p, 'repo:.claude/settings.json'));
  assert.ok(t, JSON.stringify(p.rows.filter((r) => ids.includes(r.item))));
  assert.ok(!t.includes(FAKE_PY) && !/Tools|Py314|[A-Za-z]:[\\/]/.test(t), 'no machine path in a tracked file: ' + t);
  const cmds = [];
  const walk = (o) => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (typeof o.command === 'string') cmds.push(o.command); Object.values(o).forEach(walk); } };
  walk(JSON.parse(t));
  assert.ok(cmds.some((c) => c.startsWith('"python" ')), cmds.join('\n'));
  // trackedVars: exe variables only, bare names
  const tv = P.trackedVars(w.model, { python: FAKE_PY, node: FAKE_NODE, repo_code: 'DM' });
  assert.deepStrictEqual([tv.python, tv.node, tv.repo_code], [P.BARE_EXE.python, 'node', 'DM']);
});
