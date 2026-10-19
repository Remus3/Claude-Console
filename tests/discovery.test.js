'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { discoverProjects, isRepoRoot } = require('../server/discovery');
const { makeFixture, gitInit } = require('./helpers');

test('discovers only git repo roots directly under the scan root', async () => {
  const fx = makeFixture();
  const ps = await discoverProjects(fx.overrides);
  const names = ps.map((p) => p.name);
  assert.deepStrictEqual(names.sort(), ['Alpha', 'Beta Repo', 'Oldie']);
  assert.ok(!names.includes('NotARepo'));
});

test('applies config overrides: order, code, retired sorts last', async () => {
  const fx = makeFixture();
  const ps = await discoverProjects(fx.overrides);
  assert.strictEqual(ps[0].name, 'Alpha');
  assert.strictEqual(ps[0].code, 'AL');
  assert.strictEqual(ps[ps.length - 1].name, 'Oldie');
  assert.strictEqual(ps[ps.length - 1].retired, true);
  assert.strictEqual(ps.find((p) => p.name === 'Beta Repo').id, 'beta-repo');
});

test('hidden and excluded dirs are skipped; extraProjects are added', async () => {
  const fx = makeFixture();
  const extra = path.join(fx.root, 'elsewhere', 'Gamma');
  gitInit(extra);
  const cfg = Object.assign({}, fx.overrides, {
    excludeDirs: ['beta repo'],
    projects: { Oldie: { hidden: true } },
    extraProjects: [extra],
  });
  const names = (await discoverProjects(cfg)).map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['Alpha', 'Gamma']);
});

test('a subdirectory of a repo is not a repo root', async () => {
  const fx = makeFixture();
  assert.strictEqual(await isRepoRoot(path.join(fx.scan, 'Alpha')), true);
  assert.strictEqual(await isRepoRoot(path.join(fx.scan, 'Alpha', 'ops')), false);
  assert.strictEqual(await isRepoRoot(path.join(fx.scan, 'NotARepo')), false);
});

test('a junction to a repo elsewhere is discovered once (MIG-1 moves to E:)', async () => {
  const fx = makeFixture();
  const moved = path.join(fx.root, 'otherdrive', 'Moved Repo');
  gitInit(moved);
  try {
    fs.symlinkSync(moved, path.join(fx.scan, 'Moved Repo'), 'junction');
  } catch (e) {
    return; // junctions unavailable here
  }
  const cfg = Object.assign({}, fx.overrides, { extraProjects: [moved] });
  const ps = await discoverProjects(cfg);
  assert.strictEqual(ps.filter((p) => p.name === 'Moved Repo').length, 1);
  assert.strictEqual(fs.realpathSync.native(ps.find((p) => p.name === 'Moved Repo').dir), fs.realpathSync.native(moved));
});

test('a second scan root finds a moved repo with no junction, at its real path', async () => {
  const fx = makeFixture();
  const other = path.join(fx.root, 'edrive');
  gitInit(path.join(other, 'Ebon'));
  gitInit(path.join(other, 'Alpha2'));
  fs.mkdirSync(path.join(other, 'worktrees-holder'), { recursive: true });
  let linked = true;
  try {
    fs.symlinkSync(path.join(other, 'Alpha2'), path.join(fx.scan, 'Alpha2'), 'junction');
  } catch (e) {
    linked = false;
  }
  const cfg = Object.assign({}, fx.overrides, { scanRoots: [fx.scan, other] });
  const ps = await discoverProjects(cfg);
  const names = ps.map((p) => p.name).sort();
  assert.deepStrictEqual(names, ['Alpha', 'Alpha2', 'Beta Repo', 'Ebon', 'Oldie']);
  const real = (p) => fs.realpathSync.native(p);
  assert.strictEqual(real(ps.find((p) => p.name === 'Ebon').dir), real(path.join(other, 'Ebon')));
  assert.strictEqual(ps.find((p) => p.name === 'Ebon').dir, real(path.join(other, 'Ebon')));
  if (linked) assert.strictEqual(ps.find((p) => p.name === 'Alpha2').dir, real(path.join(other, 'Alpha2')));
});

test('shipped config scan roots are absolute paths (MIG-1)', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'console.json'), 'utf8'));
  assert.ok(Array.isArray(cfg.scanRoots) && cfg.scanRoots.length > 0, JSON.stringify(cfg.scanRoots));
  for (const r of cfg.scanRoots) assert.ok(path.win32.isAbsolute(r), r);
});
