'use strict';
// CON-013 L3: setup profile engine (load, selection, plan, apply, revert, uninstall,
// verify, edit) and the `claude-console profile` CLI. Every OS effect is a fake: the env,
// task and git adapters are in-memory, the Recycle Bin is a scratch folder. Never the
// real ~/.claude*, registry or scheduler.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpdir } = require('./helpers');
const P = require('../installer/profile');
const PL = require('../installer/profile-plan');
const TX = require('../installer/profile-tx');
const PV = require('../installer/profile-verify');
const cli = require('../installer/cli');

const MIN = path.join(__dirname, 'fixtures', 'profile-min');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Hash of every file under the given roots (path + bytes); `skip` prunes rel paths.
function treeHash(roots, skip) {
  const h = crypto.createHash('sha256');
  for (const root of roots) {
    const rec = (d, rel) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1)); } catch (e) { return; }
      for (const e of ents) {
        const rr = rel ? rel + '/' + e.name : e.name;
        if (skip && skip(rr)) continue;
        if (e.isDirectory()) { h.update('D ' + rr + '\n'); rec(path.join(d, e.name), rr); }
        else { h.update('F ' + rr + '\n'); h.update(fs.readFileSync(path.join(d, e.name))); }
      }
    };
    h.update('R ' + path.basename(root) + '\n');
    rec(root, '');
  }
  return h.digest('hex');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}

// The L0 fixture plus a third module exercising block slots, json-merge, kit and task.
function richProfile() {
  const dir = path.join(tmpdir('cc-prof-'), 'profile');
  copyDir(MIN, dir);
  const pj = JSON.parse(r(path.join(dir, 'profile.json')));
  pj.modules.push('extras');
  pj.presets.recommended = ['floors', 'session', 'extras'];
  w(path.join(dir, 'profile.json'), JSON.stringify(pj, null, 2) + '\n');
  const item = (id, order, extra) => Object.assign({ id, order, title: 'Item ' + id, does: 'Does ' + id + '.', why: 'Because ' + id + '.',
    risk: 'low', default: 'on', platform: ['win32', 'darwin', 'linux'], depends_on: [], pairs_with: [], conflicts_with: [], contributes: [] }, extra);
  const mod = {
    schema: 1, id: 'extras', order: 3, title: 'Extras', summary: 'Engine test items.', why: 'They cover every kind.', default: 'on',
    items: [
      item('rule-quiet', 301, { contributes: [{ kind: 'block', target: 'repo:CLAUDE.md', block: 'rules', slot: 2, template: 'templates/rule-quiet.md' }] }),
      item('set-hooks', 302, { contributes: [{ kind: 'json-merge', target: 'repo:.claude/settings.json', mode: 'add',
        value: { env: { PYTHONUTF8: '1' }, permissions: { allow: ['Bash(git status)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node {kit_dir}/kit_done.js stop-hook' }] }] } } }],
        verify: [{ 'json-parse': 'repo:.claude/settings.json' }] }),
      item('kit-done', 303, { contributes: [{ kind: 'kit', files: ['kit_done.js'] }] }),
      item('user-cmd', 304, { contributes: [{ kind: 'file', target: 'user:commands/hello.md', template: 'templates/hello.md', mode: 'managed' }] }),
      item('task-x', 305, { risk: 'high', default: 'off', platform: ['win32'], contributes: [{ kind: 'task', name: 'ClaudeProfile-Test', template: 'templates/task.xml' }], verify: [{ 'task-readback': 'ClaudeProfile-Test' }] }),
    ],
  };
  w(path.join(dir, 'modules', 'extras', 'module.json'), JSON.stringify(mod, null, 2) + '\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'rule-quiet.md'), '2. QUIET: results only.\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'hello.md'), 'Say hello from {repo_code}.\n');
  w(path.join(dir, 'modules', 'extras', 'templates', 'task.xml'), '<Task><Exec>{python}</Exec></Task>\n');
  w(path.join(dir, 'kit', 'kit_done.js'), '// kit done\n');
  return dir;
}

function fakeEnv() {
  const m = new Map();
  return {
    m,
    get: (n) => (m.has(n) ? { present: true, sha256: sha(Buffer.from(m.get(n))) } : { present: false }),
    set: (n, v) => { m.set(n, v.value !== undefined ? v.value : 'ref:' + v.secret); },
    unset: (n) => { m.delete(n); },
    snapshot: (n) => (m.has(n) ? { token: Buffer.from(m.get(n)).toString('base64') } : { absent: true }),
    restore: (n, s) => { if (s.absent) m.delete(n); else m.set(n, Buffer.from(s.token, 'base64').toString()); },
  };
}
function fakeTasks() {
  const m = new Map();
  return { m, get: (n) => (m.has(n) ? { present: true, enabled: m.get(n).enabled, xml: m.get(n).xml } : { present: false }),
    exportXml: (n) => (m.has(n) ? m.get(n).xml : null), register: (n, xml) => m.set(n, { xml, enabled: true }), remove: (n) => m.delete(n),
    setEnabled: (n, on) => { if (m.has(n)) m.get(n).enabled = on; } };
}
function fakeGit() {
  const m = new Map();
  return { m, get: (repo, k) => (m.has(repo + '|' + k) ? m.get(repo + '|' + k) : null), set: (repo, k, v) => m.set(repo + '|' + k, v), unset: (repo, k) => m.delete(repo + '|' + k) };
}

function env(profileDir) {
  const root = tmpdir('cc-eng-');
  const repo = path.join(root, 'repo');
  const configDir = path.join(root, 'config');
  const dataDir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  let n = 0;
  const recycle = async (p) => { fs.renameSync(p, path.join(bin, (n++) + '-' + path.basename(p))); return true; };
  const deps = { env: fakeEnv(), tasks: fakeTasks(), git: fakeGit(), recycle };
  const model = P.loadProfile(profileDir || MIN);
  assert.ok(model.ok, JSON.stringify(model.errors));
  return { root, repo, configDir, dataDir, bin, deps, model, target: { repo, configDir }, values: { repo_code: 'AB', python: 'python' } };
}

const planOf = (e, extra) => PL.plan(Object.assign({ model: e.model, selection: P.readSelection(e.dataDir, e.model), dataDir: e.dataDir, target: e.target, values: e.values, deps: e.deps }, extra || {}));
const stateHash = (e) => treeHash([e.repo, e.configDir, e.dataDir], (rel) => rel === 'profile' ? false : rel.startsWith('profile/tx'));

// ------------------------------------------------------------------ load + selection

test('load: the L0 fixture validates; defaults: locked floors on, session env off', () => {
  const e = env();
  assert.deepStrictEqual(e.model.order, ['floor-no-ai-attribution', 'conv-handoff-file', 'conv-session-env']);
  const st = P.effectiveState(e.model, {});
  assert.deepStrictEqual([...st].map(([id, s]) => [id, s.on, s.why]), [['floor-no-ai-attribution', true, 'locked'], ['conv-handoff-file', true, 'module'], ['conv-session-env', false, 'module']]);
  assert.deepStrictEqual(Object.keys(e.model.presets).sort(), ['full', 'minimal', 'recommended']);
});

test('enable proposes dependencies; disable takes dependants along; locked refuses', () => {
  const e = env();
  let sel = P.disable(e.model, {}, ['conv-handoff-file']).selection;
  const en = P.enable(e.model, sel, ['conv-session-env']);
  assert.deepStrictEqual(en.added, ['conv-handoff-file'], 'its dependency is turned on and named');
  assert.ok(P.onIds(e.model, en.selection).includes('conv-session-env'));
  const dis = P.disable(e.model, en.selection, ['conv-handoff-file']);
  assert.deepStrictEqual(dis.removed, ['conv-session-env']);
  assert.strictEqual(P.disable(e.model, {}, ['floors']).ok, false);
  assert.match(P.disable(e.model, {}, ['floor-no-ai-attribution']).reason, /locked/);
  assert.strictEqual(P.enable(e.model, {}, ['nope']).ok, false);
});

test('variables: derived, defaults, builtins; a missing one refuses with its wizard step', () => {
  const e = env();
  const vr = P.resolveVariables(e.model, { repo_code: 'AB' }, { builtins: P.builtins({ home: '/h' }) });
  assert.strictEqual(vr.vars.handoff_name, 'AB-NEXT-SESSION.txt');
  assert.strictEqual(vr.vars.kit_dir, 'ops/kit');
  assert.strictEqual(vr.vars.reports_dir, '/h/Documents/Claude Reports');
  assert.deepStrictEqual(P.resolveVariables(e.model, { repo_code: 'lower' }, {}).errors.map((x) => x.name), ['repo_code']);
  const p = planOf(e, { values: { python: 'py' } });
  const v = PL.planVerdict(p);
  assert.strictEqual(v.code, 1);
  assert.match(v.line, /needs \{repo_code\} \(asked at wizard\.step\.repo\)/);
});

// ------------------------------------------------------------------ plan

test('plan: statuses on an empty repo; a dry run writes nothing', async () => {
  const e = env();
  const before = stateHash(e);
  const p = planOf(e);
  const st = Object.fromEntries(p.rows.map((x) => [x.item + ' ' + x.kind + ' ' + x.target, x.status]));
  assert.strictEqual(st['floor-no-ai-attribution git core.hooksPath'], 'new');
  assert.strictEqual(st['floor-no-ai-attribution file repo:.githooks/commit-msg'], 'new');
  assert.strictEqual(st['conv-handoff-file file repo:AB-NEXT-SESSION.txt'], 'new');
  assert.strictEqual(st['conv-handoff-file block repo:CLAUDE.md#rules'], 'new');
  assert.strictEqual(PL.planVerdict(p).code, 0);
  assert.match(PL.diffText(p), /\+\+\+ b\/repo:AB-NEXT-SESSION\.txt\n@@ -0,0 \+1,3 @@\n\+SESSION: 1/);
  const res = await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps });
  assert.strictEqual(res.applied, false);
  assert.match(res.line, /dry run/);
  assert.strictEqual(stateHash(e), before, 'nothing written without confirm');
  assert.ok(!fs.existsSync(e.dataDir));
});

test('apply writes, reads back and locks; a second plan is all same', async () => {
  const e = env();
  const res = await TX.applyPlan(planOf(e), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true });
  assert.strictEqual(res.ok, true, res.line);
  assert.strictEqual(r(path.join(e.repo, 'AB-NEXT-SESSION.txt')), 'SESSION: 1\n\nNext action: none yet.\n');
  assert.strictEqual(r(path.join(e.repo, 'CLAUDE.md')), '<!-- profile:begin rules -->\n5. HAND-OFF: `AB-NEXT-SESSION.txt` at the repo root is the only continuity. Read it first.\n<!-- profile:end rules -->\n');
  assert.match(r(path.join(e.repo, '.githooks', 'commit-msg')), /exec python ops\/kit\/kit_identity\.py commit-msg/);
  assert.strictEqual(e.deps.git.get(e.repo, 'core.hooksPath'), '.githooks');
  const lock = JSON.parse(r(path.join(e.repo, '.claude', 'profile.lock.json')));
  assert.deepStrictEqual(lock.items, ['floor-no-ai-attribution', 'conv-handoff-file']);
  assert.ok(!JSON.stringify(lock).includes(e.root.replace(/\\/g, '\\\\')), 'the tracked lock holds no machine path');
  assert.ok(!/AB-NEXT|python/.test(JSON.stringify(lock.git)), 'no variable values in the lock git map');
  assert.deepStrictEqual(res.commit.paths.sort(), ['.claude/profile.lock.json', '.githooks/commit-msg', 'AB-NEXT-SESSION.txt', 'CLAUDE.md']);
  assert.ok(!/co-authored|claude/i.test(res.commit.message), 'no AI trailer in the suggested message');
  const again = planOf(e);
  assert.deepStrictEqual([...new Set(again.rows.map((x) => x.status))], ['same']);
  assert.ok(again.files.every((f) => f.status === 'same'));
  const v = PV.verifyItems({ model: e.model, target: e.target, values: e.values, deps: e.deps, dataDir: e.dataDir });
  assert.strictEqual(v.ok, true, JSON.stringify(v.rows));
  assert.strictEqual(PV.verifyLock({ model: e.model, target: e.target, dataDir: e.dataDir }).ok, true);
});

test('round trip: apply then revert is byte-identical to the pre-state (repo, config, selection)', async () => {
  const e = env(richProfile());
  w(path.join(e.repo, 'CLAUDE.md'), '# Repo\nPurpose line.\n\n## Own section\nUser prose stays.\n');
  w(path.join(e.repo, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { KEEP: '1' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'mine' }] }] } }, null, 2));
  w(path.join(e.configDir, 'settings.json'), '{}\n');
  P.writeSelection(e.dataDir, P.enable(e.model, P.readSelection(e.dataDir, e.model), ['conv-session-env', 'task-x']).selection);
  const pre = stateHash(e);
  const p = planOf(e);
  assert.deepStrictEqual(p.highRisk.sort(), ['conv-session-env', 'task-x']);
  assert.match((await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true })).line, /conv-session-env is high risk/);
  assert.match((await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ['conv-session-env', 'task-x'] })).line, /ClaudeProfile-Test needs its own consent/, 'the high-risk ack alone is not the task consent');
  const res = await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ['conv-session-env', 'task-x'], taskConsent: { mode: 'per-task', tasks: { 'ClaudeProfile-Test': true } } });
  assert.strictEqual(res.ok, true, res.line);
  const md = r(path.join(e.repo, 'CLAUDE.md'));
  assert.ok(md.startsWith('# Repo\nPurpose line.\n\n<!-- profile:begin rules -->\n2. QUIET'), md);
  assert.ok(md.includes('5. HAND-OFF') && md.indexOf('2. QUIET') < md.indexOf('5. HAND-OFF'), 'block parts ordered by slot');
  assert.ok(md.endsWith('## Own section\nUser prose stays.\n'), 'prose outside the markers untouched');
  const s = JSON.parse(r(path.join(e.repo, '.claude', 'settings.json')));
  assert.deepStrictEqual(s.env, { KEEP: '1', PYTHONUTF8: '1' });
  assert.deepStrictEqual(s.hooks.Stop[0].hooks.map((h) => h.command), ['mine', 'node ops/kit/kit_done.js stop-hook']);
  assert.strictEqual(r(path.join(e.repo, 'ops', 'kit', 'kit_done.js')), '// kit done\n');
  assert.strictEqual(r(path.join(e.configDir, 'commands', 'hello.md')), 'Say hello from AB.\n');
  assert.strictEqual(e.deps.env.m.get('PYTHONUTF8'), '1');
  assert.ok(e.deps.tasks.m.has('ClaudeProfile-Test'));
  // The env value never reaches the journal or the plan record.
  const txd = path.join(e.dataDir, 'profile', 'tx', res.tx);
  assert.ok(!/PYTHONUTF8[^\n]*"1"/.test(r(path.join(txd, 'journal.jsonl'))));
  const rv = await TX.revertTx(e.dataDir, 'last', { deps: e.deps });
  assert.ok(rv.dryRun, 'revert is a dry run by default');
  const done = await TX.revertTx(e.dataDir, 'last', { deps: e.deps, confirm: true });
  assert.strictEqual(done.ok, true, JSON.stringify(done));
  assert.deepStrictEqual(done.flagged, []);
  assert.strictEqual(stateHash(e), pre, 'byte-identical pre-state');
  assert.ok(!e.deps.env.m.has('PYTHONUTF8') && !e.deps.tasks.m.has('ClaudeProfile-Test') && e.deps.git.m.size === 0);
  assert.ok(fs.readdirSync(e.bin).length >= 4, 'created files went to the Recycle Bin');
  assert.match((await TX.revertTx(e.dataDir, done.tx, { deps: e.deps, confirm: true })).line, /already reverted/);
});

test('an unreadable settings.json is never written', async () => {
  const e = env(richProfile());
  w(path.join(e.repo, '.claude', 'settings.json'), '{ not json');
  const p = planOf(e);
  const row = p.rows.find((x) => x.item === 'set-hooks');
  assert.strictEqual(row.status, 'unreadable');
  assert.strictEqual(PL.planVerdict(p).code, 1);
  const res = await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ['task-x'] });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(r(path.join(e.repo, '.claude', 'settings.json')), '{ not json');
  assert.ok(!fs.existsSync(path.join(e.repo, 'CLAUDE.md')), 'the whole plan is refused');
});

test('conflict: a different managed file needs a decision (exit 2); --replace / --keep decide', async () => {
  const e = env();
  w(path.join(e.repo, '.githooks', 'commit-msg'), '#!/bin/sh\nmine\n');
  const p = planOf(e);
  assert.strictEqual(PL.planVerdict(p).code, 2);
  assert.match(PL.planVerdict(p).line, /--replace floor-no-ai-attribution/);
  const keep = planOf(e, { resolve: { 'floor-no-ai-attribution': 'keep' } });
  assert.strictEqual(PL.planVerdict(keep).code, 0);
  assert.ok((await TX.applyPlan(keep, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true })).ok);
  assert.strictEqual(r(path.join(e.repo, '.githooks', 'commit-msg')), '#!/bin/sh\nmine\n');
  const rep = planOf(e, { resolve: { 'floor-no-ai-attribution': 'replace' } });
  assert.ok((await TX.applyPlan(rep, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true })).ok);
  assert.match(r(path.join(e.repo, '.githooks', 'commit-msg')), /kit_identity/);
});

test('git config already set to another value is a conflict, never overwritten silently', () => {
  const e = env();
  e.deps.git.set(e.repo, 'core.hooksPath', 'hooks');
  assert.strictEqual(planOf(e).rows.find((x) => x.kind === 'git').status, 'conflict');
});

test('uninstall: created files to the Recycle Bin, a user-edited managed file kept and flagged', async () => {
  const e = env(richProfile());
  assert.ok((await TX.applyPlan(planOf(e), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true })).ok);
  w(path.join(e.repo, '.githooks', 'commit-msg'), '#!/bin/sh\nedited by me\n');
  const p = planOf(e, { remove: ['floors', 'extras'] });
  const row = p.rows.find((x) => x.target === 'repo:.githooks/commit-msg');
  assert.strictEqual(row.status, 'skipped');
  assert.match(row.reason, /edited/);
  const res = await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true });
  assert.ok(res.ok, res.line);
  assert.strictEqual(r(path.join(e.repo, '.githooks', 'commit-msg')), '#!/bin/sh\nedited by me\n', 'kept');
  assert.ok(res.flagged.some((f) => /commit-msg: edited/.test(f)));
  assert.ok(!fs.existsSync(path.join(e.repo, 'ops', 'kit', 'kit_done.js')), 'kit file removed');
  assert.ok(!fs.existsSync(path.join(e.repo, '.claude', 'settings.json')), 'settings the profile created and emptied go too');
  assert.strictEqual(r(path.join(e.repo, 'CLAUDE.md')), '<!-- profile:begin rules -->\n5. HAND-OFF: `AB-NEXT-SESSION.txt` at the repo root is the only continuity. Read it first.\n<!-- profile:end rules -->\n', 'only the removed item left the block');
  assert.strictEqual(e.deps.git.get(e.repo, 'core.hooksPath'), null);
  const lock = JSON.parse(r(path.join(e.repo, '.claude', 'profile.lock.json')));
  assert.deepStrictEqual(lock.items, ['conv-handoff-file']);
  // The uninstall is itself a transaction: reverting it brings everything back.
  assert.ok((await TX.revertTx(e.dataDir, 'last', { deps: e.deps, confirm: true })).ok);
  assert.ok(fs.existsSync(path.join(e.repo, 'ops', 'kit', 'kit_done.js')));
  assert.strictEqual(e.deps.git.get(e.repo, 'core.hooksPath'), '.githooks');
});

test('uninstall restores a user JSON key the profile replaced and keeps other user keys', async () => {
  const e = env(richProfile());
  w(path.join(e.repo, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2) + '\n');
  assert.ok((await TX.applyPlan(planOf(e), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true })).ok);
  const s = JSON.parse(r(path.join(e.repo, '.claude', 'settings.json')));
  s.theme = 'dark';
  w(path.join(e.repo, '.claude', 'settings.json'), JSON.stringify(s, null, 2) + '\n');
  assert.ok((await TX.applyPlan(planOf(e, { remove: ['set-hooks'] }), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true })).ok);
  assert.deepStrictEqual(JSON.parse(r(path.join(e.repo, '.claude', 'settings.json'))), { model: 'opus', theme: 'dark' });
});

test('revert of an edited file: key-level for JSON, flag + .profile-removed otherwise', async () => {
  const e = env(richProfile());
  w(path.join(e.repo, '.claude', 'settings.json'), JSON.stringify({ model: 'opus' }, null, 2) + '\n');
  w(path.join(e.repo, '.githooks', 'commit-msg'), '#!/bin/sh\nold\n');
  const p = planOf(e, { resolve: { 'floor-no-ai-attribution': 'replace' } });
  assert.ok((await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true })).ok);
  const s = JSON.parse(r(path.join(e.repo, '.claude', 'settings.json')));
  s.theme = 'dark';
  w(path.join(e.repo, '.claude', 'settings.json'), JSON.stringify(s, null, 2) + '\n');
  w(path.join(e.repo, '.githooks', 'commit-msg'), '#!/bin/sh\nedited\n');
  const rv = await TX.revertTx(e.dataDir, 'last', { deps: e.deps, confirm: true });
  const s2 = JSON.parse(r(path.join(e.repo, '.claude', 'settings.json')));
  assert.strictEqual(s2.theme, 'dark');
  assert.strictEqual(s2.model, 'opus');
  assert.ok(!('PYTHONUTF8' in (s2.env || {})), 'the profile key went');
  assert.strictEqual(r(path.join(e.repo, '.githooks', 'commit-msg')), '#!/bin/sh\nedited\n');
  assert.strictEqual(r(path.join(e.repo, '.githooks', 'commit-msg.profile-removed')), '#!/bin/sh\nold\n');
  assert.ok(rv.flagged.some((f) => /commit-msg/.test(f)));
});

test('a read-back mismatch rolls the whole transaction back', async () => {
  const e = env();
  const pre = stateHash(e);
  const liar = Object.assign({}, e.deps.git, { get: (repo, k) => (k === 'core.hooksPath' && e.deps.git.m.has(repo + '|' + k) ? 'other' : e.deps.git.get(repo, k)) });
  const p = planOf(e);
  const res = await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: Object.assign({}, e.deps, { git: liar }), confirm: true });
  assert.strictEqual(res.ok, false);
  assert.match(res.line, /failed at floor-no-ai-attribution: read-back mismatch: git core.hooksPath - rolled back/);
  assert.strictEqual(treeHash([e.repo, e.configDir]), treeHash([e.repo, e.configDir]));
  assert.strictEqual(stateHash(e).length, pre.length);
  assert.deepStrictEqual(fs.readdirSync(e.repo), [], 'repo back to its empty pre-state');
});

test('--only scope keeps other applied items\' block text; hooks merge is idempotent', async () => {
  const e = env(richProfile());
  assert.ok((await TX.applyPlan(planOf(e), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true })).ok);
  const md = r(path.join(e.repo, 'CLAUDE.md'));
  const p = planOf(e, { only: ['rule-quiet'] });
  assert.ok(p.files.every((f) => f.status === 'same'), 'partial plan is a no-op');
  const sel = P.disable(e.model, P.readSelection(e.dataDir, e.model), ['rule-quiet']).selection;
  const p2 = planOf(e, { only: ['rule-quiet'], selection: sel });
  assert.deepStrictEqual(p2.removing, ['rule-quiet']);
  assert.ok((await TX.applyPlan(p2, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, selection: sel })).ok);
  const md2 = r(path.join(e.repo, 'CLAUDE.md'));
  assert.ok(!md2.includes('QUIET') && md2.includes('HAND-OFF'), md2);
  assert.notStrictEqual(md, md2);
  const s = JSON.parse(r(path.join(e.repo, '.claude', 'settings.json')));
  assert.strictEqual(s.hooks.Stop.length, 1);
  assert.strictEqual(s.hooks.Stop[0].hooks.length, 1);
});

test('platform filter: a win32-only item is skipped elsewhere', () => {
  const e = env();
  const sel = P.enable(e.model, {}, ['conv-session-env']).selection;
  const p = planOf(e, { selection: sel, platform: 'linux' });
  assert.deepStrictEqual(p.rows.filter((x) => x.item === 'conv-session-env').map((x) => [x.status, x.reason]), [['skipped', 'platform win32 only']]);
});

test('bypassPermissions needs the typed acknowledgement even with grouped consent', async () => {
  const dir = richProfile();
  const mj = path.join(dir, 'modules', 'extras', 'module.json');
  const m = JSON.parse(r(mj));
  m.items[1].contributes[0].value.permissions.defaultMode = 'bypassPermissions';
  w(mj, JSON.stringify(m, null, 2));
  const e = env(dir);
  const p = planOf(e);
  assert.deepStrictEqual(p.needsAck, ['set-bypass-permissions']);
  assert.match((await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, groupedConsent: true })).line, /--ack set-bypass-permissions/);
  assert.ok((await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ['set-bypass-permissions'] })).ok);
});

test('edit writes only the override; the plan renders it; reset drops it to the bin', async () => {
  const e = env();
  const bad = await P.editTemplate(e.model, e.dataDir, 'conv-handoff-file', { template: 'templates/handoff.txt', text: 'SESSION: 1\nsee C:\\Users\\x\n' });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /literal path/);
  assert.match((await P.editTemplate(e.model, e.dataDir, 'conv-handoff-file', { text: 'x {nope}\n' })).reason, /unknown variable/);
  const ok = await P.editTemplate(e.model, e.dataDir, 'conv-handoff-file', { template: 'templates/handoff.txt', text: 'SESSION: 1\nMine for {repo_code}.\n' });
  assert.ok(ok.ok);
  assert.ok(ok.file.startsWith(path.join(e.dataDir, 'profile', 'overrides', 'session')));
  assert.deepStrictEqual(fs.readdirSync(e.repo), []);
  const p = planOf(e);
  assert.strictEqual(p.files.find((f) => f.rel === 'AB-NEXT-SESSION.txt').after.toString(), 'SESSION: 1\nMine for AB.\n');
  const rs = await P.editTemplate(e.model, e.dataDir, 'conv-handoff-file', { template: 'templates/handoff.txt', reset: true, recycle: e.deps.recycle });
  assert.ok(rs.reset && !fs.existsSync(ok.file));
});

test('markers per file type; JSON cannot hold a block', () => {
  assert.strictEqual(PL.markersFor('x/CLAUDE.md', 'rules').begin, '<!-- profile:begin rules -->');
  assert.strictEqual(PL.markersFor('x/.githooks/pre-push', 'b').begin, '# profile:begin b');
  assert.strictEqual(PL.markersFor('a.js', 'b').end, '// profile:end b');
  assert.strictEqual(PL.markersFor('a.json', 'b'), null);
  assert.deepStrictEqual(PL.findBlock('<!-- profile:begin r -->\nx\n', PL.markersFor('a.md', 'r')), { bad: true });
});

test('udiff: context hunks', () => {
  const a = 'a\nb\nc\nd\ne\nf\ng\nh\n';
  const b = 'a\nb\nc\nD\ne\nf\ng\nh\n';
  assert.strictEqual(PL.udiff(a, b, 'f'), '--- a/f\n+++ b/f\n@@ -1,7 +1,7 @@\n a\n b\n c\n-d\n+D\n e\n f\n g\n');
  assert.strictEqual(PL.udiff(a, a, 'f'), '');
});

// ------------------------------------------------------------------ CLI

function cliEnv() {
  const e = env();
  const lines = [];
  const deps = Object.assign({}, e.deps, { out: (s) => lines.push(s), profileDir: MIN, dataDir: e.dataDir, configDir: e.configDir });
  const run = async (args) => { lines.length = 0; const code = await cli.run(['profile'].concat(args, ['--home', path.join(e.root, 'home')]), deps); return { code, text: lines.join('\n') }; };
  return Object.assign(e, { run, lines });
}

test('cli profile: list, view, enable, diff (dry run), apply, status, verify, revert', async () => {
  const e = cliEnv();
  const repo = 'repo:' + e.repo;
  let x = await e.run(['list', '--json']);
  assert.strictEqual(x.code, 0);
  const list = JSON.parse(x.text);
  assert.deepStrictEqual(list.modules.map((m) => [m.id, m.on, m.total]), [['floors', 1, 1], ['session', 1, 2]]);
  x = await e.run(['view', 'conv-handoff-file']);
  assert.match(x.text, /Does: Creates \{handoff_name\}/);
  assert.match(x.text, /Usually with: conv-session-env/);
  x = await e.run(['apply', '--target', repo, '--var', 'python=py']);
  assert.strictEqual(x.code, 1);
  assert.match(x.text, /conv-handoff-file needs \{repo_code\} \(asked at wizard\.step\.repo\); set it with --var repo_code=/);
  x = await e.run(['apply', '--target', repo, '--var', 'repo_code=AB', '--var', 'python=py']);
  assert.strictEqual(x.code, 0);
  assert.match(x.text, /dry run; nothing written/);
  assert.match(x.text, /apply with: claude-console profile apply/);
  assert.deepStrictEqual(fs.readdirSync(e.repo), []);
  x = await e.run(['diff', '--target', repo, '--var', 'repo_code=AB', '--var', 'python=py']);
  assert.match(x.text, /\+5\. HAND-OFF/);
  x = await e.run(['apply', '--target', repo, '--var', 'repo_code=AB', '--var', 'python=py', '--apply', '--yes']);
  assert.strictEqual(x.code, 0, x.text);
  assert.match(x.text, /applied tx \d{8}-\d{6}-\d{3}/);
  assert.match(x.text, /suggested commit \(the profile never commits\)/);
  assert.ok(fs.existsSync(path.join(e.repo, 'AB-NEXT-SESSION.txt')));
  assert.deepStrictEqual(P.readSelection(e.dataDir, e.model).variables, { repo_code: 'AB', python: 'py' }, 'values remembered for the next plan');
  x = await e.run(['status', '--target', repo]);
  assert.match(x.text, /lock: 2 item\(s\), 0 drift/);
  x = await e.run(['verify', '--target', repo]);
  assert.strictEqual(x.code, 0, x.text);
  x = await e.run(['enable', 'conv-session-env']);
  assert.match(x.text, /on: conv-session-env/);
  assert.match(x.text, /1 pending change/);
  x = await e.run(['apply', '--target', repo, '--apply', '--yes']);
  assert.strictEqual(x.code, 1);
  assert.match(x.text, /conv-session-env is high risk; add --ack conv-session-env/);
  x = await e.run(['revert', '--last']);
  assert.match(x.text, /dry run: revert/);
  x = await e.run(['revert', '--last', '--apply', '--yes']);
  assert.strictEqual(x.code, 0, x.text);
  assert.deepStrictEqual(fs.readdirSync(e.repo), []);
  x = await e.run(['disable', 'floors']);
  assert.strictEqual(x.code, 1);
  assert.match(x.text, /always on/);
});

test('cli profile: conflicts exit 2 with one line; uninstall --all removes and is revertable', async () => {
  const e = cliEnv();
  const repo = 'repo:' + e.repo;
  w(path.join(e.repo, '.githooks', 'commit-msg'), 'mine\n');
  let x = await e.run(['apply', '--target', repo, '--var', 'repo_code=AB', '--var', 'python=py', '--apply', '--yes']);
  assert.strictEqual(x.code, 2);
  assert.strictEqual(x.text.split('\n').filter((l) => /^conflict:/.test(l)).length, 1);
  x = await e.run(['apply', '--target', repo, '--var', 'repo_code=AB', '--var', 'python=py', '--keep', 'floor-no-ai-attribution', '--apply', '--yes']);
  assert.strictEqual(x.code, 0, x.text);
  x = await e.run(['uninstall', '--all', '--target', repo]);
  assert.match(x.text, /dry run/);
  x = await e.run(['uninstall', '--all', '--target', repo, '--apply', '--yes']);
  assert.strictEqual(x.code, 0, x.text);
  assert.deepStrictEqual(fs.readdirSync(e.repo).sort(), ['.githooks']);
  assert.strictEqual(r(path.join(e.repo, '.githooks', 'commit-msg')), 'mine\n');
});
