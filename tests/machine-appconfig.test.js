'use strict';
// CON-013 L9: the app-config contribution kind (addendum a.3). Every write lands in a
// temp copy of a fixture - never in a real app's config.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpdir } = require('./helpers');
const ac = require('../installer/profile-appconfig');

const FIX = path.join(__dirname, 'fixtures', 'machine');
const NOW = () => Date.UTC(2026, 9, 18, 15);
const notRunning = async () => [];

function copyFix(rel) {
  const d = tmpdir('cc-appcfg-');
  const dst = path.join(d, path.basename(rel));
  fs.copyFileSync(path.join(FIX, rel), dst);
  return { d, file: dst };
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const edit = (id, file, key, to, extra) => Object.assign({ id, kind: 'app-config', target: { file, key }, to }, extra || {});

test('formatFor picks the parser by extension, recipe format wins', () => {
  assert.strictEqual(ac.formatFor('a.xml'), 'xml');
  assert.strictEqual(ac.formatFor('a.ini'), 'ini');
  assert.strictEqual(ac.formatFor('a.cfg'), null);
  assert.strictEqual(ac.formatFor('a.json'), 'json');
  assert.strictEqual(ac.formatFor('a.vdf'), 'vdf');
  assert.strictEqual(ac.formatFor('a.acf'), 'vdf');
  assert.strictEqual(ac.formatFor('GraphicsOptions.txt', 'ini'), 'ini');
});

test('ini (Civ VI "Key value" style): get by section.key, duplicate sections resolved per key', () => {
  const text = fs.readFileSync(path.join(FIX, 'civ6', 'GraphicsOptions.txt'), 'utf8');
  assert.strictEqual(ac.getValue('ini', text, 'Video.MSAA').value, '1');
  assert.strictEqual(ac.getValue('ini', text, 'General.ForceDebugLayer').value, '0', 'second [General] section');
  assert.strictEqual(ac.getValue('ini', text, 'General.MinimapSize').value, '0.000000');
  assert.strictEqual(ac.getValue('ini', text, 'Video.Nope'), null);
  const out = ac.setValue('ini', text, 'Video.MSAA', '4');
  assert.strictEqual(ac.getValue('ini', out, 'Video.MSAA').value, '4');
  assert.strictEqual(out.split('\n').length, text.split('\n').length);
  assert.strictEqual(out.replace('MSAA 4', 'MSAA 1'), text, 'only the value changed');
});

test('ini ("key = value" style), json, xml and vdf get/set keep every other byte', () => {
  const ini = fs.readFileSync(path.join(FIX, 'formats', 'sample.ini'), 'utf8');
  assert.strictEqual(ac.getValue('ini', ini, 'Display.Height').value, '1080');
  assert.strictEqual(ac.setValue('ini', ini, 'Display.Height', '1440'), ini.replace('Height = 1080', 'Height = 1440'));
  const json = fs.readFileSync(path.join(FIX, 'formats', 'sample.json'), 'utf8');
  assert.strictEqual(ac.getValue('json', json, 'video.fps').value, 60);
  const j2 = ac.setValue('json', json, 'video.fps', 144);
  assert.strictEqual(JSON.parse(j2).video.fps, 144);
  assert.strictEqual(JSON.parse(j2).video.mode, 'windowed');
  const xml = fs.readFileSync(path.join(FIX, 'formats', 'sample.xml'), 'utf8');
  assert.strictEqual(ac.getValue('xml', xml, '_upscaleMode').value, 'Balanced');
  assert.strictEqual(ac.getValue('xml', xml, 'Audio@volume').value, '70');
  assert.strictEqual(ac.setValue('xml', xml, '_upscaleMode', 'Quality'), xml.replace('>Balanced<', '>Quality<'));
  assert.strictEqual(ac.setValue('xml', xml, 'Audio@volume', '50'), xml.replace('volume="70"', 'volume="50"'));
  const vdf = fs.readFileSync(path.join(FIX, 'formats', 'sample.vdf'), 'utf8');
  const k = 'UserLocalConfigStore/Software/Valve/Steam/SteamController_PSSupport';
  assert.strictEqual(ac.getValue('vdf', vdf, k).value, '1');
  assert.strictEqual(ac.setValue('vdf', vdf, k, '2'), vdf.replace('"SteamController_PSSupport"\t\t"1"', '"SteamController_PSSupport"\t\t"2"'));
});

test('typeOf / sameType refuse a changed type', () => {
  assert.ok(ac.sameType('1', '4'));
  assert.ok(ac.sameType('0.000000', '1.000000'));
  assert.ok(!ac.sameType('1', '1.5'));
  assert.ok(!ac.sameType('1', 'high'));
  assert.ok(ac.sameType('Balanced', 'Quality'));
  assert.ok(ac.sameType(true, false));
  assert.ok(!ac.sameType(60, '60'));
});

test('plan: change / same / refused (missing key, type change, no parser) with a preview line each', () => {
  const { file } = copyFix('civ6/GraphicsOptions.txt');
  const rows = ac.plan([
    edit('a', file, 'Video.MSAA', '4', { format: 'ini' }),
    edit('b', file, 'Video.MSAAQuality', '0', { format: 'ini' }),
    edit('c', file, 'Video.NewKey', '1', { format: 'ini' }),
    edit('d', file, 'Video.MSAA', 'max', { format: 'ini' }),
    edit('e', file + '.cfg', 'x', '1'),
  ]);
  assert.deepStrictEqual(rows.map((r) => r.status), ['change', 'same', 'refused', 'refused', 'refused']);
  assert.match(rows[2].reason, /new key/);
  assert.match(rows[3].reason, /type/);
  assert.match(ac.preview(rows), /GraphicsOptions\.txt \[Video\] MSAA: 1 -> 4/);
});

test('apply: opt-in per change - nothing is written without an accepted id', async () => {
  const { file } = copyFix('civ6/GraphicsOptions.txt');
  const before = sha(file);
  const r = await ac.apply([edit('a', file, 'Video.MSAA', '4', { format: 'ini' })], { accept: [], txDir: tmpdir('cc-tx-'), isRunning: notRunning, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /nothing accepted/);
  assert.strictEqual(sha(file), before);
});

test('apply: backs up beside the file and in tx pre/, writes only accepted keys, reads back', async () => {
  const { d, file } = copyFix('civ6/GraphicsOptions.txt');
  const orig = fs.readFileSync(file, 'utf8');
  const txDir = tmpdir('cc-tx-');
  const r = await ac.apply([
    edit('msaa', file, 'Video.MSAA', '4', { format: 'ini' }),
    edit('ao', file, 'AO.EnableAO', '1', { format: 'ini' }),
  ], { accept: ['msaa'], txDir, isRunning: notRunning, now: NOW });
  assert.strictEqual(r.ok, true, r.error);
  assert.deepStrictEqual(r.applied, ['msaa']);
  const now = fs.readFileSync(file, 'utf8');
  assert.strictEqual(ac.getValue('ini', now, 'Video.MSAA').value, '4');
  assert.strictEqual(ac.getValue('ini', now, 'AO.EnableAO').value, '0', 'not accepted = untouched');
  assert.strictEqual(fs.readFileSync(path.join(d, 'GraphicsOptions.txt.bak-2026-10-18'), 'utf8'), orig);
  const j = JSON.parse(fs.readFileSync(path.join(txDir, 'journal.json'), 'utf8'));
  assert.strictEqual(j.files.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(txDir, j.files[0].pre), 'utf8'), orig);
  assert.deepStrictEqual(j.files[0].keys, [{ id: 'msaa', key: 'Video.MSAA', from: '1', to: '4' }]);
});

test('apply: an existing same-day backup is never overwritten (it holds the older pre-state)', async () => {
  const { d, file } = copyFix('civ6/GraphicsOptions.txt');
  fs.writeFileSync(path.join(d, 'GraphicsOptions.txt.bak-2026-10-18'), 'OLDER');
  const r = await ac.apply([edit('msaa', file, 'Video.MSAA', '4', { format: 'ini' })], { accept: ['msaa'], txDir: tmpdir('cc-tx-'), isRunning: notRunning, now: NOW });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fs.readFileSync(path.join(d, 'GraphicsOptions.txt.bak-2026-10-18'), 'utf8'), 'OLDER');
});

test('apply: refuses while the owning process runs; nothing written', async () => {
  const { file } = copyFix('civ6/GraphicsOptions.txt');
  const before = sha(file);
  const r = await ac.apply([edit('msaa', file, 'Video.MSAA', '4', { format: 'ini', processes: ['CivilizationVI.exe'] })], { accept: ['msaa'], txDir: tmpdir('cc-tx-'), isRunning: async (names) => names.filter((n) => n === 'CivilizationVI.exe'), now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /CivilizationVI\.exe is running/);
  assert.strictEqual(sha(file), before);
});

test('apply: refuses a new key or a type change for an accepted id; nothing written', async () => {
  const { file } = copyFix('civ6/GraphicsOptions.txt');
  const before = sha(file);
  const r = await ac.apply([edit('n', file, 'Video.Brand', '1', { format: 'ini' }), edit('msaa', file, 'Video.MSAA', '4', { format: 'ini' })], { accept: ['n', 'msaa'], txDir: tmpdir('cc-tx-'), isRunning: notRunning, now: NOW });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /new key/);
  assert.strictEqual(sha(file), before);
});

test('apply: a read-back mismatch rolls every file back to its pre-image', async () => {
  const a = copyFix('civ6/GraphicsOptions.txt');
  const b = copyFix('civ6/UserOptions.txt');
  const sa = sha(a.file); const sb = sha(b.file);
  // The fake writer drops UserOptions writes (an app that rewrites its file on save).
  const write = (f, text) => { if (/UserOptions/.test(f)) return; fs.writeFileSync(f, text); };
  const r = await ac.apply([
    edit('msaa', a.file, 'Video.MSAA', '4', { format: 'ini' }),
    edit('qm', b.file, 'Gameplay.QuickMovement', '1', { format: 'ini' }),
  ], { accept: ['msaa', 'qm'], txDir: tmpdir('cc-tx-'), isRunning: notRunning, now: NOW, write });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /read-back/);
  assert.strictEqual(sha(a.file), sa, 'first file rolled back');
  assert.strictEqual(sha(b.file), sb);
});

test('revert: restores the byte-identical pre-image; refuses a file changed since', async () => {
  const { file } = copyFix('civ6/GraphicsOptions.txt');
  const before = sha(file);
  const txDir = tmpdir('cc-tx-');
  await ac.apply([edit('msaa', file, 'Video.MSAA', '4', { format: 'ini' })], { accept: ['msaa'], txDir, isRunning: notRunning, now: NOW });
  assert.notStrictEqual(sha(file), before);
  const r = await ac.revert(txDir, { isRunning: notRunning });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(sha(file), before);

  const tx2 = tmpdir('cc-tx-');
  await ac.apply([edit('msaa', file, 'Video.MSAA', '4', { format: 'ini' })], { accept: ['msaa'], txDir: tx2, isRunning: notRunning, now: NOW });
  fs.appendFileSync(file, '\n;game rewrote this\n');
  const r2 = await ac.revert(tx2, { isRunning: notRunning });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /changed since/);
  const r3 = await ac.revert(tx2, { isRunning: notRunning, force: true });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(sha(file), before);
});
