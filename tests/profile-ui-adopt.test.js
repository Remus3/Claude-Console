'use strict';
// INTEGRATE-2 (c): the adopt screens' routes (server/adopt-routes.js) driving the REAL
// L3x facade (installer/profile-adopt.js openAdopt) over HTTP, on the seeded
// non-conforming demo (tools/demo-adopt-seed.js, generated into a temp dir): start +
// report, choose, apply (dry run first), the function check with bisect, revert per
// change, the "works" word pinned to the copy hash, the promote gate refusals, promote,
// and remove-original refused in the same run. The original stays byte-identical until
// promote.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tmpdir } = require('./helpers');
const CP = require('../installer/profile-copy');
const AD = require('../installer/profile-adopt');
const SEED = require('../tools/demo-adopt-seed');
const { createAdoptRoutes } = require('../server/adopt-routes');

const MIN = path.join(__dirname, 'fixtures', 'profile-min');
const ALL = ['win32', 'darwin', 'linux'];
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// The L0 fixture plus the modules whose rules adopt carries out (as profile-adopt.test.js).
function adoptProfile(root) {
  const dir = path.join(root, 'profile');
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

function world(extra) {
  const root = tmpdir('cc-pui-adopt-');
  const dataDir = path.join(root, 'data');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  let n = 0;
  const recycle = async (p) => { fs.renameSync(p, path.join(bin, (n++) + '-' + path.basename(p))); return true; };
  const demo = path.join(root, 'demo');
  SEED.seed(demo);
  const profile = Object.assign({ profileDir: adoptProfile(root), dataDir, deps: { recycle }, runId: 'srv-test-run',
    projects: () => [{ id: 'demo', name: 'demo', dir: demo }] }, extra || {});
  return { root, dataDir, demo, profile };
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { try { resolve(c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}); } catch (e) { reject(e); } }); });

async function withServer(wd, fn) {
  const routes = createAdoptRoutes({ send, readBody, profile: wd.profile });
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!(await routes(req, res, url.pathname, req.method, url))) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const seen = [];
  const c = async (m, body) => {
    const r = await fetch('http://127.0.0.1:' + srv.address().port + '/api/profile/adopt', { method: m, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    seen.push(text);
    return { status: r.status, body: JSON.parse(text), text };
  };
  try { await fn(c, seen); } finally { srv.close(); }
}

const VALUES = { repo_code: 'DM', python: 'python' };

test('adopt routes: capability, refusals, start answers the real report shape without absolute paths, the original untouched', async () => {
  const wd = world();
  const before = CP.treeHash(wd.demo);
  await withServer(wd, async (c, seen) => {
    assert.deepStrictEqual((await c('GET')).body, { available: true });
    assert.strictEqual((await c('POST', { op: 'rm -rf' })).status, 400);
    assert.match((await c('POST', { op: 'start' })).body.line, /refused: pick a project/);
    assert.match((await c('POST', { op: 'start', project: 'nope' })).body.line, /refused: pick a project/);
    assert.match((await c('POST', { op: 'choose', id: '../x' })).body.line, /refused: name the adoption/);
    const st = (await c('POST', { op: 'start', project: 'demo', values: VALUES })).body;
    assert.strictEqual(st.ok, true, st.line);
    assert.match(st.adoption.id, /^demo-\d{8}-\d{6}/);
    assert.strictEqual(st.adoption.project, 'demo');
    assert.strictEqual(st.adoption.status, 'scanned');
    // The real scan() shape: counts, modules[].items[] rows with changes, flat changes.
    assert.ok(st.report.counts && Array.isArray(st.report.modules) && Array.isArray(st.report.changes));
    const rows = st.report.modules.flatMap((m) => m.items);
    const enc = rows.find((r) => r.item === 'rule-encoding-ascii-lf');
    assert.strictEqual(enc.status, 'differs');
    const csv = st.report.changes.find((x) => x.id === 'rule-encoding-ascii-lf@app/data/catalog.csv');
    assert.strictEqual(csv.breakRisk.class, 'crlf-required');
    assert.strictEqual(csv.default, false, 'a predicted break is unchecked by default');
    assert.ok(csv.files[0].orig.length > 0, 'line ranges in the original');
    assert.ok(st.report.changes.some((x) => x.reportOnly && x.item === 'floor-secrets-never-echoed'));
    for (const t of seen) assert.ok(!t.includes(wd.demo) && !t.includes(wd.dataDir) && !t.includes(JSON.stringify(wd.demo).slice(1, -1)), 'no absolute path in an answer');
    const s = SEED.fakeSecrets();
    for (const t of seen) for (const v of Object.values(s)) assert.ok(!t.includes(v), 'a secret-shaped value is never echoed');
    const ld = (await c('POST', { op: 'load', id: st.adoption.id })).body;
    assert.strictEqual(ld.adoption.id, st.adoption.id);
    assert.strictEqual(ld.report.changes.length, st.report.changes.length);
    const ls = (await c('POST', { op: 'list' })).body;
    assert.deepStrictEqual(ls.adoptions.map((a) => a.id), [st.adoption.id]);
  });
  assert.strictEqual(CP.treeHash(wd.demo), before, 'the original (.git included) is byte-identical');
});

test('adopt routes: choose, apply, check FAILED + bisect, revert each breaker, works pinned to the copy, promote gates, promote, remove-original refused in the same run', async () => {
  const wd = world();
  const before = CP.treeHash(wd.demo);
  await withServer(wd, async (c) => {
    const st = (await c('POST', { op: 'start', project: 'demo', values: VALUES })).body;
    const id = st.adoption.id;
    const ch = (await c('POST', { op: 'choose', id, accept: ['all'] })).body;
    assert.strictEqual(ch.ok, true, ch.line);
    assert.ok(ch.ids.includes('rule-encoding-ascii-lf@app/data/catalog.csv') && ch.ids.includes('conv-doc-size-budget@app/templates/report.md'));
    assert.deepStrictEqual(ch.adoption.accepted, ch.ids);
    const dry = (await c('POST', { op: 'apply', id })).body;
    assert.strictEqual(dry.dryRun, true);
    assert.match(dry.line, /^dry run/);
    assert.match((await c('POST', { op: 'check', id })).body.line, /refused: apply/);
    const ap = (await c('POST', { op: 'apply', id, confirm: true })).body;
    assert.strictEqual(ap.ok, true, ap.line);
    assert.ok(ap.diff.changed > 0 && ap.adoption.applied);
    assert.strictEqual(CP.treeHash(wd.demo), before, 'apply wrote nothing in the original');
    assert.match((await c('POST', { op: 'check', id })).body.line, /refused: confirm the checks/);
    const prop = (await c('POST', { op: 'setChecks', id })).body;
    assert.strictEqual(prop.checks.confirmed, false);
    assert.ok(prop.checks.list.some((x) => x.id === 'test'));
    const conf = (await c('POST', { op: 'setChecks', id, edits: ['build=', 'start='], confirm: true })).body;
    assert.strictEqual(conf.checks.confirmed, true);
    assert.match((await c('POST', { op: 'works', id, word: 'works' })).body.line, /refused: run the function check/);
    assert.match((await c('POST', { op: 'promote', id, confirm: true })).body.line, /^refused/, 'no promote before works');
    let k = (await c('POST', { op: 'check', id })).body;
    assert.strictEqual(k.result.verdict, 'FAILED', JSON.stringify(k.result.rows.map((x) => [x.id, x.verdict])));
    assert.strictEqual(k.ok, true);
    assert.strictEqual(k.code, 1);
    const row = k.result.rows.find((x) => x.id === 'test');
    assert.strictEqual(row.verdict, 'WORSE');
    assert.ok(row.original && typeof row.original.code === 'number' && row.copy && Array.isArray(row.newlyFailing));
    const culprits = k.result.bisect[0].culprits.map((x) => x.id).sort();
    assert.deepStrictEqual(culprits, ['conv-doc-size-budget@app/templates/report.md', 'rule-encoding-ascii-lf@app/data/catalog.csv']);
    assert.match((await c('POST', { op: 'works', id, word: 'works' })).body.line, /FAILED/);
    assert.match((await c('POST', { op: 'revert', id, change: culprits[0] })).body.line, /^dry run/);
    for (const x of culprits) { const rv = (await c('POST', { op: 'revert', id, change: x, confirm: true })).body; assert.strictEqual(rv.ok, true, rv.line); }
    k = (await c('POST', { op: 'check', id })).body;
    assert.strictEqual(k.result.verdict, 'passed', JSON.stringify(k.result.rows.map((x) => [x.id, x.verdict, x.why])));
    assert.strictEqual(k.adoption.lastCheck.hash, k.result.hash);
    assert.match((await c('POST', { op: 'works', id, word: 'yes' })).body.line, /type the word works/);
    const wk = (await c('POST', { op: 'works', id, word: 'works' })).body;
    assert.strictEqual(wk.ok, true, wk.line);
    assert.strictEqual(wk.confirm.hash, k.result.hash);
    // A stale confirmation: the copy changed after "works".
    const ad = AD.openAdopt({ engine: null, dataDir: wd.dataDir }).load(id);
    const readme = path.join(ad.copyDir, 'README.md');
    const keep = fs.readFileSync(readme);
    fs.appendFileSync(readme, 'edited\n');
    assert.match((await c('POST', { op: 'promote', id, confirm: true })).body.line, /changed after you confirmed/);
    fs.writeFileSync(readme, keep);
    assert.match((await c('POST', { op: 'promote', id })).body.line, /^dry run/);
    assert.strictEqual(CP.treeHash(wd.demo), before, 'the original is untouched until promote');
    const pr = (await c('POST', { op: 'promote', id, method: 'swap', confirm: true })).body;
    assert.strictEqual(pr.ok, true, pr.line);
    assert.strictEqual(pr.adoption.status, 'promoted');
    const aside = AD.openAdopt({ engine: null, dataDir: wd.dataDir }).load(id).promote.aside;
    assert.strictEqual(CP.treeHash(aside), before, 'the original is kept byte for byte beside the promoted project');
    const rm = (await c('POST', { op: 'removeOriginal', id, method: 'recycle', phrase: 'remove original demo', confirm: true })).body;
    assert.match(rm.line, /same run/);
    assert.ok(fs.existsSync(aside), 'nothing removed');
  });
});

test('adopt routes: off when the build has no adopt module or no profile', async () => {
  const wd = world({ adopt: null });
  await withServer(wd, async (c) => {
    assert.deepStrictEqual((await c('GET')).body, { available: false });
    assert.strictEqual((await c('POST', { op: 'list' })).status, 501);
  });
});
