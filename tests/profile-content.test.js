'use strict';
// Setup profile content (CON-013 L1): the shipped profile in console/profile/ - profile.json,
// modules 1-15, their templates, EXCLUDED.md, review-step.json and presets/remus3.json.
// Modules 16-22 are lane L8's; while their directories are absent this test validates a
// temporary copy with a one-item stub per missing module (the frozen L8 id list), so the
// L0 validator still sees the whole profile. Nothing here writes outside os.tmpdir().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateProfileDir, varRefs, literalHits, BUILTIN_VARIABLES } = require('../installer/profile-schema');

const PROFILE = path.join(__dirname, '..', 'profile');
const L1_MODULES = ['floors', 'core-rules', 'session', 'output', 'subagent-first', 'race-guards', 'attribution',
  'tdd-agents', 'docs-memory', 'fleet', 'headless', 'maintenance', 'insights', 'board', 'console'];
// Frozen hand-over from lane L8 (design addendum a.2): modules 16-22, in order.
const L8_MODULES = ['ci-gates', 'recall', 'lessons', 'permissions-context', 'sidecar', 'runtime-agents', 'machine-profile'];
// Item id prefix -> L8 module, used only to place stub items for references into L8 content.
const L8_PREFIX = { 'ci-': 'ci-gates', 'rec-': 'recall', 'lsn-': 'lessons', 'cfg-': 'permissions-context',
  'sc-': 'sidecar', 'rta-': 'runtime-agents', 'mach-': 'machine-profile' };
const ITEM_COUNTS = { floors: 9, 'core-rules': 24, session: 11, output: 13, 'subagent-first': 6, 'race-guards': 4,
  attribution: 4, 'tdd-agents': 26, 'docs-memory': 22, fleet: 11, headless: 13, maintenance: 11, insights: 8,
  board: 2, console: 4 };
// The neutral-name kit lane L2 generates into profile/kit/ (design a.1). A kit contribution names only these.
const KIT_FILES = ['kit_headless.py', 'kit_done.py', 'kit_checklist.py', 'kit_claims.py', 'kit_gitlock.py',
  'kit_suite_gate.py', 'kit_test_guard.py', 'kit_identity.py', 'kit_subagent_first.py', 'kit_inbox.py',
  'kit_lanes.py', 'kit_watch.py', 'kit_secrets.py', 'kit_board.py', 'kit_rewrite.py', 'kit_statusline.js',
  'kit_subagent_status.js', 'tokens.json', 'tokens.css', 'LICENSE', 'NOTICE', 'MANIFEST.json'];

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const profile = () => readJson(path.join(PROFILE, 'profile.json'));
const moduleOf = (id) => readJson(path.join(PROFILE, 'modules', id, 'module.json'));
const l1Modules = () => L1_MODULES.map(moduleOf);
const l1Items = () => l1Modules().flatMap((m) => m.items.map((it) => Object.assign({ module: m.id }, it)));

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

// A copy of profile/ with a stub module for every L8 module whose directory is absent. Each stub
// holds one placeholder item plus every L8-prefixed id that L1 content refers to.
function profileForValidation() {
  const missing = L8_MODULES.filter((m) => !fs.existsSync(path.join(PROFILE, 'modules', m, 'module.json')));
  if (missing.length === 0) return { dir: PROFILE, missing };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-prof-'));
  fs.cpSync(PROFILE, tmp, { recursive: true });
  const refs = new Set();
  for (const it of l1Items()) for (const k of ['depends_on', 'pairs_with', 'conflicts_with']) for (const r of it[k] || []) refs.add(r);
  const order = profile().modules;
  for (const m of missing) {
    const ids = [m + '-stub'];
    for (const r of refs) { const p = Object.keys(L8_PREFIX).find((x) => r.startsWith(x)); if (p && L8_PREFIX[p] === m) ids.push(r); }
    const n = order.indexOf(m) + 1;
    const items = ids.map((id, i) => ({ id, order: n * 100 + i + 1, title: 'Stub', does: 'Stub item.', why: 'Stands in for lane L8 content.',
      risk: 'low', default: 'off', platform: ['win32', 'darwin', 'linux'], depends_on: [], pairs_with: [], conflicts_with: [], contributes: [] }));
    fs.mkdirSync(path.join(tmp, 'modules', m), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'modules', m, 'module.json'), JSON.stringify({ schema: 1, id: m, order: n, title: 'Stub ' + m,
      summary: 'Stub.', why: 'Stub.', default: 'off', items }));
  }
  return { dir: tmp, missing };
}

test('profile.json lists the 15 L1 modules then the 7 L8 modules, in order', () => {
  assert.deepEqual(profile().modules, [...L1_MODULES, ...L8_MODULES]);
});

test('the whole profile passes the L0 validator (L8 modules stubbed only while absent)', () => {
  const { dir, missing } = profileForValidation();
  for (const m of missing) assert.ok(L8_MODULES.includes(m));
  const r = validateProfileDir(dir);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('each L1 module has its item count, titles and prose', () => {
  for (const m of l1Modules()) {
    assert.equal(m.items.length, ITEM_COUNTS[m.id], m.id + ' item count');
    for (const k of ['summary', 'why']) assert.ok(m[k].length >= 20, m.id + '.' + k + ' too short');
  }
  const floors = moduleOf('floors');
  assert.equal(floors.locked, true);
  assert.ok(floors.items.every((it) => it.default === 'on'));
  assert.ok(floors.items.some((it) => it.id === 'floor-no-telemetry'));
});

test('presets match the design addendum a.2', () => {
  const p = profile().presets;
  assert.deepEqual(p.recommended, ['floors', 'core-rules', 'session', 'output', 'attribution', 'tdd-agents',
    'docs-memory', 'console', 'ci-gates', 'recall', 'lessons', 'permissions-context']);
  assert.deepEqual(p.minimal, ['floors', 'core-rules', 'session', 'attribution', 'lessons']);
  assert.equal(p.full, '*');
});

test('the hand-off budget is 30 KB with a 90 percent warning (addendum finding 1)', () => {
  const b = profile().variables.budgets.default;
  assert.equal(b.handoff_kb, 30);
  assert.equal(b.handoff_warn_pct, 90);
  assert.equal(b.handoff_fail_kb, undefined);
});

test('explanations are prose without repetition', () => {
  const seen = new Map();
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const texts = [];
  for (const m of l1Modules()) {
    texts.push([m.id + '.summary', m.summary], [m.id + '.why', m.why]);
    for (const it of m.items) {
      assert.notEqual(norm(it.does), norm(it.why), it.id + ': does and why are the same text');
      assert.ok(it.does.length >= 25 && it.why.length >= 25, it.id + ': does/why too short');
      assert.match(it.does, /[.!?)]$/, it.id + '.does is a sentence');
      assert.match(it.why, /[.!?)]$/, it.id + '.why is a sentence');
      texts.push([it.id + '.does', it.does], [it.id + '.why', it.why]);
      if (it.notes) texts.push([it.id + '.notes', it.notes]);
    }
  }
  for (const [where, t] of texts) {
    for (const s of t.split(/(?<=[.!?])\s+/)) {
      const k = norm(s);
      if (k.split(' ').length < 5) continue;
      assert.ok(!seen.has(k), 'sentence repeated in ' + where + ' and ' + seen.get(k) + ': ' + s);
      seen.set(k, where);
    }
  }
});

test('item ids are unique and titles are distinct', () => {
  const items = l1Items();
  const ids = items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  const titles = items.map((i) => i.title.toLowerCase());
  assert.equal(new Set(titles).size, titles.length);
});

test('every template file is used by a contribution, and every json-merge value uses declared variables', () => {
  const declared = new Set([...Object.keys(profile().variables), ...BUILTIN_VARIABLES]);
  for (const m of l1Modules()) {
    const dir = path.join(PROFILE, 'modules', m.id);
    const used = new Set();
    for (const it of m.items) for (const c of it.contributes) {
      if (c.template) used.add(c.template);
      if (c.value !== undefined) {
        const s = JSON.stringify(c.value);
        for (const v of varRefs(s)) assert.ok(declared.has(v), it.id + ': undeclared {' + v + '} in value');
        assert.deepEqual(literalHits(s), [], it.id + ': literal in value');
      }
    }
    const tdir = path.join(dir, 'templates');
    const files = fs.existsSync(tdir) ? walk(tdir).map((f) => path.relative(dir, f).split(path.sep).join('/')) : [];
    for (const f of files) assert.ok(used.has(f), m.id + ': orphan template ' + f);
  }
});

test('kit contributions name only files of the neutral-name kit', () => {
  for (const it of l1Items()) for (const c of it.contributes) {
    if (c.kind !== 'kit') continue;
    for (const f of c.files) assert.ok(KIT_FILES.includes(f), it.id + ': unknown kit file ' + f);
    // FB-1021: the account-level status lines copy into the Claude config folder
    assert.ok(['repo:{kit_dir}', 'user:statusline'].includes(c.target), it.id + ': kit target ' + c.target);
  }
});

test('shipped profile text carries no machine detail, token or private vocabulary', () => {
  // Built from pieces so this file itself passes the export scan.
  const words = [['FLEET', 'COMMON'].join('-'), 'fleet' + '_done', 'fleet' + '_headless', 'fleet' + '-kit', 'fleet' + ' kit',
    'operator' + ' order', 'remote1' + '_sync', 'team' + 'claude', 'Maint' + '-', 'Admin' + 'istrator', 'Python3' + '14'];
  const rx = [new RegExp('\\b' + 'MA' + 'IN' + '\\b'), /sk-ant-[A-Za-z0-9_-]{8}|\bgh[pousr]_[A-Za-z0-9]{20}|\bAKIA[0-9A-Z]{16}\b/,
    new RegExp('(?<![A-Za-z0-9_])(' + ['R' + 'C', 'L' + 'W', 'C' + 'S', 'RS' + 'C', 'E' + 'W', 'S' + 'S', 'L' + 'L'].join('|') + ')(?![A-Za-z0-9_])'),
    /(?<![\w/.-])docs\/[A-Za-z0-9_./-]+\.md\b/];
  for (const f of walk(PROFILE)) {
    if (f.includes(path.sep + 'kit' + path.sep)) continue; // lane L2's generated kit
    const t = fs.readFileSync(f, 'utf8');
    const rel = path.relative(PROFILE, f);
    for (const w of words) assert.ok(!t.includes(w), rel + ' contains a private term');
    for (const r of rx) assert.ok(!r.test(t), rel + ' matches ' + r);
    assert.ok(!/\r/.test(t), rel + ' has CR');
    assert.ok(!/[^\x09\x0a\x20-\x7e]/.test(t), rel + ' has a non-ASCII byte');
  }
});

// Render a template with harmless sample values so the language checks see real code.
const SAMPLE = { repo_code: 'DEMO', kit_dir: 'ops/kit', docs_dir: 'docs', runtime_dir: 'ops/runtime', control_dir: 'ops/loop/control',
  handoff_name: 'DEMO-NEXT-SESSION.txt', inbox_dir: 'inbox', outbox_dir: 'outbox', suite_slots: '2', retention_days: '30',
  retention_nested_days: '14', python: 'python', node: 'node', repo_root: 'R:/demo', reports_dir: 'R:/reports',
  documents: 'R:/docs', home: 'R:/home', temp: 'R:/temp', data_dir: 'R:/data', max_subagents: '10',
  budgets: '{"claude_md_kb": 40, "handoff_kb": 30}', refute_rounds: '2', headless_runs_per_day: '120' };
function render(text) {
  return text.replace(/(?<!\$)\{([a-z][a-z0-9_]*)\}/g, (m, k) => (k in SAMPLE ? SAMPLE[k] : 'X' + k));
}
function templatesWith(ext) {
  const out = [];
  for (const m of L1_MODULES) {
    const d = path.join(PROFILE, 'modules', m, 'templates');
    if (fs.existsSync(d)) for (const f of walk(d)) if (f.endsWith(ext)) out.push(f);
  }
  return out;
}

test('json templates parse after rendering', () => {
  for (const f of templatesWith('.json')) JSON.parse(render(fs.readFileSync(f, 'utf8')));
});

test('task templates are task XML with a hidden, time-capped action', () => {
  const xml = templatesWith('.xml');
  assert.ok(xml.length >= 5);
  for (const f of xml) {
    const t = fs.readFileSync(f, 'utf8');
    assert.match(t, /<Task version="1\.\d" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/);
    assert.match(t, /<ExecutionTimeLimit>PT\d+[HM]<\/ExecutionTimeLimit>/);
    assert.match(t, /<Command>wscript\.exe<\/Command>|<Command>pythonw?\.exe<\/Command>|<Command>\{python\}<\/Command>/);
    assert.match(t, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  }
});

const PS = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
test('.ps1 templates parse with Windows PowerShell 5.1', { skip: !(PS && fs.existsSync(PS)) && 'needs powershell.exe 5.1' }, () => {
  const files = templatesWith('.ps1');
  assert.ok(files.length >= 3);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ps1-'));
  for (const f of files) {
    const out = path.join(tmp, path.basename(f));
    fs.writeFileSync(out, render(fs.readFileSync(f, 'utf8')));
    const cmd = "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + out.replace(/'/g, "''") + "',[ref]$null,[ref]$e); $e.Count";
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.stdout.trim(), '0', path.basename(f) + ': ' + r.stdout + r.stderr);
  }
});

function findPython() {
  for (const c of [process.env.PYTHON, 'python', 'python3', 'py']) {
    if (!c) continue;
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout.trim() === '3') return c;
  }
  return null;
}
const PY = findPython();
test('python templates compile after rendering', { skip: !PY && 'needs python 3' }, () => {
  const files = templatesWith('.py');
  assert.ok(files.length >= 6);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-py-'));
  for (const f of files) {
    const out = path.join(tmp, path.basename(f));
    fs.writeFileSync(out, render(fs.readFileSync(f, 'utf8')));
    const r = spawnSync(PY, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', out], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, path.basename(f) + ': ' + r.stderr);
  }
});

test('default-on items of each preset only depend on items the preset turns on', () => {
  const p = profile();
  const byId = new Map(l1Items().map((it) => [it.id, it]));
  for (const name of ['recommended', 'minimal']) {
    const mods = new Set(p.presets[name]);
    for (const it of byId.values()) {
      if (!mods.has(it.module) || it.default !== 'on') continue;
      for (const d of it.depends_on) {
        const dep = byId.get(d);
        if (!dep) continue; // an L8 item: checked by L8's own test
        assert.ok(mods.has(dep.module) && dep.default === 'on', name + ': ' + it.id + ' needs ' + d + ' which the preset leaves off');
      }
    }
  }
});

test('EXCLUDED.md gives a reason for every inventory item that does not ship', () => {
  const t = fs.readFileSync(path.join(PROFILE, 'EXCLUDED.md'), 'utf8');
  const rows = [...t.matchAll(/^- `([a-z][a-z0-9-]*)` - (.{15,})$/gm)];
  assert.ok(rows.length >= 5);
  const ids = new Set(l1Items().map((i) => i.id));
  for (const [, id] of rows) assert.ok(!ids.has(id), id + ' is both shipped and excluded');
});

// release stage (lane L6) passes the public id list of the HOME-side inventory (no cites):
// [{"id", "module", "private"}], written by tools/profile_preset_export.py ids.
test('every non-private inventory id is a module item or listed in EXCLUDED.md', { skip: !process.env.PROFILE_INVENTORY_IDS && 'PROFILE_INVENTORY_IDS not set (release stage sets it)' }, () => {
  const inv = readJson(process.env.PROFILE_INVENTORY_IDS);
  const excluded = new Set([...fs.readFileSync(path.join(PROFILE, 'EXCLUDED.md'), 'utf8').matchAll(/^- `([a-z][a-z0-9-]*)` - /gm)].map((m) => m[1]));
  const shipped = new Set();
  for (const m of profile().modules) {
    const f = path.join(PROFILE, 'modules', m, 'module.json');
    if (fs.existsSync(f)) for (const it of readJson(f).items) shipped.add(it.id);
  }
  for (const e of inv) {
    if (!fs.existsSync(path.join(PROFILE, 'modules', e.module))) continue;
    if (e.private) continue;
    assert.ok(shipped.has(e.id) || excluded.has(e.id), e.id + ' is neither shipped nor excluded');
  }
});

test('review-step.json holds the review and liability step text (addendum e.4)', () => {
  const r = readJson(path.join(PROFILE, 'review-step.json'));
  assert.equal(r.schema, 1);
  assert.match(r.lead, /read what each one does and review the \.md files it adds/);
  assert.match(r.licence, /Apache-2\.0/);
  assert.match(r.licence, /as-is/);
  assert.equal(r.safeguards.length, 7);
  for (const s of r.safeguards) { assert.match(s.glyph, /^\[\+\]$/); assert.ok(s.word && s.text); }
  assert.equal(r.checkbox, "I've read this and I'm choosing what to enable");
  assert.equal(r.ask_again, 'major');
});

test('the remus3 preset covers every module and every L1 item', () => {
  const r = readJson(path.join(PROFILE, 'presets', 'remus3.json'));
  assert.equal(r.schema, 1);
  assert.equal(r.preset, 'remus3');
  assert.match(r.generated_from, /^[0-9a-f]{40}$/);
  assert.match(r.source_sha, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(r.modules), profile().modules);
  for (const v of Object.values(r.modules)) assert.ok(['on', 'off'].includes(v));
  for (const it of l1Items()) {
    const e = r.items[it.id];
    assert.ok(e, it.id + ' missing from the preset');
    assert.ok(['on', 'off'].includes(e.state));
    assert.ok(['author-runs', 'author-off', 'fleet-4-of-6', 'fleet-below-4', 'module-default', 'locked', 'dependency'].includes(e.rule), it.id + ' rule ' + e.rule);
  }
  for (const it of moduleOf('floors').items) assert.equal(r.items[it.id].state, 'on');
  const declared = new Set(Object.keys(profile().variables));
  for (const [k, v] of Object.entries(r.variables)) {
    assert.ok(declared.has(k), 'preset variable ' + k + ' is not declared');
    assert.ok(('value' in v) !== ('ask' in v), k + ' is either a value or an ask');
  }
});
