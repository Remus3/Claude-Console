'use strict';
// CON-013 L3x: adopt an existing project, non-destructively (addendum b + c.1-c.3).
// Unit tests with fakes, then the integration against the seeded non-conforming demo repo
// (tools/demo-adopt-seed.js, generated into a temp dir): the project's own node:test
// suite, build and start commands really run, on the pristine side and on the copy.
// Never a real user repo: every path is under the test temp dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { tmpdir } = require('./helpers');
const P = require('../installer/profile');
const CP = require('../installer/profile-copy');
const FC = require('../installer/profile-funcheck');
const PR = require('../installer/profile-promote');
const AD = require('../installer/profile-adopt');
const cli = require('../installer/cli');
const SEED = require('../tools/demo-adopt-seed');

const MIN = path.join(__dirname, 'fixtures', 'profile-min');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ALL = ['win32', 'darwin', 'linux'];

// The L0 fixture plus the modules whose rules adopt carries out (ids from the inventory).
function adoptProfile() {
  const dir = path.join(tmpdir('cc-adopt-p-'), 'profile');
  fs.cpSync(MIN, dir, { recursive: true });
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
  pj.modules.push('core-rules', 'docs-memory', 'sidecar');
  w(path.join(dir, 'profile.json'), JSON.stringify(pj, null, 2) + '\n');
  const item = (id, order, extra) => Object.assign({ id, order, title: 'Item ' + id, does: 'Does ' + id + '.', why: 'Because ' + id + '.', risk: 'low', default: 'on', platform: ALL, depends_on: [], pairs_with: [], conflicts_with: [], contributes: [] }, extra || {});
  const fl = JSON.parse(fs.readFileSync(path.join(dir, 'modules', 'floors', 'module.json'), 'utf8'));
  fl.items.push(item('floor-secrets-never-echoed', 102, { title: 'Secrets are references, never literals' }));
  w(path.join(dir, 'modules', 'floors', 'module.json'), JSON.stringify(fl, null, 2) + '\n');
  const mod = (id, order, items) => ({ schema: 1, id, order, title: 'Module ' + id, summary: 'Adopt test module ' + id + '.', why: 'Adopt rules.', default: 'on', items });
  w(path.join(dir, 'modules', 'core-rules', 'module.json'), JSON.stringify(mod('core-rules', 3, [
    item('rule-encoding-ascii-lf', 301, { title: 'ASCII only, LF only', contributes: [{ kind: 'block', target: 'repo:CLAUDE.md', block: 'rules', slot: 8, template: 'templates/rule-ascii.md' }] }),
    item('conv-gitattributes-lf', 302, { title: '.gitattributes pins LF' }),
  ]), null, 2) + '\n');
  w(path.join(dir, 'modules', 'core-rules', 'templates', 'rule-ascii.md'), '8. ENCODING: ASCII only, LF only.\n');
  w(path.join(dir, 'modules', 'docs-memory', 'module.json'), JSON.stringify(mod('docs-memory', 4, [item('conv-doc-size-budget', 401, { title: 'File-size budgets (relocate, do not delete)' })]), null, 2) + '\n');
  w(path.join(dir, 'modules', 'sidecar', 'module.json'), JSON.stringify(mod('sidecar', 5, [item('sc-scratch-area', 501, { title: 'Scratch area outside the repo' })]), null, 2) + '\n');
  return dir;
}

function env() {
  const root = tmpdir('cc-adopt-');
  const dataDir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  let n = 0;
  const recycle = async (p) => { fs.renameSync(p, path.join(bin, (n++) + '-' + path.basename(p))); return true; };
  const profileDir = adoptProfile();
  const engine = P.openEngine({ profileDir, dataDir, deps: {} });
  assert.ok(engine.model.ok, JSON.stringify(engine.model.errors));
  const values = { repo_code: 'DM', python: 'python' };
  return { root, dataDir, bin, recycle, profileDir, engine, values };
}

function seeded(e, name, opts) {
  const dir = path.join(e.root, name || 'demo');
  SEED.seed(dir, opts);
  return dir;
}

const adoptApi = (e, extra) => AD.openAdopt({ engine: e.engine, dataDir: e.dataDir, deps: Object.assign({ recycle: e.recycle }, extra || {}) });
const fullHash = (d) => CP.treeHash(d);

// ------------------------------------------------------------------ unit

test('readOnlyFs: reads inside the root; every write method throws EROFS; no escape', () => {
  const d = tmpdir('cc-ro-');
  w(path.join(d, 'a.txt'), 'x');
  const ro = CP.readOnlyFs(d);
  assert.strictEqual(ro.readFileSync('a.txt', 'utf8'), 'x');
  assert.deepStrictEqual(ro.readdirSync('.'), ['a.txt']);
  for (const m of CP.WRITE_METHODS) assert.throws(() => ro[m](path.join(d, 'a.txt'), 'y'), (err) => err.code === 'EROFS', m);
  assert.throws(() => ro.readFileSync(path.join(d, '..', 'other.txt')), /outside the original/);
  assert.strictEqual(fs.readFileSync(path.join(d, 'a.txt'), 'utf8'), 'x', 'the planted writes changed nothing');
});

test('makeCopy: base and copy are byte copies (untracked, ignored, .git, empty dirs); excluded folders stay out', () => {
  const src = tmpdir('cc-cp-src-');
  w(path.join(src, 'a.txt'), 'a\r\n');
  w(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  w(path.join(src, '.gitignore'), 'build/\n');
  w(path.join(src, 'build', 'out.bin'), Buffer.from([0, 1, 2]));
  w(path.join(src, 'node_modules', 'x', 'i.js'), '1');
  fs.mkdirSync(path.join(src, 'empty'));
  const before = fullHash(src);
  const ad = tmpdir('cc-cp-ad-');
  const c = CP.makeCopy(src, ad, { exclude: ['node_modules'] });
  assert.strictEqual(fullHash(src), before, 'the original is untouched');
  assert.strictEqual(c.origHash, before);
  for (const d of [c.baseDir, c.copyDir]) {
    assert.ok(fs.existsSync(path.join(d, 'build', 'out.bin')) && fs.existsSync(path.join(d, '.git', 'HEAD')) && fs.existsSync(path.join(d, 'empty')));
    assert.ok(!fs.existsSync(path.join(d, 'node_modules')));
    assert.strictEqual(CP.manifest(d).hash, c.copyHash);
  }
  assert.deepStrictEqual(c.manifest.excluded, ['node_modules']);
  assert.strictEqual(c.manifest.files['a.txt'].sha, sha(Buffer.from('a\r\n')));
  assert.throws(() => CP.makeCopy(src, ad), /already holds/);
});

test('hunks: line ranges in the original and the copy', () => {
  const h = AD.hunks(Buffer.from('a\nb\nc\nd\n'), Buffer.from('a\nB\nc\nd\ne\n'));
  assert.deepStrictEqual(h.map((x) => [x.o, x.n, x.removed, x.added]), [[[2, 1], [2, 1], ['b'], ['B']], [[5, 0], [5, 1], [], ['e']]]);
  assert.deepStrictEqual(AD.hunks(null, Buffer.from('x\n'))[0].n, [1, 1]);
});

test('break-risk heuristics: CRLF-required files and read-by-path importers', () => {
  const d = tmpdir('cc-br-');
  w(path.join(d, 'run.bat'), 'x\r\n');
  w(path.join(d, 'data', 'a.csv'), 'a\r\n');
  w(path.join(d, 'tests', 'a.test.js'), "const h = sha256(read('a.csv'));\n");
  w(path.join(d, 'tests', 'fixtures', 'f.txt'), 'x\r\n');
  w(path.join(d, 'src', 'read.py'), "x = 1\nopen('docs/t.md')\n");
  w(path.join(d, 'README.md'), 'see docs/t.md\n');
  const ctx = { dir: d, files: ['run.bat', 'data/a.csv', 'tests/a.test.js', 'tests/fixtures/f.txt', 'src/read.py', 'README.md'], text: (r) => { try { return fs.readFileSync(path.join(d, r), 'latin1'); } catch (x) { return null; } } };
  assert.match(AD.crlfRequired('run.bat', ctx).join(), /batch/);
  assert.match(AD.crlfRequired('data/a.csv', ctx).join(), /bytes asserted by tests\/a\.test\.js/);
  assert.match(AD.crlfRequired('tests/fixtures/f.txt', ctx).join(), /fixture/);
  assert.deepStrictEqual(AD.importers('docs/t.md', ctx), ['src/read.py:2'], 'code that opens it, not prose that mentions it');
});

test('funcheck: counts from node:test, pytest and jest; verdicts; detection and edits', () => {
  assert.deepStrictEqual(FC.parseCounts('ok 1 - a\nnot ok 2 - catalog checksum\n# pass 23\n# fail 1\n# skipped 0\n'), { passed: 23, failed: 1, skipped: 0, failing: ['catalog checksum'] });
  assert.deepStrictEqual(FC.parseCounts('FAILED tests/test_a.py::test_x - assert\n==== 1 failed, 23 passed, 2 skipped in 0.31s ====').failed, 1);
  assert.strictEqual(FC.parseCounts('Tests:       2 failed, 22 passed, 24 total').passed, 22);
  const s = (ok, p, f, failing) => ({ ok, counts: { passed: p, failed: f, skipped: 0, failing: failing || [] }, lines: [] });
  assert.strictEqual(FC.compare(s(true, 24, 0), s(true, 24, 0)).verdict, 'same');
  assert.strictEqual(FC.compare(s(true, 24, 0), s(false, 22, 2, ['x'])).verdict, 'WORSE');
  assert.strictEqual(FC.compare(s(false, 22, 2, ['x']), s(true, 24, 0)).verdict, 'better');
  assert.deepStrictEqual(FC.compare(s(false, 23, 1, ['a']), s(false, 23, 1, ['b'])).newlyFailing, ['b']);
  const d = tmpdir('cc-det-');
  SEED.seed(d, { git: false });
  const det = FC.detectChecks(d, { platform: 'win32' });
  assert.deepStrictEqual(det.checks.map((c) => [c.id, c.cmd]), [['test', 'node --test'], ['build', 'node app/build.js'], ['start', 'node app/server.js']]);
  assert.deepStrictEqual(det.alternatives.map((c) => c.label).sort(), ['README run block', 'start.bat']);
  const ed = FC.editChecks(det.checks, ['build=', 'test=node --test tests/', 'lint=node app/build.js']);
  assert.deepStrictEqual(ed.map((c) => [c.id, c.cmd]), [['test', 'node --test tests/'], ['start', 'node app/server.js'], ['lint', 'node app/build.js']]);
});

test('bisect: two independent breakers among 16 changes, each named in at most log2(n)+1 probes', async () => {
  const ids = Array.from({ length: 16 }, (_, i) => 'c' + i);
  const bad = new Set(['c3', 'c11']);
  const r = await FC.bisect(ids, async (s) => s.some((x) => bad.has(x)), { knownWorse: true });
  assert.deepStrictEqual(r.culprits.map((c) => c.id), ['c3', 'c11']);
  for (const c of r.culprits) assert.ok(c.probes <= Math.log2(16) + 1, c.id + ' ' + c.probes);
  const none = await FC.bisect(ids, async () => false);
  assert.deepStrictEqual(none.culprits, []);
});

test('promote / remove-original gates without a confirmation, in the same run, without the phrase, too early', async () => {
  const e = env();
  const orig = seeded(e, 'gates', { git: false });
  const api = adoptApi(e);
  const st = await api.start(orig, { values: e.values });
  assert.ok(st.ok, st.line);
  let ad = st.adoption;
  assert.match((await api.promote(ad, { confirm: true })).line, /nothing applied/);
  api.choose(ad, { accept: ['all-safe'] });
  assert.ok((await api.apply(ad, { confirm: true })).ok);
  assert.match((await api.promote(ad, { confirm: true })).line, /needs your "works" confirmation/);
  assert.match(api.works(ad, { word: 'yes' }).line, /type the word works/);
  assert.match(api.works(ad, { word: 'works' }).line, /run the function check/);
  assert.match((await PR.removeOriginal(ad, { phrase: 'x' })).line, /only after a promote/);
});

// ------------------------------------------------------------------ integration (seeded demo)

function projection(rep) {
  return rep.changes.map((c) => {
    const o = { id: c.id, op: c.op, files: (c.files || []).filter((f) => f.file).map((f) => ({ file: f.file, orig: f.orig, copy: f.copy })) };
    if (c.breakRisk) o.breakRisk = { class: c.breakRisk.class, importers: c.breakRisk.importers || null };
    if (c.dest) o.dest = c.dest;
    if (c.shape) o.shape = c.shape;
    if (c.default) o.default = true;
    return o;
  });
}

test('E1 report only: every file and line per rule, break risks predicted, the original untouched', async () => {
  const e = env();
  const orig = seeded(e);
  const before = fullHash(orig);
  const lines = [];
  const deps = { out: (s) => lines.push(s), profileDir: e.profileDir, dataDir: e.dataDir, configDir: path.join(e.root, 'cfg'), recycle: e.recycle, noDefaultAdapters: true };
  const code = await cli.run(['profile', 'adopt', orig, '--report', '--var', 'repo_code=DM', '--var', 'python=python', '--home', path.join(e.root, 'home')], deps);
  const text = lines.join('\n');
  assert.strictEqual(code, 0, text);
  assert.strictEqual(fullHash(orig), before, 'the original tree (.git included) is byte-identical');
  const l = AD.listAdoptions(path.join(e.dataDir, 'adopt'));
  assert.strictEqual(l.length, 1);
  const rep = JSON.parse(fs.readFileSync(path.join(e.dataDir, 'adopt', l[0].id, 'adopt-report.json'), 'utf8'));
  const proj = projection(rep);
  if (process.env.ADOPT_WRITE_EXPECTED === '1') w(SEED.EXPECTED, JSON.stringify(proj, null, 2) + '\n');
  assert.deepStrictEqual(proj, JSON.parse(fs.readFileSync(SEED.EXPECTED, 'utf8')), 'the report equals the reviewed expected-report.json');
  const byId = new Map(rep.changes.map((c) => [c.id, c]));
  const csv = byId.get('rule-encoding-ascii-lf@app/data/catalog.csv');
  assert.strictEqual(csv.breakRisk.class, 'crlf-required');
  assert.match(csv.breakRisk.reasons.join(), /bytes asserted by tests\/catalog\.test\.js/);
  assert.strictEqual(csv.default, false, 'a predicted break is unchecked by default');
  const tpl = byId.get('conv-doc-size-budget@app/templates/report.md');
  assert.deepStrictEqual(tpl.breakRisk.importers, ['app/render.js:14']);
  assert.ok(tpl.hunkHash && tpl.files[0].movedHash === tpl.files[1].movedHash, 'relocation pair carries one hunk hash');
  assert.ok(byId.get('sc-scratch-area@scratch_tmp') && byId.get('sc-scratch-area@debug.log') && byId.get('sc-scratch-area@out (copy).txt'));
  const secrets = rep.changes.filter((c) => c.item === 'floor-secrets-never-echoed');
  assert.deepStrictEqual(secrets.map((c) => c.file).sort(), ['.env.example', 'app/lib/fmt.js', 'config/settings.ini']);
  assert.ok(secrets.every((c) => c.reportOnly));
  const s = SEED.fakeSecrets();
  for (const f of ['adopt-report.json', 'adopt-report.txt']) {
    const t = fs.readFileSync(path.join(e.dataDir, 'adopt', l[0].id, f), 'utf8');
    for (const v of Object.values(s)) assert.ok(!t.includes(v), 'a secret-shaped value is never echoed: ' + f);
  }
  assert.ok(!text.includes(s.sk) && !text.includes(s.ghp));
  assert.ok(rep.changes.some((c) => c.item === 'floor-no-ai-attribution' && c.reportOnly && /co-author trailer/.test(c.why)));
  assert.match(text, /\[!\] differs\s+rule-encoding-ascii-lf/);
  assert.match(text, /BREAK RISK crlf-required/);
  assert.match(text, /\[-\] local package\.json/);
  assert.ok(!/\[-\] local app\b/.test(text), 'app/ has proposed changes, so it is not local-only');
});

test('E3 full adoption: WORSE blocks promotion, bisect names both breakers, revert each, works, promote, remove-original later', async () => {
  const e = env();
  const orig = seeded(e);
  const before = fullHash(orig);
  const api = adoptApi(e);
  const st = await api.start(orig, { values: e.values });
  assert.ok(st.ok, st.line);
  let ad = st.adoption;
  const ch = api.choose(ad, { accept: ['all'], acks: [] });
  assert.ok(ch.ids.includes('rule-encoding-ascii-lf@app/data/catalog.csv') && ch.ids.includes('conv-doc-size-budget@app/templates/report.md'));
  const ap = await api.apply(ad, { confirm: true });
  assert.ok(ap.ok, ap.line);
  assert.ok(api.verifyLedger(ad).ok);
  assert.strictEqual(fullHash(orig), before, 'apply wrote nothing in the original');
  assert.strictEqual(fs.readFileSync(path.join(ad.copyDir, 'app', 'lib', 'sum.js'), 'latin1').includes('\r'), false);
  assert.ok(fs.existsSync(path.join(ad.copyDir, 'docs', 'archive', 'NOTES.md')) && fs.existsSync(path.join(ad.copyDir, '.gitattributes')));
  assert.ok(!fs.existsSync(path.join(ad.copyDir, 'scratch_tmp')), 'stray scratch moved out of the copy');
  api.setChecks(ad, { edits: ['build=', 'start='], confirm: true });
  let r = await api.check(ad, {});
  assert.strictEqual(r.result.verdict, 'FAILED', JSON.stringify(r.result.rows.map((x) => [x.id, x.verdict, x.why])));
  const row = r.result.rows.find((x) => x.id === 'test');
  assert.strictEqual(row.verdict, 'WORSE');
  assert.ok(row.newlyFailing.includes('catalog checksum') && row.newlyFailing.includes('render uses the template'), JSON.stringify(row.newlyFailing));
  const b = r.result.bisect[0];
  assert.deepStrictEqual(b.culprits.map((c) => c.id).sort(), ['conv-doc-size-budget@app/templates/report.md', 'rule-encoding-ascii-lf@app/data/catalog.csv']);
  for (const c of b.culprits) assert.ok(c.probes <= b.limitPerCulprit, c.id + ' took ' + c.probes);
  assert.ok(b.culprits.find((c) => c.id.endsWith('catalog.csv')).newlyFailing.includes('catalog checksum'));
  assert.match(api.works(ad, { word: 'works' }).line, /FAILED/, 'no works confirmation while WORSE');
  for (const c of b.culprits) { const rv = await api.revert(api.load(ad.id), { change: c.id, confirm: true }); assert.ok(rv.ok, rv.line); }
  ad = api.load(ad.id);
  assert.strictEqual(ad.accepted.length, ch.ids.length - 2, 'every other accepted change kept');
  r = await api.check(ad, {});
  assert.strictEqual(r.result.verdict, 'passed', JSON.stringify(r.result.rows.map((x) => [x.id, x.verdict, x.why])));
  ad = api.load(ad.id);
  // Stale confirmation: edit the copy after confirming.
  assert.ok(api.works(ad, { word: 'works' }).ok);
  fs.appendFileSync(path.join(ad.copyDir, 'README.md'), 'edited\n');
  assert.match((await api.promote(ad, { confirm: true, runId: 'run-1' })).line, /changed after you confirmed/);
  fs.writeFileSync(path.join(ad.copyDir, 'README.md'), fs.readFileSync(path.join(ad.baseDir, 'README.md')));
  // The original changed since the copy: refused with the list.
  fs.appendFileSync(path.join(orig, 'NOTES.md'), 'x\n');
  assert.match((await api.promote(ad, { confirm: true, runId: 'run-1' })).line, /original changed since the copy \(1\): changed NOTES\.md/);
  fs.writeFileSync(path.join(orig, 'NOTES.md'), fs.readFileSync(path.join(ad.baseDir, 'NOTES.md')));
  assert.strictEqual(fullHash(orig), before);
  const pr = await api.promote(ad, { confirm: true, runId: 'run-1' });
  assert.ok(pr.ok, pr.line);
  assert.match(pr.line, /re-check on the promoted project passed/);
  ad = api.load(ad.id);
  assert.strictEqual(fullHash(ad.promote.aside), before, 'the original is kept byte for byte beside the promoted project');
  assert.ok(fs.existsSync(path.join(orig, '.gitattributes')) && fs.existsSync(path.join(orig, '.claude', 'profile.lock.json')));
  // remove-original: never in the same run, never without the phrase, never early.
  const name = path.basename(orig);
  assert.match((await api.removeOriginal(ad, { method: 'recycle', phrase: 'remove original ' + name, runId: 'run-1', confirm: true })).line, /same run/);
  assert.match((await api.removeOriginal(ad, { method: 'recycle', phrase: 'remove original', runId: 'run-2', confirm: true, minAgeHours: 0 })).line, /type the phrase exactly/);
  assert.match((await api.removeOriginal(ad, { method: 'recycle', phrase: 'remove original ' + name, runId: 'run-2', confirm: true })).line, /earliest time/);
  const z = await api.removeOriginal(ad, { method: 'zip', phrase: 'remove original ' + name, runId: 'run-2', confirm: true, minAgeHours: 0 });
  assert.ok(z.ok, z.line);
  assert.strictEqual(z.removed.sha256, sha(fs.readFileSync(z.removed.zip)));
  assert.strictEqual(z.removed.hash, before, 'the archive unpacks to the original byte for byte');
  assert.ok(!fs.existsSync(ad.promote.aside), 'the original folder went to the Recycle Bin');
  assert.ok(fs.readdirSync(e.bin).some((n) => n.endsWith(path.basename(ad.promote.aside))), 'recycled, not unlinked');
  ad = api.load(ad.id);
  assert.match((await api.revert(ad, { all: true, confirm: true })).line, /restore it from the archive/);
});

test('E2 partial (module accept) keeps break-risk changes out; the function check stays same; revert --all is byte-identical', async () => {
  const e = env();
  const orig = seeded(e);
  const api = adoptApi(e);
  const st = await api.start(orig, { values: e.values });
  let ad = st.adoption;
  const ch = api.choose(ad, { accept: ['module:core-rules', 'module:docs-memory'] });
  assert.ok(ch.skipped.some((s) => s.id === 'rule-encoding-ascii-lf@app/data/catalog.csv' && s.breakRisk));
  assert.ok(ch.skipped.some((s) => s.id === 'conv-doc-size-budget@app/templates/report.md' && s.breakRisk));
  assert.ok((await api.apply(ad, { confirm: true })).ok);
  const rep = api.report(ad);
  const owned = new Set();
  for (const c of rep.changes) if (ch.ids.includes(c.id)) for (const f of c.files) if (f.file) owned.add(f.file);
  owned.add('.claude/profile.lock.json');
  const man = JSON.parse(fs.readFileSync(path.join(ad.dir, 'copy-manifest.json'), 'utf8'));
  const now = CP.manifest(ad.copyDir);
  const differ = Object.keys(now.files).filter((f) => !man.files[f] || man.files[f].sha !== now.files[f].sha).concat(Object.keys(man.files).filter((f) => !now.files[f]));
  assert.deepStrictEqual(differ.filter((f) => !f.startsWith('.git/') && !owned.has(f)), [], 'only files of the accepted changes differ');
  api.setChecks(ad, { confirm: true });
  const r = await api.check(ad, {});
  assert.deepStrictEqual(r.result.rows.map((x) => [x.id, x.verdict]), [['test', 'same'], ['build', 'same'], ['start', 'same']]);
  ad = api.load(ad.id);
  const rv = await api.revert(ad, { all: true, confirm: true });
  assert.ok(rv.ok, rv.line);
  assert.strictEqual(CP.manifest(ad.copyDir).hash, ad.copyHash, 'byte-identical to the original');
});

test('E8 revert after promote puts the original back byte for byte; git promote fast-forwards and resets back', async () => {
  const e = env();
  const orig = seeded(e);
  const before = fullHash(orig);
  const api = adoptApi(e, { runCheck: async (c) => ({ code: 0, out: '# pass 1\n# fail 0\n', ms: 1 }) });
  let ad = (await api.start(orig, { values: e.values })).adoption;
  api.choose(ad, { accept: ['all-safe', 'module:sidecar'] });
  assert.ok((await api.apply(ad, { confirm: true })).ok);
  api.setChecks(ad, { edits: ['build=', 'start='], confirm: true });
  assert.strictEqual((await api.check(ad, {})).result.verdict, 'passed');
  ad = api.load(ad.id);
  assert.ok(api.works(ad, { word: 'works' }).ok);
  assert.ok((await api.promote(ad, { confirm: true, runId: 'a' })).ok);
  ad = api.load(ad.id);
  const rv = await api.revert(ad, { all: true, confirm: true });
  assert.ok(rv.ok, rv.line);
  assert.strictEqual(fullHash(orig), before, 'the original is back byte for byte, .git included');

  // git method: the user commits the confirmed state in the copy; promote fast-forwards.
  const orig2 = seeded(e, 'demo2');
  const g = (d, args) => spawnSync('git', ['-C', d, '-c', 'user.name=Demo User', '-c', 'user.email=demo@example.invalid', '-c', 'core.hooksPath=' + path.join(d, 'no-hooks'), '-c', 'core.autocrlf=false'].concat(args), { encoding: 'utf8' });
  let ad2 = (await api.start(orig2, { values: e.values })).adoption;
  api.choose(ad2, { accept: ['all-safe'] });
  assert.ok((await api.apply(ad2, { confirm: true })).ok);
  api.setChecks(ad2, { edits: ['build=', 'start='], confirm: true });
  await api.check(ad2, {});
  ad2 = api.load(ad2.id);
  assert.ok(api.works(ad2, { word: 'works' }).ok);
  assert.match((await api.promote(ad2, { method: 'git', confirm: true })).line, /committed in the copy/);
  assert.strictEqual(g(ad2.copyDir, ['add', '-A']).status, 0);
  assert.strictEqual(g(ad2.copyDir, ['commit', '-q', '-m', 'Adopt the setup profile']).status, 0);
  const head0 = g(orig2, ['rev-parse', 'HEAD']).stdout.trim();
  const p2 = await api.promote(ad2, { method: 'git', confirm: true, recheck: false });
  assert.ok(p2.ok, p2.line);
  assert.strictEqual(g(orig2, ['rev-parse', 'HEAD']).stdout.trim(), g(ad2.copyDir, ['rev-parse', 'HEAD']).stdout.trim());
  assert.ok(fs.existsSync(path.join(orig2, '.gitattributes')));
  ad2 = api.load(ad2.id);
  assert.match((await api.removeOriginal(ad2, { method: 'recycle', phrase: 'x' })).line, /git promote keeps one folder/);
  const u = await api.revert(ad2, { all: true, confirm: true });
  assert.ok(u.ok, u.line);
  assert.strictEqual(g(orig2, ['rev-parse', 'HEAD']).stdout.trim(), head0);
});

test('cli interactive: yes / no per module and per change, break-risk second confirm, checks confirmed, works, promote', async () => {
  const e = env();
  const orig = seeded(e, 'demo-i', { git: false });
  const before = fullHash(orig);
  const asked = [];
  const answers = [
    [/Module floors/, 'n'], [/Module session/, 'a'], [/Module core-rules/, 'a'], [/may break|Include them/, 'n'],
    [/Module docs-memory/, 'c'], [/NOTES\.md/, 'y'], [/old-plan\.md/, 'y'], [/CLAUDE\.md/, 'y'], [/report\.md/, 'n'],
    [/Module sidecar/, 'n'], [/Use these checks/, 'e'], [/kind=command/, 'start='], [/Use these checks/, 'y'],
    [/Type works/, 'works'], [/Type promote/, 'promote'],
  ];
  const ask = async (q) => {
    asked.push(q);
    const i = answers.findIndex(([re]) => re.test(q));
    assert.ok(i >= 0, 'unexpected question: ' + q);
    return answers.splice(i, 1)[0][1];
  };
  const lines = [];
  const deps = { out: (s) => lines.push(s), profileDir: e.profileDir, dataDir: e.dataDir, configDir: path.join(e.root, 'cfg'), recycle: e.recycle, noDefaultAdapters: true, ask, runId: 'cli-run' };
  const code = await cli.run(['profile', 'adopt', orig, '--var', 'repo_code=DM', '--var', 'python=python', '--home', path.join(e.root, 'home')], deps);
  const text = lines.join('\n');
  assert.strictEqual(code, 0, text);
  assert.ok(asked.some((q) => /These changes may break|Include them/.test(q)) || /may break the project/.test(text));
  assert.match(text, /function check passed/);
  assert.match(text, /promoted: the conformed copy is now demo-i/);
  assert.match(text, /removing the original is a separate step for a later run/);
  assert.ok(fs.existsSync(path.join(orig, 'docs', 'archive', 'NOTES.md')));
  assert.ok(fs.readFileSync(path.join(orig, 'app', 'data', 'catalog.csv'), 'latin1').includes('\r\n'), 'the declined break-risk change was not applied');
  const l = AD.listAdoptions(path.join(e.dataDir, 'adopt'));
  const ad = AD.loadAdoption(path.join(e.dataDir, 'adopt'), l[0].id);
  assert.strictEqual(fullHash(ad.promote.aside), before);
  lines.length = 0;
  const c2 = await cli.run(['profile', 'adopt', 'remove-original', ad.id, '--method', 'recycle', '--confirm', 'remove original demo-i', '--apply', '--yes', '--home', path.join(e.root, 'home')], Object.assign({}, deps, { runId: 'cli-run' }));
  assert.strictEqual(c2, 1);
  assert.match(lines.join('\n'), /same run/);
});
