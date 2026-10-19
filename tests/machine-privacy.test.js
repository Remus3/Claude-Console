'use strict';
// CON-013 L9 privacy guarantee for the machine profile (addendum a.3, e.1, e.2):
// machine data is LOCAL ONLY - it lives under <dataDir>/machine, no machine-profile
// module has network code, it never goes into a crash report, and the scrubber removes
// every machine value and every path under the machine folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const scan = require('../installer/machine-scan');
const inv = require('../installer/machine-inventory');
const contribute = require('../installer/contribute');

const ROOT = path.join(__dirname, '..');
const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'machine', 'cim-spec.json'), 'utf8');

function l9Files() {
  const out = [
    'installer/machine-scan.js', 'installer/machine-inventory.js', 'installer/profile-appconfig.js', 'server/health.js',
  ];
  for (const n of fs.readdirSync(path.join(ROOT, 'installer'))) if (/^machine-advisors.*.js$/.test(n)) out.push('installer/' + n);
  return out;
}

test('no machine-profile module has network code (no-egress, static)', () => {
  const bad = /require\(\s*['"](?:node:)?(https?|net|tls|dgram|http2)['"]\s*\)|\bfetch\s*\(|\bWebSocket\s*\(|XMLHttpRequest|Invoke-WebRequest|Invoke-RestMethod|\bcurl\b|\birm\b|https?:\/\//;
  const files = l9Files();
  assert.ok(files.length >= 6, 'scanned ' + files.length + ' files');
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const m = bad.exec(src);
    assert.strictEqual(m, null, rel + ' has network code: ' + (m && m[0]));
  }
});

test('the privacy contract names the machine folder for the export and crash-report excludes', () => {
  assert.deepStrictEqual(scan.PRIVACY.exportExclude, ['machine/']);
  assert.strictEqual(scan.PRIVACY.crashReport, 'never');
  assert.strictEqual(scan.PRIVACY.network, 'none');
  const data = tmpdir('cc-mach-');
  assert.strictEqual(scan.machineDir(data), path.join(data, 'machine'));
  assert.ok(scan.isMachinePath(path.join(data, 'machine', 'spec.json'), data));
  assert.ok(scan.isMachinePath(path.join(data, 'machine'), data));
  assert.ok(!scan.isMachinePath(path.join(data, 'machinery', 'x'), data));
  assert.ok(!scan.isMachinePath(path.join(data, 'profile', 'selection.json'), data));
});

test('scrubMachine removes every spec and inventory value and every machine path from a crash-report text', async () => {
  const data = tmpdir('cc-mach-');
  const { spec } = await scan.firstRun(data, { runner: async () => ({ code: 0, stdout: RAW, stderr: '' }) });
  const inventory = { apps: [{ name: 'Fake Paint Studio 3', publisher: 'Fakesoft', version: '3.1.4', install: 'D:\\Apps\\FakePaint' }], games: [{ appid: '289070', name: "Sid Meier's Civilization VI", install: 'E:\\SteamLibrary\\steamapps\\common\\Civ6' }] };
  inv.saveInventory(data, inventory);
  const report = [
    'Claude Console crash report',
    'step: profile.apply exit 1',
    'gpu FakeGPU RTX 9070 cpu FakeCPU 8-Core Processor display FAKEMON27',
    'apps: Fake Paint Studio 3 at D:\\Apps\\FakePaint; game ' + "Sid Meier's Civilization VI" + ' in E:\\SteamLibrary\\steamapps\\common\\Civ6',
    'read ' + path.join(data, 'machine', 'spec.json') + ' and ' + path.join(data, 'machine', 'advice', '20261018.json').replace(/\\/g, '/'),
  ].join('\n');
  const out = contribute.scrub(scan.scrubMachine(report, { dataDir: data }));
  for (const needle of ['FakeGPU', 'FakeCPU', 'FAKEMON27', 'Fake Paint', 'Fakesoft', 'FakePaint', 'Civilization VI', 'SteamLibrary', 'spec.json', path.join(data, 'machine'), '20261018.json']) {
    assert.ok(!out.includes(needle), 'scrubbed text still holds ' + needle + ':\n' + out);
  }
  assert.ok(out.includes('step: profile.apply exit 1'), 'non-machine text is kept');
  assert.ok(out.includes('<MACHINE>'));
});

test('scrubMachine works from the data files alone and with no machine data at all', () => {
  const empty = tmpdir('cc-mach-');
  assert.strictEqual(scan.scrubMachine('plain text', { dataDir: empty }), 'plain text');
  assert.strictEqual(scan.scrubMachine('plain text', {}), 'plain text');
});

test('crashReportSafe refuses any text that still names machine data', async () => {
  const data = tmpdir('cc-mach-');
  await scan.firstRun(data, { runner: async () => ({ code: 0, stdout: RAW, stderr: '' }) });
  assert.strictEqual(scan.crashReportSafe('error: x', { dataDir: data }), true);
  assert.strictEqual(scan.crashReportSafe('gpu FakeGPU RTX 9070', { dataDir: data }), false);
  assert.strictEqual(scan.crashReportSafe('see ' + path.join(data, 'machine'), { dataDir: data }), false);
});
