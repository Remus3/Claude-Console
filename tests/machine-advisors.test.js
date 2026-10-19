'use strict';
// CON-013 L9: optimisation advisors and the per-app recipe registry. Proposals are
// opt-in per change, previewed, applied through profile-appconfig into TEMP COPIES of
// the fixtures, and revertable.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpdir } = require('./helpers');
const scan = require('../installer/machine-scan');
const adv = require('../installer/machine-advisors');
const recipes = require('../installer/machine-advisors-recipes');
const ac = require('../installer/profile-appconfig');

const FIX = path.join(__dirname, 'fixtures', 'machine');
const SPEC = scan.parseSpec(fs.readFileSync(path.join(FIX, 'cim-spec.json'), 'utf8'));
const NOW = () => Date.UTC(2026, 9, 18, 15);
const notRunning = async () => [];
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function civEnv() {
  const d = tmpdir('cc-adv-');
  const local = path.join(d, 'Local');
  const civ = path.join(local, 'Firaxis Games', "Sid Meier's Civilization VI");
  fs.mkdirSync(civ, { recursive: true });
  for (const f of ['GraphicsOptions.txt', 'UserOptions.txt']) fs.copyFileSync(path.join(FIX, 'civ6', f), path.join(civ, f));
  return { d, civ, env: { LOCALAPPDATA: local } };
}

test('recipe registry: every recipe is well formed; Civ VI is seeded with the recorded keys', () => {
  const ids = recipes.list().map((r) => r.id);
  assert.ok(ids.includes('civ6'));
  for (const r of recipes.list()) {
    const errs = recipes.validate(r);
    assert.deepStrictEqual(errs, [], r.id + ': ' + errs.join('; '));
  }
  const civ = recipes.get('civ6');
  assert.strictEqual(civ.steam_appid, '289070');
  assert.ok(civ.processes.includes('CivilizationVI.exe'));
  assert.match(civ.files.graphics.path, /%LOCALAPPDATA%\\Firaxis Games\\/);
  assert.match(civ.files.user.path, /UserOptions\.txt$/);
  const keys = civ.changes.map((c) => c.key);
  for (const k of ['Video.MSAA', 'Terrain.LowQualityTerrainShader', 'General.UseLowQualityWaterShader', 'AO.EnableAO', 'Video.RefreshRateInHz', 'Gameplay.QuickMovement', 'Gameplay.QuickCombat']) assert.ok(keys.includes(k), 'civ6 recipe has ' + k);
  for (const c of civ.changes) assert.ok(c.why && c.title, c.id + ' has title and why');
});

test('validate rejects a malformed recipe (unknown file, missing why, bad format)', () => {
  const errs = recipes.validate({ id: 'x', title: 'X', processes: [], files: { a: { path: 'C:\\x.cfg' } }, changes: [{ id: 'c', file: 'b', key: 'k', to: '1' }] });
  assert.ok(errs.some((e) => /format/.test(e)));
  assert.ok(errs.some((e) => /unknown file b/.test(e)));
  assert.ok(errs.some((e) => /why/.test(e)));
});

test('games advisor: Civ VI proposals from the spec (12 GB VRAM, 240 Hz display), all opt-in', () => {
  const { env } = civEnv();
  const out = adv.advise({ spec: SPEC, inventory: { games: [{ appid: '289070' }], apps: [] }, env, now: NOW });
  const civ = out.proposals.filter((p) => p.app === 'civ6');
  const by = Object.fromEntries(civ.map((p) => [p.id, p]));
  assert.strictEqual(by['civ6.msaa'].to, '4');
  assert.strictEqual(by['civ6.refresh-rate'].to, '240');
  assert.strictEqual(by['civ6.quick-combat'].to, '1');
  assert.ok(civ.every((p) => p.kind === 'app-config' && p.default === 'off'), 'every change is opt-in');
  assert.ok(civ.every((p) => p.processes.includes('CivilizationVI.exe')));
  assert.ok(by['civ6.msaa'].requires.includes('civ6.perf-override'));
  assert.ok(civ.every((p) => p.target.file.startsWith(env.LOCALAPPDATA)), 'env expanded');
});

test('games advisor: a small GPU gets the low-cost choices and no AO', () => {
  const { env } = civEnv();
  const small = JSON.parse(JSON.stringify(SPEC));
  small.gpu.vram_gb = 3; small.gpus[0].vram_gb = 3;
  const ids = adv.advise({ spec: small, inventory: { games: [{ appid: '289070' }] }, env, now: NOW }).proposals.map((p) => p.id);
  assert.ok(!ids.includes('civ6.ao'));
  assert.ok(!ids.includes('civ6.msaa'));
  assert.ok(ids.includes('civ6.quick-movement'), 'gameplay changes do not depend on the GPU');
});

test('games advisor: nothing proposed when the game is not installed or its files are absent', () => {
  const none = adv.advise({ spec: SPEC, inventory: { games: [] }, env: { LOCALAPPDATA: tmpdir('cc-adv-') }, now: NOW });
  assert.strictEqual(none.proposals.filter((p) => p.app === 'civ6').length, 0);
});

test('machine advisor: RAM below its rated speed and low disk are findings, not changes', () => {
  const out = adv.advise({ spec: SPEC, inventory: {}, env: {}, now: NOW });
  const t = out.findings.map((f) => f.id);
  assert.ok(t.includes('machine.ram-speed'), 'DDR rated 5600 running 5200');
  assert.ok(t.includes('machine.disk-free:C:'), 'C: at 15% free');
  assert.ok(!t.includes('machine.disk-free:D:'));
});

test('end to end: preview, accept two changes, read back, revert to byte-identical files', async () => {
  const { civ, env } = civEnv();
  const g = path.join(civ, 'GraphicsOptions.txt');
  const u = path.join(civ, 'UserOptions.txt');
  const before = [sha(g), sha(u)];
  const data = tmpdir('cc-mach-');
  const advice = adv.advise({ spec: SPEC, inventory: { games: [{ appid: '289070' }] }, env, now: NOW });
  const file = adv.saveAdvice(data, advice);
  assert.ok(scan.isMachinePath(file, data));
  const rows = adv.preview(advice);
  assert.match(rows.text, /GraphicsOptions\.txt \[Video\] MSAA: 1 -> 4/);
  assert.match(rows.text, /UserOptions\.txt \[Gameplay\] QuickCombat: 0 -> 1/);
  assert.ok(rows.rows.find((r) => r.id === 'civ6.perf-override').status === 'same', 'already -1 in the fixture');
  const r = await adv.applyAdvice(data, advice, { accept: ['civ6.msaa', 'civ6.quick-combat'], isRunning: notRunning, now: NOW });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(ac.getValue('ini', fs.readFileSync(g, 'utf8'), 'Video.MSAA').value, '4');
  assert.strictEqual(ac.getValue('ini', fs.readFileSync(g, 'utf8'), 'AO.EnableAO').value, '0', 'not accepted');
  assert.strictEqual(ac.getValue('ini', fs.readFileSync(u, 'utf8'), 'Gameplay.QuickCombat').value, '1');
  assert.ok(scan.isMachinePath(r.txDir, data), 'the transaction lives under the machine folder');
  const back = await adv.revertAdvice(r.txDir, { isRunning: notRunning });
  assert.strictEqual(back.ok, true);
  assert.deepStrictEqual([sha(g), sha(u)], before);
});

test('applyAdvice refuses a change whose requirement is neither accepted nor already in place', async () => {
  const { civ, env } = civEnv();
  const g = path.join(civ, 'GraphicsOptions.txt');
  fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replace('PerformanceImpact -1', 'PerformanceImpact 2'));
  const before = sha(g);
  const data = tmpdir('cc-mach-');
  const advice = adv.advise({ spec: SPEC, inventory: { games: [{ appid: '289070' }] }, env, now: NOW });
  const r = await adv.applyAdvice(data, advice, { accept: ['civ6.msaa'], isRunning: notRunning, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /civ6\.msaa needs civ6\.perf-override/);
  assert.strictEqual(sha(g), before);
  const ok = await adv.applyAdvice(data, advice, { accept: ['civ6.msaa', 'civ6.perf-override'], isRunning: notRunning, now: NOW });
  assert.strictEqual(ok.ok, true, ok.error);
});

test('applyAdvice refuses while Civ VI runs (ToS floor: never touch a running game)', async () => {
  const { civ, env } = civEnv();
  const g = path.join(civ, 'GraphicsOptions.txt');
  const before = sha(g);
  const data = tmpdir('cc-mach-');
  const advice = adv.advise({ spec: SPEC, inventory: { games: [{ appid: '289070' }] }, env, now: NOW });
  const r = await adv.applyAdvice(data, advice, { accept: ['civ6.msaa'], isRunning: async () => ['CivilizationVI_DX12.exe'], now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /running/);
  assert.strictEqual(sha(g), before);
});
