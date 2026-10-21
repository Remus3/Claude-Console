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

// ---- OH-RECIPE: Once Human (Steam 2139460). Config lives in the install folder
// (Documents\GraphicConfig.xml), written by the game on first launch.

function ohEnv(opts) {
  opts = opts || {};
  const d = tmpdir('cc-oh-');
  const install = path.join(d, 'steamapps', 'common', 'Once Human');
  fs.mkdirSync(path.join(install, 'Documents'), { recursive: true });
  const cfg = path.join(install, 'Documents', 'GraphicConfig.xml');
  if (opts.config !== false) fs.copyFileSync(path.join(FIX, 'once-human', 'GraphicConfig.xml'), cfg);
  return { d, install, cfg, env: { LOCALAPPDATA: path.join(d, 'Local') }, inventory: { games: [{ appid: '2139460', install }] } };
}

function nvSpec() {
  const spec = JSON.parse(JSON.stringify(SPEC));
  spec.gpu.name = 'NVIDIA GeForce RTX 5070';
  return spec;
}

test('recipe registry: Once Human is seeded with sourced GraphicConfig.xml keys only', () => {
  const oh = recipes.get('once-human');
  assert.ok(oh);
  assert.deepStrictEqual(recipes.validate(oh), []);
  assert.strictEqual(oh.steam_appid, '2139460');
  assert.ok(oh.processes.includes('ONCE_HUMAN.exe'));
  assert.strictEqual(oh.files.graphics.format, 'xml');
  assert.match(oh.files.graphics.path, /^%STEAMAPP_2139460%\\Documents\\GraphicConfig\.xml$/);
  assert.match(oh.missing, /launch the game once to generate its config/);
  assert.deepStrictEqual(oh.changes.map((c) => c.key).sort(), ['setting_enable_d3d12', 'setting_nvidia_reflex', 'setting_resolution']);
  for (const c of oh.changes) assert.ok(c.expect instanceof RegExp, c.id + ' verifies the current value before proposing');
  assert.ok(recipes.validate(Object.assign({}, oh, { missing: '' })).some((e) => /missing/.test(e)));
});

test('games advisor: Once Human proposals from the spec (NVIDIA GPU, 2560x1440), all opt-in', () => {
  const { env, inventory, cfg } = ohEnv();
  const out = adv.advise({ spec: nvSpec(), inventory, env, now: NOW });
  const oh = out.proposals.filter((p) => p.app === 'once-human');
  const by = Object.fromEntries(oh.map((p) => [p.id, p]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['once-human.d3d12', 'once-human.reflex', 'once-human.resolution']);
  assert.strictEqual(by['once-human.d3d12'].to, '1');
  assert.strictEqual(by['once-human.reflex'].to, '1');
  assert.strictEqual(by['once-human.resolution'].to, '(2560, 1440)');
  assert.ok(by['once-human.reflex'].requires.includes('once-human.d3d12'));
  assert.ok(oh.every((p) => p.kind === 'app-config' && p.default === 'off' && p.format === 'xml'));
  assert.ok(oh.every((p) => p.target.file === cfg), 'install folder from the Steam inventory');
  assert.ok(oh.every((p) => p.processes.includes('ONCE_HUMAN.exe')));
  assert.ok(!out.findings.some((f) => f.id === 'once-human.launch-once'));
});

test('games advisor: Once Human Reflex only on an NVIDIA GPU', () => {
  const { env, inventory } = ohEnv();
  const amd = JSON.parse(JSON.stringify(SPEC));
  amd.gpu.name = 'AMD Radeon RX 7800 XT';
  const ids = adv.advise({ spec: amd, inventory, env, now: NOW }).proposals.map((p) => p.id);
  assert.ok(ids.includes('once-human.d3d12'));
  assert.ok(!ids.includes('once-human.reflex'), 'not an NVIDIA GPU');
  assert.ok(adv.advise({ spec: nvSpec(), inventory, env, now: NOW }).proposals.some((p) => p.id === 'once-human.reflex'));
});

test('games advisor: Once Human installed but never launched gives a launch-once finding, no change', () => {
  const { env, inventory, cfg } = ohEnv({ config: false });
  const out = adv.advise({ spec: SPEC, inventory, env, now: NOW });
  assert.strictEqual(out.proposals.filter((p) => p.app === 'once-human').length, 0);
  const f = out.findings.find((x) => x.id === 'once-human.launch-once');
  assert.ok(f, 'finding present');
  assert.match(f.text, /launch the game once to generate its config/);
  assert.deepStrictEqual(f.files, [cfg]);
  assert.strictEqual(adv.preview(out).rows.length, 0, 'a finding is never an edit');
});

test('games advisor: Once Human not installed gives nothing at all', () => {
  const out = adv.advise({ spec: SPEC, inventory: { games: [] }, env: { LOCALAPPDATA: tmpdir('cc-oh-') }, now: NOW });
  assert.strictEqual(out.proposals.filter((p) => p.app === 'once-human').length, 0);
  assert.ok(!out.findings.some((f) => f.id === 'once-human.launch-once'));
});

test('games advisor: Once Human install folder falls back to install_default without an inventory', () => {
  const { d, cfg } = ohEnv();
  const pf = tmpdir('cc-oh-pf-');
  const install = path.join(pf, 'Steam', 'steamapps', 'common', 'Once Human');
  fs.mkdirSync(path.join(install, 'Documents'), { recursive: true });
  fs.copyFileSync(cfg, path.join(install, 'Documents', 'GraphicConfig.xml'));
  const out = adv.advise({ spec: SPEC, inventory: null, env: { 'ProgramFiles(x86)': pf, LOCALAPPDATA: path.join(d, 'Local') }, now: NOW });
  const oh = out.proposals.filter((p) => p.app === 'once-human');
  assert.ok(oh.length > 0);
  assert.ok(oh.every((p) => p.target.file === path.join(install, 'Documents', 'GraphicConfig.xml')));
});

test('games advisor: a Once Human key missing from the file or holding an unexpected value is not proposed', () => {
  const { env, inventory, cfg } = ohEnv();
  const t = fs.readFileSync(cfg, 'utf8');
  fs.writeFileSync(cfg, t.replace(/\s*<setting_nvidia_reflex>0<\/setting_nvidia_reflex>/, '').replace('<setting_enable_d3d12>0<', '<setting_enable_d3d12>auto<'));
  const ids = adv.advise({ spec: nvSpec(), inventory, env, now: NOW }).proposals.map((p) => p.id);
  assert.ok(!ids.includes('once-human.reflex'), 'absent key');
  assert.ok(!ids.includes('once-human.d3d12'), 'value outside the documented range');
  assert.ok(ids.includes('once-human.resolution'));
});

test('games advisor: Once Human Reflex already on (1) or on + boost (2) is not proposed', () => {
  const { env, inventory, cfg } = ohEnv();
  const t = fs.readFileSync(cfg, 'utf8');
  for (const v of ['1', '2']) {
    fs.writeFileSync(cfg, t.replace('<setting_nvidia_reflex>0<', '<setting_nvidia_reflex>' + v + '<'));
    const ids = adv.advise({ spec: nvSpec(), inventory, env, now: NOW }).proposals.map((p) => p.id);
    assert.ok(!ids.includes('once-human.reflex'), 'value ' + v + ' is already enabled');
    assert.ok(ids.includes('once-human.d3d12'));
    assert.strictEqual(ac.getValue('xml', fs.readFileSync(cfg, 'utf8'), 'setting_nvidia_reflex').value, v, 'file untouched');
  }
});

test('end to end: Once Human preview, accept, read back, revert to a byte-identical file', async () => {
  const { env, inventory, cfg } = ohEnv();
  const before = sha(cfg);
  const data = tmpdir('cc-mach-');
  const advice = adv.advise({ spec: nvSpec(), inventory, env, now: NOW });
  const pv = adv.preview(advice);
  assert.match(pv.text, /GraphicConfig\.xml/);
  assert.strictEqual(pv.rows.find((r) => r.id === 'once-human.d3d12').status, 'change');
  const r = await adv.applyAdvice(data, advice, { accept: ['once-human.d3d12', 'once-human.reflex', 'once-human.resolution'], isRunning: notRunning, now: NOW });
  assert.strictEqual(r.ok, true, r.error);
  const text = fs.readFileSync(cfg, 'utf8');
  assert.strictEqual(ac.getValue('xml', text, 'setting_enable_d3d12').value, '1');
  assert.strictEqual(ac.getValue('xml', text, 'setting_nvidia_reflex').value, '1');
  assert.strictEqual(ac.getValue('xml', text, 'setting_resolution').value, '(2560, 1440)');
  assert.strictEqual(ac.getValue('xml', text, 'setting_frame_insertion').value, '0', 'no recipe change touches it');
  const baks = fs.readdirSync(path.dirname(cfg)).filter((n) => /^GraphicConfig\.xml\.bak-/.test(n));
  assert.strictEqual(baks.length, 1, 'backup beside the file before the write');
  const back = await adv.revertAdvice(r.txDir, { isRunning: notRunning });
  assert.strictEqual(back.ok, true);
  assert.strictEqual(sha(cfg), before);
});

test('applyAdvice refuses while Once Human runs (never touch a running game)', async () => {
  const { env, inventory, cfg } = ohEnv();
  const before = sha(cfg);
  const data = tmpdir('cc-mach-');
  const advice = adv.advise({ spec: SPEC, inventory, env, now: NOW });
  const r = await adv.applyAdvice(data, advice, { accept: ['once-human.d3d12'], isRunning: async () => ['ONCE_HUMAN.exe'], now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /running/);
  assert.strictEqual(sha(cfg), before);
});
