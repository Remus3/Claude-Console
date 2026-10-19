'use strict';
// CON-013 L9: machine-health steps in server/health.js (mach-findings-rules, generic
// subset): Temp hygiene, disk free, scratch and files outside the repo. Report-only;
// a cleanup happens only on consent, per suggestion, through the Recycle Bin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir, writeFile } = require('./helpers');
const health = require('../server/health');

const NOW = Date.UTC(2026, 9, 18, 15);
const H = 3600 * 1000;

function world() {
  const d = tmpdir('cc-mh-');
  const repo = path.join(d, 'repo');
  const temp = path.join(d, 'Temp');
  const outside = path.join(d, 'scratchpad');
  writeFile(path.join(repo, 'src', 'a.js'), 'x');
  writeFile(path.join(repo, 'scratch_tmp', 'f1.txt'), 'abc', NOW - 48 * H);
  writeFile(path.join(repo, 'debug.log'), 'log', NOW - 48 * H);
  writeFile(path.join(repo, 'out (copy).txt'), 'c', NOW - 48 * H);
  writeFile(path.join(repo, 'notes.md'), 'keep', NOW - 48 * H);
  writeFile(path.join(temp, 'pytest-of-x', 'pytest-1', 'f.txt'), 'p', NOW - 5 * H);
  writeFile(path.join(temp, 'cc-test-abc', 'f.txt'), 'p', NOW - 30 * 60 * 1000);
  writeFile(path.join(temp, 'other.bin'), 'o', NOW - 100 * H);
  writeFile(path.join(outside, 'old.json'), 'o', NOW - 10 * 24 * H);
  writeFile(path.join(outside, 'new.json'), 'n', NOW - 1 * H);
  // pytest dirs: set the dir mtime too
  const t = new Date(NOW - 5 * H);
  fs.utimesSync(path.join(temp, 'pytest-of-x'), t, t);
  const t2 = new Date(NOW - 30 * 60 * 1000);
  fs.utimesSync(path.join(temp, 'cc-test-abc'), t2, t2);
  // git status --porcelain --ignored, faked: what git would list for the repo
  const untracked = async (r) => (r === repo ? ['scratch_tmp/', 'debug.log', 'out (copy).txt', 'notes.md'] : []);
  return { d, repo, temp, outside, untracked };
}

test('MACHINE_STEPS: fixed ids, off by default, no step deletes anything', () => {
  assert.deepStrictEqual(health.MACHINE_STEPS.map((s) => s.id), ['machine.temp', 'machine.disk', 'machine.scratch']);
  for (const s of health.MACHINE_STEPS) {
    assert.strictEqual(s.default, false, s.id);
    assert.strictEqual(s.deletes, null, s.id);
  }
  assert.ok(!health.CORE_STEPS.some((s) => s.id.startsWith('machine.')), 'core steps unchanged');
});

test('cleanupCandidates: repo scratch (untracked only), old Temp test dirs, old files outside the repo', async () => {
  const w = world();
  const c = await health.cleanupCandidates({ repos: [w.repo], temp: w.temp, outside: [w.outside], untracked: w.untracked, now: () => NOW });
  const names = c.map((x) => path.relative(w.d, x.path)).sort();
  assert.deepStrictEqual(names, [
    path.join('Temp', 'pytest-of-x'),
    path.join('repo', 'debug.log'),
    path.join('repo', 'out (copy).txt'),
    path.join('repo', 'scratch_tmp'),
    path.join('scratchpad', 'old.json'),
  ].sort());
  assert.ok(c.every((x) => /^[a-z]+:[0-9a-f]{12}$/.test(x.id) && x.why && x.where));
  assert.ok(!names.includes(path.join('Temp', 'cc-test-abc')), 'a test dir younger than the cutoff may belong to a live suite');
});

test('applyCleanup needs consent and accepted ids; it only recycles, never unlinks', async () => {
  const w = world();
  const c = await health.cleanupCandidates({ repos: [w.repo], temp: w.temp, outside: [w.outside], untracked: w.untracked, now: () => NOW });
  const seen = [];
  const recycle = async (p) => { seen.push(p); };
  const no = await health.applyCleanup(c, [c[0].id], { recycle });
  assert.strictEqual(no.ok, false);
  assert.match(no.error, /consent/);
  const none = await health.applyCleanup(c, [], { consent: true, recycle });
  assert.strictEqual(none.ok, false);
  const bad = await health.applyCleanup(c, ['repo:000000000000'], { consent: true, recycle });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.error, /unknown/);
  assert.strictEqual(seen.length, 0);
  const ok = await health.applyCleanup(c, [c[0].id, c[1].id], { consent: true, recycle });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(seen, [c[0].path, c[1].path]);
  assert.ok(fs.existsSync(c[0].path), 'the fake recycle moved nothing: no direct delete happened');
  const failing = await health.applyCleanup(c, [c[2].id], { consent: true, recycle: async () => { throw new Error('bin full'); } });
  assert.strictEqual(failing.ok, false);
  assert.deepStrictEqual(failing.failed, [c[2].id]);
});

test('tempCensus counts files and flags the alarm line', () => {
  const w = world();
  const r = health.tempCensus(w.temp);
  assert.strictEqual(r.files, 3);
  assert.strictEqual(health.tempCensus(w.temp, { alarm: 2 }).alarm, true);
  assert.strictEqual(health.tempCensus(path.join(w.d, 'none')).files, 0);
});

test('machineRunners: report-only results through the shared result shape', async () => {
  const w = world();
  const run = health.machineRunners({
    temp: w.temp, repos: [w.repo], outside: [w.outside], untracked: w.untracked, now: () => NOW,
    disks: async () => [{ id: 'C:', size: 100, free: 10 }, { id: 'D:', size: 100, free: 80 }],
  });
  const t = await run['machine.temp']();
  assert.strictEqual(t.ok, true);
  assert.strictEqual(t.numbers.files, 3);
  assert.strictEqual(t.deleted, 0);
  const dk = await run['machine.disk']();
  assert.strictEqual(dk.findings.length, 1);
  assert.match(dk.findings[0], /C: 10% free/);
  const s = await run['machine.scratch']();
  assert.strictEqual(s.numbers.candidates, 5);
  assert.strictEqual(s.deleted, 0);
  assert.match(s.summary, /nothing deleted/);
  assert.ok(fs.existsSync(path.join(w.repo, 'debug.log')));
});

test('HealthRunner runs machine steps when they are passed in as core runners', async () => {
  const w = world();
  const core = Object.assign({}, health.machineRunners({ temp: w.temp, repos: [], outside: [], untracked: w.untracked, now: () => NOW, disks: async () => [] }));
  const steps = [...health.CORE_STEPS, ...health.MACHINE_STEPS];
  const r = new health.HealthRunner({ core, steps, suiteHolders: () => 0 });
  assert.deepStrictEqual(r.allowlist(), ['machine.temp', 'machine.disk', 'machine.scratch']);
  const st = await r.start(['machine.temp']);
  assert.strictEqual(st.status, 202);
  while (r.current) await new Promise((res) => setTimeout(res, 5));
  assert.strictEqual(r.last.status, 'done');
});
