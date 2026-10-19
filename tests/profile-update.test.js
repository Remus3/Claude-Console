'use strict';
// CON-013 L3 (addendum f): the two setup paths (preset path A, custom path B), switching
// between them, and the update behaviour (untouched preset -> diff; customised -> 3-way
// merge of toggles and template overrides; path B -> new items count).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const P = require('../installer/profile');
const PU = require('../installer/profile-update');
const PL = require('../installer/profile-plan');
const TX = require('../installer/profile-tx');
const cli = require('../installer/cli');

const MIN = path.join(__dirname, 'fixtures', 'profile-min');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}
const item = (id, order, extra) => Object.assign({ id, order, title: 'Item ' + id, does: 'Does ' + id + '.', why: 'Because ' + id + '.',
  risk: 'low', default: 'on', platform: ['win32', 'darwin', 'linux'], depends_on: [], pairs_with: [], conflicts_with: [], contributes: [] }, extra);

// v1: the L0 fixture + module "extras" (3 items) + a generated preset with an item map.
function profileV1(root) {
  const dir = path.join(root, 'v1');
  copyDir(MIN, dir);
  const pj = JSON.parse(r(path.join(dir, 'profile.json')));
  pj.modules.push('extras');
  w(path.join(dir, 'profile.json'), JSON.stringify(pj, null, 2) + '\n');
  const mod = { schema: 1, id: 'extras', order: 3, title: 'Extras', summary: 'Update test items.', why: 'They change between versions.', default: 'on', items: [
    item('x-one', 301, { contributes: [{ kind: 'file', target: 'repo:one.md', template: 'templates/one.md', mode: 'managed' }] }),
    item('x-two', 302, { contributes: [{ kind: 'file', target: 'repo:two.md', template: 'templates/two.md', mode: 'managed' }] }),
    item('x-three', 303, { default: 'off', contributes: [{ kind: 'file', target: 'repo:three.md', template: 'templates/three.md', mode: 'managed' }] }),
  ] };
  w(path.join(dir, 'modules', 'extras', 'module.json'), JSON.stringify(mod, null, 2) + '\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'one.md'), 'line a\nline b\nline c\nline d\nline e\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'two.md'), 'two first\ntwo second\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'three.md'), 'three\n');
  w(path.join(dir, 'presets', 'author.json'), JSON.stringify({ schema: 1, preset: 'author', version: '1.0.0', modules: '*', generated_from: 'abc1234', source_sha: 'f'.repeat(64),
    items: { 'conv-session-env': 'on', 'x-three': 'off' }, variables: { repo_code: 'SA' } }, null, 2) + '\n');
  return dir;
}

// v2 changes 3 items: x-three default on in the preset, one.md's last line changed
// upstream, a new item x-four.
function profileV2(root) {
  const dir = path.join(root, 'v2');
  copyDir(path.join(root, 'v1'), dir);
  const pj = JSON.parse(r(path.join(dir, 'profile.json')));
  pj.version = '1.1.0';
  w(path.join(dir, 'profile.json'), JSON.stringify(pj, null, 2) + '\n');
  const mf = path.join(dir, 'modules', 'extras', 'module.json');
  const mod = JSON.parse(r(mf));
  mod.items.push(item('x-four', 304, { contributes: [{ kind: 'file', target: 'repo:four.md', template: 'templates/four.md', mode: 'managed' }] }));
  w(mf, JSON.stringify(mod, null, 2) + '\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'four.md'), 'four\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'one.md'), 'line a\nline b\nline c\nline d\nline E upstream\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'two.md'), 'two first upstream\ntwo second\n');
  const pf = path.join(dir, 'presets', 'author.json');
  const pr = JSON.parse(r(pf));
  pr.version = '1.1.0';
  pr.items['x-three'] = 'on';
  w(pf, JSON.stringify(pr, null, 2) + '\n');
  return dir;
}

function setup() {
  const root = tmpdir('cc-upd-');
  const v1 = P.loadProfile(profileV1(root));
  const v2 = P.loadProfile(profileV2(root));
  assert.ok(v1.ok, JSON.stringify(v1.errors));
  assert.ok(v2.ok, JSON.stringify(v2.errors));
  return { root, v1, v2, dataDir: path.join(root, 'data') };
}

test('presets load from profile.json and presets/<name>.json (item map + variables)', () => {
  const { v1 } = setup();
  assert.deepStrictEqual(Object.keys(v1.presets).sort(), ['author', 'full', 'minimal', 'recommended']);
  const st = P.effectiveState(v1, { preset: 'author', path: 'preset' });
  assert.strictEqual(st.get('conv-session-env').on, true, 'item map wins over the module default');
  assert.strictEqual(st.get('x-three').on, false);
  assert.strictEqual(st.get('x-one').on, true);
});

test('path A: a skipped input turns off what needs it and its dependants, named', () => {
  const { v1 } = setup();
  const ps = PU.presetSelection(v1, 'author', { skipped: ['repo_code'] });
  assert.ok(ps.ok);
  assert.deepStrictEqual(ps.offNeeds.map((x) => x.item), ['conv-handoff-file', 'conv-session-env']);
  assert.deepStrictEqual(ps.offNeeds[0].needs, ['repo_code']);
  assert.match(ps.offNeeds[1].needs[0], /depends on conv-handoff-file/);
  const on = P.onIds(v1, ps.selection);
  assert.ok(on.includes('floor-no-ai-attribution'), 'locked floors stay on');
  assert.ok(!on.includes('conv-handoff-file'));
  assert.strictEqual(ps.selection.variables.repo_code, 'SA', 'preset values carried');
  assert.ok(PU.isUntouchedPreset(ps.selection), 'needs-off items do not count as customising');
  assert.ok(PU.inputsOf(v1, 'conv-handoff-file').includes('repo_code'));
  assert.strictEqual(PU.presetSelection(v1, 'nope').ok, false);
});

test('switch to custom is pre-filled from the preset; back to the preset drops N toggles', () => {
  const { v1 } = setup();
  const pre = PU.presetSelection(v1, 'author', {}).selection;
  const custom = PU.switchToCustom(v1, pre).selection;
  assert.strictEqual(custom.path, 'custom');
  assert.strictEqual(custom.from_preset, 'author');
  assert.deepStrictEqual(P.onIds(v1, custom), P.onIds(v1, pre));
  let c2 = P.disable(v1, custom, ['x-one']).selection;
  c2 = P.disable(v1, c2, ['x-two']).selection;
  const back = PU.switchBackToPreset(v1, c2, pre);
  assert.strictEqual(back.dropped, 2);
  assert.deepStrictEqual(P.onIds(v1, back.selection), P.onIds(v1, pre));
  assert.ok(!PU.isUntouchedPreset(c2));
});

test('presetDiff names every upstream change (default, template, added)', () => {
  const { v1, v2 } = setup();
  const d = PU.presetDiff(v1, v2, 'author');
  assert.deepStrictEqual(d.map((x) => x.item + ' ' + x.change).sort(), ['x-four added', 'x-one changed-template', 'x-three changed-default', 'x-two changed-template'].sort());
});

test('update: an untouched preset user gets the diff and the new preset', () => {
  const { v1, v2, dataDir } = setup();
  const sel = PU.presetSelection(v1, 'author', {}).selection;
  const offer = PU.updateOffer(v1, v2, sel, dataDir);
  assert.strictEqual(offer.mode, 'preset');
  assert.strictEqual(offer.diff.length, 4);
  assert.ok(P.onIds(v2, offer.selection).includes('x-three'));
  assert.match(offer.line, /latest author settings: 4 change/);
});

test('update: a customised user gets the 3-way merge; their toggles and overrides win, conflicts listed', async () => {
  const { v1, v2, dataDir } = setup();
  let sel = PU.switchToCustom(v1, PU.presetSelection(v1, 'author', {}).selection).selection;
  sel = P.disable(v1, sel, ['x-one']).selection; // mine: off (preset on, upstream unchanged on)
  P.writeSelection(dataDir, sel);
  // Two overrides: one.md edits line b (upstream changed line e: clean merge); two.md
  // edits line 1 (upstream changed line 1 too: conflict).
  assert.ok((await P.editTemplate(v1, dataDir, 'x-one', { text: 'line a\nline B mine\nline c\nline d\nline e\n' })).ok);
  assert.ok((await P.editTemplate(v1, dataDir, 'x-two', { text: 'two first mine\ntwo second\n' })).ok);
  assert.ok(!PU.isUntouchedPreset(sel, dataDir));
  const offer = PU.updateOffer(v1, v2, sel, dataDir);
  assert.strictEqual(offer.mode, 'merge');
  const st = P.effectiveState(v2, offer.selection);
  assert.strictEqual(st.get('x-one').on, false, 'my toggle kept');
  assert.strictEqual(st.get('x-three').on, true, 'upstream change taken where I did not touch it');
  assert.strictEqual(st.get('x-four').on, true, 'new item takes the new preset');
  const rows = PU.mergeOverrides(v1, v2, dataDir, {});
  const by = Object.fromEntries(rows.map((x) => [x.template + '@' + x.module, x]));
  assert.strictEqual(by['templates/one.md@extras'].result, 'merged');
  const ov1 = P.overridePath(dataDir, 'extras', 'templates/one.md');
  assert.strictEqual(r(ov1), 'line a\nline B mine\nline c\nline d\nline E upstream\n');
  assert.strictEqual(by['templates/two.md@extras'].result, 'conflict');
  const ov2 = P.overridePath(dataDir, 'extras', 'templates/two.md');
  assert.strictEqual(r(ov2), 'two first mine\ntwo second\n', 'conflicting override kept as it was');
  assert.match(r(ov2 + '.new'), /<<<<<<<[\s\S]*two first mine[\s\S]*two first upstream/);
});

test('update: path B users only see the new items count', () => {
  const { v1, v2, dataDir } = setup();
  const offer = PU.updateOffer(v1, v2, P.enable(v1, {}, ['x-three']).selection, dataDir);
  assert.strictEqual(offer.mode, 'custom');
  assert.deepStrictEqual(offer.newItems, ['x-four']);
  assert.strictEqual(offer.line, '1 new item(s) available');
});

test('path A apply goes through the normal transaction with the grouped consent', async () => {
  const { root, v1, dataDir } = setup();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = new Map();
  const deps = { git: { get: (rr, k) => (git.has(k) ? git.get(k) : null), set: (rr, k, v) => git.set(k, v), unset: (rr, k) => git.delete(k) },
    env: { m: new Map(), get(n) { return this.m.has(n) ? { present: true, sha256: require('crypto').createHash('sha256').update(this.m.get(n)).digest('hex') } : { present: false }; }, set(n, v) { this.m.set(n, v.value); }, unset(n) { this.m.delete(n); }, snapshot(n) { return this.m.has(n) ? { token: this.m.get(n) } : { absent: true }; }, restore(n, s) { if (s.absent) this.m.delete(n); else this.m.set(n, s.token); } },
    recycle: async (p) => { fs.renameSync(p, p + '.recycled-test'); } };
  const sel = PU.presetSelection(v1, 'author', { values: { python: 'py' } }).selection;
  const plan = PL.plan({ model: v1, selection: sel, dataDir, target: { repo }, deps });
  assert.ok(plan.highRisk.includes('conv-session-env'));
  const res = await TX.applyPlan(plan, { model: v1, dataDir, deps, confirm: true, groupedConsent: true, selection: sel });
  assert.ok(res.ok, res.line);
  assert.strictEqual(r(path.join(repo, 'SA-NEXT-SESSION.txt')).split('\n')[0], 'SESSION: 1');
  assert.strictEqual(P.readSelection(dataDir, v1).preset, 'author');
});

test('cli: profile apply --preset with a skipped input shows the off-needs lines (dry run)', async () => {
  const { root } = setup();
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const lines = [];
  const code = await cli.run(['profile', 'apply', '--preset', 'author', '--skip', 'repo_code', '--target', 'repo:' + repo, '--var', 'python=py', '--home', path.join(root, 'home')],
    { out: (s) => lines.push(s), profileDir: path.join(root, 'v1'), dataDir: path.join(root, 'data'), configDir: path.join(root, 'cfg'), noDefaultAdapters: true, git: { get: () => null, set() {}, unset() {} } });
  assert.strictEqual(code, 0, lines.join('\n'));
  assert.ok(lines.includes('off - needs repo_code: conv-handoff-file'), lines.join('\n'));
  assert.deepStrictEqual(fs.readdirSync(repo), []);
});

// 013-VERIFY sandbox F: the shipped remus3 preset records variables as {value} / {ask};
// only the values become selection variables, and a CLI --skip of task:NAME / env:NAME
// turns those items off like the wizard's skip op.
test('shipped remus3 preset: {value}/{ask} variables normalised; --skip task:/env: keys turn items off', () => {
  const root = tmpdir('cc-preset-');
  const eng = P.openEngine({ profileDir: path.join(__dirname, '..', 'profile'), dataDir: path.join(root, 'data'), configDir: path.join(root, 'cfg'), deps: {} });
  assert.ok(eng.model.ok);
  const ps = PU.presetSelection(eng.model, 'remus3', {});
  assert.strictEqual(ps.selection.variables.suite_slots, 2);
  assert.strictEqual(ps.selection.variables.headless_base_url, undefined, 'an {ask} entry is not a value');
  assert.ok(Object.values(ps.selection.variables).every((v) => v === null || typeof v !== 'object' || Array.isArray(v) || !('ask' in v || 'value' in v)));
  const sk = PU.presetSelection(eng.model, 'remus3', { skipped: ['task:ClaudeProfile-TempHygiene', 'env:CLAUDE_HEADLESS_BASE_URL'] });
  assert.strictEqual(sk.selection.items['sched-temp-hygiene'], 'off');
  assert.strictEqual(sk.selection.items['hl-env-base-url'], 'off');
  assert.ok(sk.offNeeds.some((x) => x.item === 'sched-temp-hygiene' && x.needs.includes('task:ClaudeProfile-TempHygiene')));
});
