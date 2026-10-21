'use strict';
// CON-013 L0: the setup-profile schema (console/profile/SCHEMA.md). The validator accepts
// the 2-module fixture and rejects each malformed variant with an error naming the path.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../installer/profile-schema');

const FIX = path.join(__dirname, 'fixtures', 'profile-min');
const readJ = (rel) => JSON.parse(fs.readFileSync(path.join(FIX, ...rel.split('/')), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const profile = () => readJ('profile.json');
const floors = () => readJ('modules/floors/module.json');
const session = () => readJ('modules/session/module.json');
const vm = (m) => S.validateModule(m, { variables: profile().variables });

function rejects(res, re, label) {
  assert.strictEqual(res.ok, false, (label || '') + ' should be rejected');
  const text = res.errors.map((e) => e.path + ': ' + e.msg).join('\n');
  assert.match(text, re, (label || '') + ' error text:\n' + text);
}

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-min-'));
  tmpDirs.push(dir);
  fs.cpSync(FIX, dir, { recursive: true });
  return dir;
}
const writeJ = (dir, rel, obj) => fs.writeFileSync(path.join(dir, ...rel.split('/')), JSON.stringify(obj, null, 2) + '\n');

// ---------------------------------------------------------------- accepts

test('the fixture profile, both modules and the whole dir validate', () => {
  assert.deepStrictEqual(S.validateProfile(profile()).errors, []);
  assert.deepStrictEqual(vm(floors()).errors, []);
  assert.deepStrictEqual(vm(session()).errors, []);
  const r = S.validateProfileDir(FIX);
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.modules.map((m) => m.id), ['floors', 'session']);
  assert.strictEqual(r.profile.profile, 'fixture-min');
});

test('the closed lists are exported and match SCHEMA.md', () => {
  assert.deepStrictEqual([...S.CONTRIBUTION_KINDS].sort(), ['app-config', 'block', 'env', 'file', 'git', 'json-merge', 'kit', 'task']);
  const md = fs.readFileSync(path.join(__dirname, '..', 'profile', 'SCHEMA.md'), 'utf8');
  for (const k of S.CONTRIBUTION_KINDS) assert.ok(md.includes('`' + k + '`'), 'SCHEMA.md names kind ' + k);
  for (const t of S.VARIABLE_TYPES) assert.ok(md.includes('`' + t + '`'), 'SCHEMA.md names type ' + t);
  for (const v of S.VERIFY_KINDS) assert.ok(md.includes('`' + v + '`'), 'SCHEMA.md names verify ' + v);
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(md) && !md.includes('\r'), 'SCHEMA.md ASCII + LF');
});

test('the fixture files are ASCII and LF', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(FIX)) {
    const b = fs.readFileSync(f);
    assert.ok(!b.includes(13), f + ' has CR');
    assert.ok(b.every((c) => c === 9 || c === 10 || (c >= 32 && c < 127)), f + ' not ASCII');
  }
});

// ---------------------------------------------------------------- profile.json

test('profile.json: wrong schema, bad ids, versions and kit version are rejected', () => {
  const cases = [
    [(p) => { p.schema = 2; }, /schema: must be 1/],
    [(p) => { delete p.schema; }, /schema: must be 1/],
    [(p) => { p.profile = 'Bad Name'; }, /profile: /],
    [(p) => { p.version = '1.0'; }, /version: /],
    [(p) => { p.console_min = 'x'; }, /console_min: /],
    [(p) => { p.kit_source_version = 0; }, /kit_source_version: /],
    [(p) => { p.extra = 1; }, /extra: unknown key/],
  ];
  for (const [mut, re] of cases) { const p = profile(); mut(p); rejects(S.validateProfile(p), re, re.source); }
});

test('profile.json: modules and presets', () => {
  const cases = [
    [(p) => { p.modules = []; }, /modules: /],
    [(p) => { p.modules = ['floors', 'floors']; }, /modules\[1\]: duplicate/],
    [(p) => { p.modules = ['Floors']; }, /modules\[0\]: /],
    [(p) => { p.presets.recommended = ['nope']; }, /presets\.recommended\[0\]: unknown module nope/],
    [(p) => { p.presets.full = 'all'; }, /presets\.full: /],
    [(p) => { p.presets.Bad = ['floors']; }, /presets\.Bad: /],
  ];
  for (const [mut, re] of cases) { const p = profile(); mut(p); rejects(S.validateProfile(p), re, re.source); }
});

test('profile.json: variables', () => {
  const cases = [
    [(p) => { p.variables.Repo = { type: 'code' }; }, /variables\.Repo: name/],
    [(p) => { p.variables.repo_code.type = 'colour'; }, /variables\.repo_code\.type: /],
    [(p) => { p.variables.repo_code.pattern = '(['; }, /variables\.repo_code\.pattern: invalid regex/],
    [(p) => { p.variables.repo_code.bogus = true; }, /variables\.repo_code\.bogus: unknown key/],
    [(p) => { p.variables.kit_dir.default = '/abs/kit'; }, /variables\.kit_dir\.default: relpath/],
    [(p) => { p.variables.kit_dir.default = '../up'; }, /variables\.kit_dir\.default: relpath/],
    [(p) => { p.variables.reports_dir.default = 'D:\\Work\\reports'; }, /variables\.reports_dir\.default: machine-specific/],
    [(p) => { p.variables.reports_dir.default = 'C:\\Users\\someone\\x'; }, /variables\.reports_dir\.default: machine-specific/],
    [(p) => { p.variables.reports_dir.default = '/home/someone/x'; }, /variables\.reports_dir\.default: machine-specific/],
    [(p) => { p.variables.suite_slots.default = 9; }, /variables\.suite_slots\.default: out of range/],
    [(p) => { p.variables.suite_slots.default = 'two'; }, /variables\.suite_slots\.default: /],
    [(p) => { delete p.variables.handoff_name.value; }, /variables\.handoff_name\.value: /],
    [(p) => { p.variables.handoff_name.value = '{nope}-x.txt'; }, /variables\.handoff_name\.value: undeclared variable \{nope\}/],
    [(p) => { p.variables.handoff_name.value = '{handoff_name}'; }, /variables\.handoff_name\.value: refers to itself/],
    [(p) => { p.variables.headless_base_url.default = 'http://127.0.0.1:9999/'; }, /variables\.headless_base_url\.default: machine-specific/],
    [(p) => { p.variables.retention_days.default = 30; }, /variables\.retention_days\.default: a measure variable has no fixed default/],
  ];
  for (const [mut, re] of cases) { const p = profile(); mut(p); rejects(S.validateProfile(p), re, re.source); }
});

// ---------------------------------------------------------------- module.json

test('module.json: header fields', () => {
  const cases = [
    [(m) => { m.schema = 0; }, /schema: must be 1/],
    [(m) => { m.id = 'Session'; }, /id: /],
    [(m) => { m.order = 0; }, /order: /],
    [(m) => { m.title = ''; }, /title: /],
    [(m) => { delete m.why; }, /why: /],
    [(m) => { m.default = 'yes'; }, /default: /],
    [(m) => { m.locked = 'no'; }, /locked: /],
    [(m) => { m.items = []; }, /items: /],
    [(m) => { m.colour = 'red'; }, /colour: unknown key/],
  ];
  for (const [mut, re] of cases) { const m = session(); mut(m); rejects(vm(m), re, re.source); }
});

test('module.json: a locked module is on and so is every item', () => {
  const a = floors(); a.default = 'off'; rejects(vm(a), /default: a locked module is on/);
  const b = floors(); b.items[0].default = 'off'; rejects(vm(b), /items\[0\]\.default: a locked module's items are on/);
});

test('module.json: item fields', () => {
  const cases = [
    [(m) => { m.items[0].id = 'Bad_Id'; }, /items\[0\]\.id: /],
    [(m) => { m.items[1].id = m.items[0].id; }, /items\[1\]\.id: duplicate/],
    [(m) => { m.items[0].order = 301; }, /items\[0\]\.order: must be 201/],
    [(m) => { m.items[0].risk = 'none'; }, /items\[0\]\.risk: /],
    [(m) => { m.items[0].default = true; }, /items\[0\]\.default: /],
    [(m) => { m.items[0].platform = []; }, /items\[0\]\.platform: /],
    [(m) => { m.items[0].platform = ['win32', 'beos']; }, /items\[0\]\.platform\[1\]: /],
    [(m) => { m.items[0].does = ''; }, /items\[0\]\.does: /],
    [(m) => { m.items[0].contributes = 'x'; }, /items\[0\]\.contributes: /],
    [(m) => { m.items[0].scope = 'private'; }, /items\[0\]\.scope: /],
    [(m) => { m.items[0].wat = 1; }, /items\[0\]\.wat: unknown key/],
    [(m) => { m.items[0].pairs_with = [m.items[0].id]; }, /items\[0\]\.pairs_with\[0\]: refers to itself/],
  ];
  for (const [mut, re] of cases) { const m = session(); mut(m); rejects(vm(m), re, re.source); }
});

test('module.json: contributions - closed kind list and per-kind fields', () => {
  const c = (m) => m.items[0].contributes;
  const cases = [
    [(m) => { c(m)[0].kind = 'registry'; }, /contributes\[0\]\.kind: unknown kind registry/],
    [(m) => { c(m)[0].mode = 'overwrite'; }, /contributes\[0\]\.mode: /],
    [(m) => { delete c(m)[0].template; }, /contributes\[0\]\.template: /],
    [(m) => { c(m)[0].template = '../escape.txt'; }, /contributes\[0\]\.template: /],
    [(m) => { c(m)[0].template = 'handoff.txt'; }, /contributes\[0\]\.template: must be under templates\//],
    [(m) => { c(m)[0].target = 'C:/abs/file'; }, /contributes\[0\]\.target: /],
    [(m) => { c(m)[0].target = 'repo:../outside'; }, /contributes\[0\]\.target: /],
    [(m) => { c(m)[0].target = 'repo:a\\b'; }, /contributes\[0\]\.target: /],
    [(m) => { c(m)[0].target = 'repo:{nope}.txt'; }, /contributes\[0\]\.target: undeclared variable \{nope\}/],
    [(m) => { c(m)[1].block = 'Rules!'; }, /contributes\[1\]\.block: /],
    [(m) => { c(m)[1].slot = -1; }, /contributes\[1\]\.slot: /],
    [(m) => { c(m)[0].extra = 1; }, /contributes\[0\]\.extra: unknown key/],
    [(m) => { c(m).push({ kind: 'json-merge', target: 'repo:notes.json', value: {} }); }, /contributes\[2\]\.target: json-merge targets/],
    [(m) => { c(m).push({ kind: 'json-merge', target: 'repo:.claude/settings.json' }); }, /contributes\[2\]: json-merge needs exactly one of template, value/],
    [(m) => { c(m).push({ kind: 'git', key: 'user.email', value: 'x', scope: 'global' }); }, /contributes\[2\]\.scope: /],
    [(m) => { c(m).push({ kind: 'git', key: 'nodot', value: 'x' }); }, /contributes\[2\]\.key: /],
    [(m) => { c(m).push({ kind: 'kit', files: [] }); }, /contributes\[2\]\.files: /],
    [(m) => { c(m).push({ kind: 'kit', files: ['../x.py'] }); }, /contributes\[2\]\.files\[0\]: /],
    // CON-FB-2ND: account is main | second, and only on a user: target
    [(m) => { c(m).push({ kind: 'json-merge', target: 'user:settings.json', value: {}, account: 'third' }); }, /contributes\[2\]\.account: must be main or second/],
    [(m) => { c(m)[0].account = 'second'; }, /contributes\[0\]\.account: only on a user: target/],
  ];
  for (const [mut, re] of cases) { const m = session(); mut(m); rejects(vm(m), re, re.source); }
});

test('module.json: env and task contributions are high risk and Windows only', () => {
  const env = (m) => m.items[1];
  const cases = [
    [(m) => { env(m).risk = 'medium'; }, /items\[1\]\.risk: env and task contributions are high risk/],
    [(m) => { env(m).platform = ['win32', 'linux']; }, /items\[1\]\.platform: env and task contributions are win32 only/],
    [(m) => { env(m).contributes[0].name = 'lower'; }, /items\[1\]\.contributes\[0\]\.name: /],
    [(m) => { env(m).contributes[0].value = 'v'; env(m).contributes[0].secret = 'api-key'; }, /contributes\[0\]: env needs exactly one of value, secret/],
    [(m) => { delete env(m).contributes[0].value; }, /contributes\[0\]: env needs exactly one of value, secret/],
    [(m) => { env(m).contributes[0].value = 'sk-' + 'ant-abcdefghijklmnop'; }, /contributes\[0\]\.value: looks like a secret/],
    [(m) => { env(m).contributes[0] = { kind: 'task', name: 'Nightly', template: 'templates/t.xml' }; }, /contributes\[0\]\.name: task names start ClaudeProfile-/],
  ];
  for (const [mut, re] of cases) { const m = session(); mut(m); rejects(vm(m), re, re.source); }
});

test('module.json: detect and verify use the closed lists', () => {
  const cases = [
    [(m) => { m.items[0].detect = [{ smell: 'x' }]; }, /items\[0\]\.detect\[0\]: /],
    [(m) => { m.items[0].detect = [{ text: 'repo:CLAUDE.md' }]; }, /items\[0\]\.detect\[0\]: text needs regex/],
    [(m) => { m.items[0].detect = [{ text: 'repo:CLAUDE.md', regex: '(' }]; }, /items\[0\]\.detect\[0\]\.regex: invalid regex/],
    [(m) => { m.items[0].verify = [{ vibes: 'repo:x' }]; }, /items\[0\]\.verify\[0\]: /],
    [(m) => { m.items[0].verify = [{ regex: 'repo:x', line1: '[' }]; }, /items\[0\]\.verify\[0\]\.line1: invalid regex/],
    [(m) => { m.items[0].verify = [{ 'file-ascii-lf': 'repo:a', 'json-parse': 'repo:b' }]; }, /items\[0\]\.verify\[0\]: exactly one verify kind/],
  ];
  for (const [mut, re] of cases) { const m = session(); mut(m); rejects(vm(m), re, re.source); }
});

test('module.json: explanation text carries no literal machine detail', () => {
  const cases = [
    'Runs D:\\Tools\\x.exe first.',
    'Mail someone@example.com about it.',
    'Id 00000000-0000-4000-8000-000000000000 here.',
    'Board at https://claude.ai/code/' + 'artifact/abc123 here.',
    'Proxy on 127.0.0.1:9999 here.',
  ];
  for (const t of cases) {
    const m = session(); m.items[0].why = t;
    rejects(vm(m), /items\[0\]\.why: literal /, t);
  }
  const ok = session(); ok.items[0].why = 'Plain words, {handoff_name}, ~0.2 ms per file.';
  assert.deepStrictEqual(vm(ok).errors, []);
});

// ---------------------------------------------------------------- whole dir

test('dir: module list, ids, order and missing files', () => {
  let d = copyFixture();
  let p = profile(); p.modules = ['floors', 'session', 'ghost']; writeJ(d, 'profile.json', p);
  rejects(S.validateProfileDir(d), /modules\/ghost\/module\.json: missing/);

  d = copyFixture();
  let m = session(); m.id = 'sessions'; writeJ(d, 'modules/session/module.json', m);
  rejects(S.validateProfileDir(d), /modules\/session\/module\.json\.id: must equal the directory name session/);

  d = copyFixture();
  m = session(); m.order = 3; m.items[0].order = 301; m.items[1].order = 302; writeJ(d, 'modules/session/module.json', m);
  rejects(S.validateProfileDir(d), /modules\/session\/module\.json\.order: must be 2/);

  d = copyFixture();
  fs.mkdirSync(path.join(d, 'modules', 'stray'));
  fs.writeFileSync(path.join(d, 'modules', 'stray', 'module.json'), '{}\n');
  rejects(S.validateProfileDir(d), /modules\/stray: not listed in profile\.json modules/);

  d = copyFixture();
  fs.writeFileSync(path.join(d, 'modules', 'session', 'module.json'), '{ not json');
  rejects(S.validateProfileDir(d), /modules\/session\/module\.json: unreadable JSON/);

  d = copyFixture();
  fs.rmSync(path.join(d, 'modules', 'session', 'templates', 'handoff.txt'));
  rejects(S.validateProfileDir(d), /items\[0\]\.contributes\[0\]\.template: missing file templates\/handoff\.txt/);
});

test('dir: item ids are unique across modules and references resolve', () => {
  let d = copyFixture();
  let m = session(); m.items[0].id = 'floor-no-ai-attribution';
  m.items[1].depends_on = ['floor-no-ai-attribution']; m.items[0].pairs_with = [];
  writeJ(d, 'modules/session/module.json', m);
  rejects(S.validateProfileDir(d), /session.*items\[0\]\.id: duplicate item id floor-no-ai-attribution \(also in floors\)/);

  d = copyFixture();
  m = session(); m.items[1].depends_on = ['nope']; writeJ(d, 'modules/session/module.json', m);
  rejects(S.validateProfileDir(d), /items\[1\]\.depends_on\[0\]: unknown item nope/);

  d = copyFixture();
  m = session(); m.items[0].conflicts_with = ['floor-no-ai-attribution']; writeJ(d, 'modules/session/module.json', m);
  rejects(S.validateProfileDir(d), /items\[0\]\.conflicts_with\[0\]: conflict must be symmetric \(floor-no-ai-attribution does not list conv-handoff-file\)/);

  d = copyFixture();
  m = session(); m.items[0].depends_on = ['conv-session-env']; writeJ(d, 'modules/session/module.json', m);
  rejects(S.validateProfileDir(d), /depends_on: dependency cycle conv-handoff-file -> conv-session-env -> conv-handoff-file/);

  d = copyFixture();
  m = session(); m.items[1].conflicts_with = ['conv-handoff-file']; m.items[0].conflicts_with = ['conv-session-env'];
  writeJ(d, 'modules/session/module.json', m);
  rejects(S.validateProfileDir(d), /items\[1\]: conv-handoff-file is both a dependency and a conflict/);
});

test('dir: templates are ASCII + LF, use declared variables, carry no literal machine detail', () => {
  const t = (d) => path.join(d, 'modules', 'session', 'templates', 'handoff.txt');
  let d = copyFixture(); fs.writeFileSync(t(d), 'SESSION: 1\r\n');
  rejects(S.validateProfileDir(d), /templates\/handoff\.txt: CR/);
  d = copyFixture(); fs.writeFileSync(t(d), 'SESSION: 1 \u00e9\n');
  rejects(S.validateProfileDir(d), /templates\/handoff\.txt: non-ASCII byte at line 1/);
  d = copyFixture(); fs.writeFileSync(t(d), 'SESSION: 1\nsee {undeclared_thing}\n');
  rejects(S.validateProfileDir(d), /templates\/handoff\.txt: undeclared variable \{undeclared_thing\} at line 2/);
  d = copyFixture(); fs.writeFileSync(t(d), 'SESSION: 1\nrun D:\\Tools\\x.exe\n');
  rejects(S.validateProfileDir(d), /templates\/handoff\.txt: literal path at line 2/);
  d = copyFixture(); fs.writeFileSync(t(d), 'SESSION: 1\n{"json": {"is": "fine"}} and {repo_code}\n');
  assert.deepStrictEqual(S.validateProfileDir(d).errors, []);
});

test('the validator never throws on garbage input', () => {
  for (const g of [null, undefined, 1, 'x', [], { items: null }, { items: [null, 1] }]) {
    assert.strictEqual(S.validateProfile(g).ok, false);
    assert.strictEqual(S.validateModule(g).ok, false);
  }
  const r = S.validateProfileDir(path.join(os.tmpdir(), 'no-such-profile-dir-' + process.pid));
  rejects(r, /profile\.json: missing/);
});
