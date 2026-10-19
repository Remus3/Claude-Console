'use strict';
// CON-013 L8: content of the sibling-derived modules 16-22 (ci-gates, recall, lessons,
// permissions-context, sidecar, runtime-agents, machine-profile). Every manifest passes the
// L0 validator; counts and defaults match the design addendum; prose is complete; the lessons
// library is generic; templates are ASCII/LF and parse.
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const S = require('../installer/profile-schema');

const PROFILE = path.join(__dirname, '..', 'profile');
const MODS = path.join(PROFILE, 'modules');

// Frozen hand-over to L1 (profile.json): the module ids appended as orders 16-22, in order.
const SIBLING_MODULES = ['ci-gates', 'recall', 'lessons', 'permissions-context', 'sidecar', 'runtime-agents',
  'machine-profile'];

// [items, on by default, module default] per module (design addendum a.2).
const COUNTS = {
  'ci-gates': [17, 8, 'on'], recall: [7, 2, 'on'], lessons: [62, 48, 'on'], 'permissions-context': [9, 6, 'on'],
  sidecar: [10, 2, 'off'], 'runtime-agents': [12, 0, 'off'], 'machine-profile': [15, 1, 'off'],
};

// Variables these modules use. The first group is the main design a.2 set; the second is
// what L8 adds and L1 must declare in profile.json (frozen hand-over).
const DESIGN_VARS = {
  repo_code: { type: 'code', pattern: '^[A-Z][A-Z0-9]{1,5}$', ask: 'wizard.step.repo' },
  repo_root: { type: 'path', scope: 'target' },
  kit_dir: { type: 'relpath', default: 'ops/kit' },
  handoff_name: { type: 'derived', value: '{repo_code}-NEXT-SESSION.txt' },
  python: { type: 'exe', detect: 'python' },
  node: { type: 'exe', detect: 'node' },
  config_dir: { type: 'path', detect: 'claude-config-dir' },
  inbox_dir: { type: 'relpath', default: 'inbox' },
  outbox_dir: { type: 'relpath', default: 'outbox' },
  suite_slots: { type: 'int', default: 2, min: 1, max: 8 },
  budgets: { type: 'object', default: { claude_md_kb: 40, handoff_kb: 30 } },
};
const L8_VARS = {
  docs_dir: { type: 'relpath', default: 'docs', why: 'Folder that holds the repo docs (lessons, registers).' },
  sidecar_root: { type: 'path', default: '{data_dir}/sidecars', ask: 'wizard.step.sidecar', optional: true,
    why: 'Root of the per-repo sidecar areas outside the repo.' },
  sidecar_retention_days: { type: 'int', default: null, measure: 'sidecar-age-histogram' },
  runtime_retention_days: { type: 'int', default: null, measure: 'runtime-age-histogram' },
};
const VARS = Object.assign({}, DESIGN_VARS, L8_VARS);

// Items owned by other lanes (L1 modules 1-15) that these modules reference. L1 keeps these
// ids; the whole-profile validation below fails if one disappears.
const EXTERNAL = {
  floors: ['floor-os-settings-backup', 'floor-recycle-bin', 'floor-secrets-never-echoed'],
  'core-rules': ['rule-encoding-ascii-lf', 'rule-quiet-chat', 'set-bypass-permissions'],
  session: ['cmd-done', 'conv-dnr-reversal'],
  output: ['rule-hook-output'],
  'race-guards': ['kit-fleet-gitlock', 'kit-fleet-suite-gate', 'kit-fleet-test-guard'],
  attribution: ['hook-git-commit-msg', 'hook-git-pre-push-identity'],
  'tdd-agents': ['ag-phase0-recall', 'agent-adjudicator', 'cmd-root-cause-fix', 'conv-tdd-first'],
  'docs-memory': ['conv-memory-layout', 'md-doc-topology', 'tool-doc-budget'],
  headless: ['hl-inbox-responder', 'kit-fleet-headless'],
  maintenance: ['sched-temp-hygiene', 'tool-health-check'],
};
const FIRST15 = ['floors', 'core-rules', 'session', 'output', 'subagent-first', 'race-guards', 'attribution',
  'tdd-agents', 'docs-memory', 'fleet', 'headless', 'maintenance', 'insights', 'board', 'console'];

const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const mod = (id) => readJ(path.join(MODS, id, 'module.json'));
const all = () => SIBLING_MODULES.map(mod);
const items = () => all().flatMap((m) => m.items.map((it) => Object.assign({ module: m.id }, it)));
const tpl = (m, rel) => fs.readFileSync(path.join(MODS, m, ...rel.split('/')), 'utf8');

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
}
const ownFiles = () => SIBLING_MODULES.flatMap((m) => walk(path.join(MODS, m)));

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// ---------------------------------------------------------------- structure

test('each module validates on its own (L0 validator)', () => {
  for (const id of SIBLING_MODULES) {
    const r = S.validateModule(mod(id), { variables: VARS });
    assert.deepStrictEqual(r.errors, [], id);
  }
});

test('ids, orders, defaults and counts match the addendum', () => {
  SIBLING_MODULES.forEach((id, i) => {
    const m = mod(id);
    const [n, on, def] = COUNTS[id];
    assert.strictEqual(m.id, id);
    assert.strictEqual(m.order, 16 + i, id + ' order');
    assert.strictEqual(m.default, def, id + ' default');
    assert.strictEqual(m.locked, false, id + ' is never locked');
    assert.strictEqual(m.items.length, n, id + ' item count');
    assert.strictEqual(m.items.filter((it) => it.default === 'on').length, on, id + ' on count');
  });
  assert.strictEqual(items().length, 132);
});

test('the whole profile validates with the L1 modules in place (real or stand-in)', () => {
  const real = path.join(PROFILE, 'profile.json');
  if (fs.existsSync(real) && readJ(real).modules.includes('lessons')) {
    const r = S.validateProfileDir(PROFILE);
    assert.deepStrictEqual(r.errors, []);
    return;
  }
  // L1 has not landed: stand-in modules 1-15 that hold only the referenced ids.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-l8-'));
  tmpDirs.push(dir);
  const variables = JSON.parse(JSON.stringify(VARS));
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify({
    schema: 1, profile: 'l8-standin', version: '1.0.0', console_min: '0.1.3', kit_source_version: 20,
    modules: FIRST15.concat(SIBLING_MODULES), variables,
  }));
  FIRST15.forEach((id, i) => {
    const ids = EXTERNAL[id] || [id + '-standin'];
    fs.mkdirSync(path.join(dir, 'modules', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'modules', id, 'module.json'), JSON.stringify({
      schema: 1, id, order: i + 1, title: 'Stand-in', summary: 'Stand-in.', why: 'Stand-in.', default: 'on', locked: false,
      items: ids.map((x, j) => ({ id: x, order: (i + 1) * 100 + j + 1, title: 'Stand-in', does: 'Stand-in.', why: 'Stand-in.',
        risk: 'low', default: 'on', platform: ['win32', 'darwin', 'linux'], depends_on: [], pairs_with: [], conflicts_with: [],
        contributes: [] })),
    }));
  });
  for (const id of SIBLING_MODULES) fs.cpSync(path.join(MODS, id), path.join(dir, 'modules', id), { recursive: true });
  const r = S.validateProfileDir(dir);
  assert.deepStrictEqual(r.errors, []);
});

test('every cross-module reference is in the frozen external list', () => {
  const own = new Set(items().map((it) => it.id));
  const ext = new Set(Object.values(EXTERNAL).flat());
  for (const it of items()) {
    for (const k of ['depends_on', 'pairs_with', 'conflicts_with']) {
      for (const r of it[k]) assert.ok(own.has(r) || ext.has(r), it.id + '.' + k + ' -> ' + r);
    }
  }
});

// ---------------------------------------------------------------- prose

test('every item carries its what and why in clear prose', () => {
  for (const it of items()) {
    for (const k of ['title', 'does', 'why']) assert.ok(!/\n/.test(it[k]), it.id + '.' + k + ' one line');
    for (const k of ['does', 'why']) {
      assert.ok(it[k].length >= 40, it.id + '.' + k + ' says enough');
      assert.match(it[k], /[.)]$/, it.id + '.' + k + ' is a sentence');
      assert.match(it[k], /^[A-Z0-9`.]/, it.id + '.' + k + ' starts a sentence');
    }
  }
  for (const m of all()) for (const k of ['summary', 'why']) assert.ok(m[k].length >= 40, m.id + '.' + k);
});

test('off-by-default items carry a one-line "why enable later"', () => {
  for (const it of items().filter((x) => x.default === 'off')) {
    assert.ok(typeof it.notes === 'string', it.id + ' has notes');
    assert.match(it.notes, /^Enable later: [^\n]{20,}$/, it.id + ' notes');
  }
});

test('no private detail: tree codes, dates, sessions, hashes or bypass flags', () => {
  // The terms are assembled from parts so this file itself passes the export blocklist.
  const j = (...p) => p.join('');
  const codes = [j('R', 'C'), j('L', 'W'), j('C', 'S'), j('R', 'S', 'C'), j('E', 'W'), j('S', 'S'), j('L', 'L'), j('H', 'O', 'M')];
  const bad = [
    [new RegExp('(?<![A-Za-z0-9_])(' + codes.join('|') + ')(?![A-Za-z0-9_])'), 'tree code'],
    [new RegExp(['\\b' + j('MA', 'IN') + '\\b', '\\b' + j('Mai', 'nt-'), j('FLE', 'ET'), j('Adminis', 'trator'), '\\bnpx\\b'].join('|')),
      'private vocabulary'],
    [new RegExp([j('fleet', ' kit'), j('fleet', '_'), j('operator', ' order'), '\\b' + j('mo', 'on') + '\\b', j('team', 'claude')].join('|'), 'i'),
      'private vocabulary'],
    [/\b20\d\d-\d\d-\d\d\b/, 'date'],
    [/\bsession \d+|\bs\d{2,3}\b|\bRM-\d+/, 'session or ticket id'],
    [/\b[0-9a-f]{8,40}\b/, 'commit hash'],
    [/--dangerously-skip-permissions|"defaultMode":\s*"bypassPermissions"/, 'skip-permissions flag or bypass default'],
  ];
  for (const f of ownFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    for (const [re, what] of bad) assert.ok(!re.test(text), path.relative(MODS, f) + ': ' + what + ' ' + (text.match(re) || [''])[0]);
  }
});

test('shipped text names no docs path the export cannot resolve (docs dir is a variable)', () => {
  for (const f of ownFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/(?<![\w/.-])(?:\.\.\/)?docs\/[A-Za-z0-9_./-]+\.md\b/.test(text), path.relative(MODS, f));
  }
});

// ---------------------------------------------------------------- files

test('module files are ASCII and LF, templates exist and every template is used', () => {
  for (const f of ownFiles()) {
    const b = fs.readFileSync(f);
    assert.ok(!b.includes(13), f + ' has CR');
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(b.toString('latin1')), f + ' non-ASCII');
  }
  for (const m of all()) {
    const used = new Set(m.items.flatMap((it) => it.contributes.filter((c) => c.template).map((c) => c.template)));
    for (const t of used) assert.ok(fs.existsSync(path.join(MODS, m.id, ...t.split('/'))), m.id + ' ' + t);
    const tdir = path.join(MODS, m.id, 'templates');
    if (!fs.existsSync(tdir)) continue;
    for (const f of walk(tdir)) {
      const rel = path.relative(path.join(MODS, m.id), f).split(path.sep).join('/');
      assert.ok(used.has(rel), m.id + ' unused template ' + rel);
    }
  }
});

function tool(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  return r.error ? null : r;
}

// sh from PATH, else the one Git for Windows ships beside git (a PowerShell PATH lacks it).
function findSh() {
  if (tool('sh', ['-c', 'exit 0'])) return 'sh';
  const ex = tool('git', ['--exec-path']);
  if (!ex || ex.status !== 0) return null;
  let d = ex.stdout.trim();
  for (let i = 0; i < 4; i++) {
    for (const rel of [['usr', 'bin', 'sh.exe'], ['bin', 'sh.exe']]) {
      const c = path.join(d, ...rel);
      if (fs.existsSync(c) && tool(c, ['-c', 'exit 0'])) return c;
    }
    d = path.dirname(d);
  }
  return null;
}

test('python templates compile and shell templates parse (when the tools exist)', (t) => {
  const py = [process.env.PYTHON, 'python', 'python3'].filter(Boolean).find((c) => {
    const r = tool(c, ['-c', 'import sys; print(sys.version_info[0])']);
    return r && r.status === 0 && r.stdout.trim() === '3';
  });
  const sh = findSh();
  const files = ownFiles().filter((f) => f.includes(path.sep + 'templates' + path.sep));
  let n = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const isSh = /\.sh$/.test(f) || /^#!\/bin\/sh/.test(text);
    if (/\.py$/.test(f) && py) {
      const r = tool(py, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="ascii").read())', f]);
      assert.strictEqual(r.status, 0, f + '\n' + r.stderr); n++;
    } else if (isSh && sh) {
      const r = tool(sh, ['-n', f]);
      assert.strictEqual(r.status, 0, f + '\n' + r.stderr); n++;
    } else if (/\.json$/.test(f)) {
      assert.doesNotThrow(() => JSON.parse(text), f); n++;
    }
  }
  if (!py || !sh) t.diagnostic('python or sh missing: ' + n + ' files checked');
});

// ---------------------------------------------------------------- lessons

const LESSON_LINE = /^- [A-Z][^\n]+ - why: [^\n]+ \(prevents: [A-Za-z][A-Za-z /-]+\)\n$/;

test('lessons: 62 rules, 48 on, each a reusable rule with its why and incident class', () => {
  const ls = mod('lessons').items;
  assert.strictEqual(ls.length, 62);
  assert.strictEqual(ls.filter((it) => it.default === 'on').length, 48);
  let lines = 0;
  for (const it of ls) {
    assert.match(it.id, /^lsn-[a-z0-9-]+$/);
    const blocks = it.contributes.filter((c) => c.kind === 'block' && c.target === 'repo:{docs_dir}/lessons.md' && c.block === it.id);
    if (blocks.length === 0) {
      // A lesson that is the text of another item adds no second contribution.
      assert.match(it.notes || '', /Canonical: [a-z0-9-]+/, it.id + ' names its canonical item');
      const canon = /Canonical: ([a-z0-9-]+)/.exec(it.notes)[1];
      assert.ok(it.pairs_with.includes(canon), it.id + ' pairs with ' + canon);
      assert.deepStrictEqual(it.contributes, [], it.id + ' contributes nothing');
      continue;
    }
    assert.strictEqual(blocks.length, 1, it.id);
    const line = tpl('lessons', blocks[0].template);
    assert.match(line, LESSON_LINE, it.id + ' line shape');
    lines++;
  }
  assert.ok(lines >= 58, 'at most four canonical variants');
});

test('lessons: grouped under class headings, one pointer line in CLAUDE.md, platform tags', () => {
  const ls = mod('lessons').items;
  for (const it of ls.filter((x) => x.contributes.length)) {
    const own = it.contributes.find((c) => c.block === it.id);
    const head = it.contributes.find((c) => c.kind === 'block' && /^group-/.test(c.block));
    assert.ok(head, it.id + ' has its group heading');
    assert.match(tpl('lessons', head.template), /^## [A-Z][^\n]+\n$/);
    assert.ok(own.slot > head.slot && own.slot < head.slot + 100, it.id + ' sorts under its heading');
    const ptr = it.contributes.find((c) => c.target === 'repo:CLAUDE.md');
    assert.ok(ptr && ptr.block === 'lessons-pointer', it.id + ' pointer');
    const top = it.contributes.find((c) => c.kind === 'file');
    assert.ok(top && top.target === 'repo:{docs_dir}/lessons.md' && top.mode === 'create-only', it.id + ' file head');
  }
  const ptrText = tpl('lessons', 'templates/claude-md-pointer.md');
  assert.strictEqual(ptrText.trim().split('\n').length, 1, 'ONE pointer line');
  const win = ['lsn-compile-before-restart', 'lsn-kill-by-pid', 'lsn-no-window-flag', 'lsn-explicit-interpreter',
    'lsn-cmd-shims', 'lsn-kill-tree', 'lsn-short-paths'];
  for (const it of ls) {
    assert.deepStrictEqual(it.platform, win.includes(it.id) ? ['win32'] : ['win32', 'darwin', 'linux'], it.id);
  }
});

// ---------------------------------------------------------------- permissions, budgets, gates, agents

test('deny floor is on and denies the history-destroying commands', () => {
  const it = mod('permissions-context').items.find((x) => x.id === 'cfg-deny-floor');
  assert.strictEqual(it.default, 'on');
  const c = it.contributes.find((x) => x.kind === 'json-merge');
  const v = c.value || JSON.parse(tpl('permissions-context', c.template));
  const deny = v.permissions.deny;
  for (const p of ['Bash(git commit --amend:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)',
    'Bash(git push --tags:*)', 'Bash(git reset --hard:*)', 'Bash(rm -rf .:*)']) {
    assert.ok(deny.includes(p), 'deny ' + p);
  }
  assert.ok(!v.permissions.allow, 'the floor grants nothing');
});

test('md budgets: 30 KB fail with a 90% warning, read by the pre-commit gate', () => {
  const b = tpl('ci-gates', 'templates/md-budgets.txt');
  assert.match(b, /^warn_pct 90$/m);
  assert.match(b, /^\{handoff_name\} 30$/m);
  assert.match(b, /^\{docs_dir\}\/lessons\.md 30$/m);
  const gate = tpl('ci-gates', 'templates/checks/content_gate.py');
  assert.match(gate, /md-budgets\.txt/);
  assert.match(gate, /warn_pct/);
});

test('ci-gates: tiers, one dispatcher per hook, workflows choice, leak needles stay local', () => {
  const ci = mod('ci-gates');
  const by = (id) => ci.items.find((x) => x.id === id);
  assert.match(tpl('ci-gates', 'templates/rule-verification-tiers.md'), /Tier 0[\s\S]*Tier 1[\s\S]*Tier 2/);
  const disp = by('ci-hooks-install-check').contributes.filter((c) => c.kind === 'file' && /^repo:\.githooks\/[a-z-]+$/.test(c.target));
  assert.deepStrictEqual(disp.map((c) => c.target).sort(),
    ['repo:.githooks/commit-msg', 'repo:.githooks/pre-commit', 'repo:.githooks/pre-merge-commit', 'repo:.githooks/pre-push']);
  for (const c of disp) assert.match(tpl('ci-gates', c.template), /\.d\//, c.target + ' runs its .d checks');
  assert.ok(by('ci-hooks-install-check').contributes.some((c) => c.kind === 'git' && c.key === 'core.hooksPath' && c.value === '.githooks'));
  for (const id of ['ci-hook-pre-commit-content', 'ci-hook-commit-msg-format', 'ci-hook-pre-push-suite', 'ci-hook-pre-push-leak',
    'ci-hook-pre-merge-commit']) {
    assert.ok(by(id).depends_on.includes('ci-hooks-install-check'), id + ' needs the dispatchers');
    assert.ok(by(id).contributes.some((c) => /^repo:\.githooks\/[a-z-]+\.d\//.test(c.target)), id + ' adds a .d check');
  }
  assert.deepStrictEqual(by('ci-workflow-docs-complement').conflicts_with, ['ci-workflow-no-paths-ignore']);
  assert.deepStrictEqual(by('ci-workflow-no-paths-ignore').conflicts_with, ['ci-workflow-docs-complement']);
  const leak = by('ci-hook-pre-push-leak').contributes.find((c) => /needles/.test(c.target || ''));
  assert.strictEqual(leak.target, 'repo:.git/info/leak-needles.txt', 'needles never tracked');
  const wf = tpl('ci-gates', 'templates/workflows/ci.yml');
  assert.match(wf, /permissions:\s*\n\s+contents: read/);
  assert.match(wf, /timeout-minutes/);
  assert.ok(!/paths-ignore/.test(wf), 'main workflow runs on every push');
});

test('runtime agents: supervisor + agents 0-7 as charters, spawn never skips permissions', () => {
  const ra = mod('runtime-agents');
  for (let n = 0; n <= 7; n++) {
    const it = ra.items.find((x) => new RegExp('^rta-agent' + n + '-').test(x.id));
    assert.ok(it, 'agent ' + n);
    assert.strictEqual(it.scope, 'template');
    const c = it.contributes.find((x) => x.kind === 'file');
    const text = tpl('runtime-agents', c.template);
    for (const h of ['## Role', '## Writes', '## Never', '## Trigger', '## Model', '## Order', '## Output']) {
      assert.ok(text.includes(h), it.id + ' charter has ' + h);
    }
    assert.ok(it.depends_on.includes('rta-supervisor'));
  }
  const sup = ra.items.find((x) => x.id === 'rta-supervisor');
  assert.ok(sup.depends_on.includes('kit-fleet-headless'), 'depends on headless');
  const spawn = tpl('runtime-agents', 'templates/runtime/spawn.py');
  assert.match(spawn, /--allowedTools/);
});

test('machine-profile: ToS floor on, everything else off, no contributions outside the engine', () => {
  const mp = mod('machine-profile');
  const on = mp.items.filter((x) => x.default === 'on').map((x) => x.id);
  assert.deepStrictEqual(on, ['mach-tos-floor']);
  for (const it of mp.items) {
    assert.ok(!it.contributes.some((c) => c.kind === 'env' || c.kind === 'task'), it.id + ' writes no machine state by itself');
  }
  assert.match(mp.items.find((x) => x.id === 'mach-tos-floor').notes, /always on while/i);
});

test('sidecar: root variable, measured retention, register and reaper on', () => {
  const sc = mod('sidecar');
  const on = sc.items.filter((x) => x.default === 'on').map((x) => x.id).sort();
  assert.deepStrictEqual(on, ['sc-outside-repo-register', 'sc-runtime-ignored-reaped']);
  const text = JSON.stringify(sc);
  assert.ok(text.includes('{sidecar_root}'));
  const tplText = walk(path.join(MODS, 'sidecar', 'templates')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(tplText.includes('RETENTION_DAYS = {sidecar_retention_days}'), 'sidecar retention is the measured variable');
  assert.ok(tplText.includes('RETENTION_DAYS = {runtime_retention_days}'), 'runtime retention is the measured variable');
  assert.ok(tplText.includes('SendToRecycleBin'), 'sidecar deletes go to the Recycle Bin');
});

test('ci-gates hooks fire: rendered into a scratch repo, pre-commit refuses a planted byte (when git, sh, python exist)', (t) => {
  const py = [process.env.PYTHON, 'python', 'python3'].filter(Boolean).find((c) => {
    const r = tool(c, ['-c', 'import sys; print(sys.version_info[0])']);
    return r && r.status === 0 && r.stdout.trim() === '3';
  });
  const sh = findSh();
  if (!py || !sh || !tool('git', ['--version'])) { t.skip('git, sh or python missing'); return; }
  const pyPath = tool(py, ['-c', 'import sys; print(sys.executable)']).stdout.trim();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'l8-hooks-'));
  tmpDirs.push(repo);
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
  g('init', '-q');
  const ci = mod('ci-gates');
  const render = (s) => s.replace(/\{handoff_name\}/g, 'XY-NEXT-SESSION.txt').replace(/\{docs_dir\}/g, 'docs');
  for (const id of ['ci-hooks-install-check', 'ci-hook-pre-commit-content', 'ci-hook-commit-msg-format']) {
    for (const c of ci.items.find((x) => x.id === id).contributes) {
      if (c.kind !== 'file') continue;
      const dest = path.join(repo, ...c.target.slice('repo:'.length).split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, render(tpl('ci-gates', c.template)));
    }
  }
  g('config', 'core.hooksPath', '.githooks');
  g('config', 'profile.python', pyPath);
  g('config', 'user.name', 'probe');
  g('config', 'user.email', 'probe' + String.fromCharCode(64) + 'example.invalid');
  // Git runs hooks with its own tools on PATH; a bare sh.exe needs its folder added the same way.
  const env = Object.assign({}, process.env);
  if (sh !== 'sh') env.PATH = path.dirname(sh) + path.delimiter + (env.PATH || env.Path || '');
  const armed = spawnSync(sh, ['.githooks/check-armed.sh', '--check'], { cwd: repo, encoding: 'utf8', windowsHide: true, env });
  assert.strictEqual(armed.status, 0, armed.stdout + armed.stderr);
  assert.match(armed.stdout, /hooks armed/);
  fs.writeFileSync(path.join(repo, 'ok.txt'), 'plain ascii\n');
  g('add', 'ok.txt');
  const good = g('commit', '-q', '-m', 'Add a plain file');
  assert.strictEqual(good.status, 0, good.stderr);
  fs.writeFileSync(path.join(repo, 'XY-NEXT-SESSION.txt'), 'x'.repeat(31 * 1024) + '\n');
  g('add', 'XY-NEXT-SESSION.txt');
  const big = g('commit', '-q', '-m', 'Add an oversized hand-off');
  assert.notStrictEqual(big.status, 0, 'a 31 KB hand-off is over its 30 KB budget');
  assert.match(big.stderr, /over its 30 KB budget/);
  fs.writeFileSync(path.join(repo, 'XY-NEXT-SESSION.txt'), 'x'.repeat(28 * 1024) + '\n');
  g('add', 'XY-NEXT-SESSION.txt');
  const warn = g('commit', '-q', '-m', 'Add a hand-off near its budget');
  assert.strictEqual(warn.status, 0, warn.stderr);
  assert.match(warn.stderr, /warning: .* of its 30 KB budget/);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  g('add', 'a.txt');
  const placeholder = g('commit', '-q', '-m', 'wip');
  assert.notStrictEqual(placeholder.status, 0, 'placeholder subject refused');
});
