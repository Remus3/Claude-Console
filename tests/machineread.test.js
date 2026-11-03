'use strict';
// CON-MACHINE-READ: the full hardware / OS read behind the machine advisor's Read machine.
// Fakes only: the CIM runner is never the real box here (machine-scan.test.js parse-checks
// the script under PowerShell 5.1). The result lives in <dataDir>/machine/spec.json; claude
// panes get its path in CONSOLE_MACHINE_FILE and hook.js names it once at SessionStart.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir } = require('./helpers');
const scan = require('../installer/machine-scan');
const { buildPaneEnv } = require('../server/claudeenv');

const RAW = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'machine', 'cim-spec.json'), 'utf8'));
const FULL = Object.assign({}, RAW, {
  board: 'Fakeco B999', bios: { version: 'FK12', date: '2026-06-22' },
  cpu: Object.assign({}, RAW.cpu, { max_mhz: 4501 }),
  os: Object.assign({}, RAW.os, { version: '10.0.19045', release: '22H2', ubr: 6466, arch: '64-bit' }),
  physical_disks: [{ model: 'FakeDisk NVMe 1TB', media: 'SSD', bus: 'NVMe', size: 1024209543168 }, { model: 'Msft Virtual Disk', media: 'SSD', bus: 'File Backed Virtual', size: 8e9 }],
  nics: [{ name: 'FakeNet 2.5GbE Controller', speed: 2500000000, up: true }, { name: 'Hyper-V Virtual Ethernet Adapter', speed: 1e10, up: true }],
});

test('parseSpec keeps board, BIOS, OS release, physical disks and NICs; virtual ones dropped', () => {
  const s = scan.parseSpec(JSON.stringify(FULL));
  assert.strictEqual(s.board, 'Fakeco B999');
  assert.deepStrictEqual(s.bios, { version: 'FK12', date: '2026-06-22' });
  assert.strictEqual(s.cpu_max_mhz, 4501);
  assert.deepStrictEqual(s.os, { caption: 'Windows 10 Pro', build: '19045', version: '10.0.19045', release: '22H2', ubr: 6466, arch: '64-bit' });
  assert.deepStrictEqual(s.physical_disks, [{ model: 'FakeDisk NVMe 1TB', media: 'SSD', bus: 'NVMe', size_gb: 953.9 }]);
  assert.deepStrictEqual(s.nics, [{ name: 'FakeNet 2.5GbE Controller', mbps: 2500, up: true }]);
  // an older raw (the base fixture) still parses, with empty additions
  const o = scan.parseSpec(JSON.stringify(RAW));
  assert.deepStrictEqual([o.board, o.physical_disks, o.nics], ['', [], []]);
  assert.strictEqual(scan.parseSpec(JSON.stringify(Object.assign({}, FULL, { bios: { date: '/Date(1782086400000)/' } }))).bios.date, '2026-06-22');
});

test('the read queries no MAC, address or serial number and writes nothing', () => {
  assert.ok(!/MACAddress|IPAddress|SerialNumber|UUID|Set-|New-Item|Remove-|Out-File|Add-Content/i.test(scan.PS_SPEC));
});

test('summaryLine: one line for Settings > Machine', () => {
  assert.strictEqual(scan.summaryLine(scan.parseSpec(JSON.stringify(FULL))), 'Fakeco Tower 9 - FakeCPU 8-Core Processor (8C/16T) - 32 GB RAM @ 5200 MT/s - FakeGPU RTX 9070 12 GB - 2 volumes 2794 GB - Windows 10 Pro 22H2 build 19045.6466');
  assert.strictEqual(scan.summaryLine(null), null);
});

test('claude panes get CONSOLE_MACHINE_FILE; shell panes do not', () => {
  assert.strictEqual(buildPaneEnv({}, { kind: 'claude', machineFile: 'X:\\d\\machine\\spec.json' }).CONSOLE_MACHINE_FILE, 'X:\\d\\machine\\spec.json');
  assert.strictEqual(buildPaneEnv({}, { kind: 'shell', machineFile: 'X:\\d\\machine\\spec.json' }).CONSOLE_MACHINE_FILE, undefined);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'panes.js'), 'utf8');
  assert.match(src, /machineFile: this\.mgr\.cfg\.dataDir \? path\.join\(this\.mgr\.cfg\.dataDir, 'machine', 'spec\.json'\) : null/);
});

function hook(event, file) {
  const env = Object.assign({}, process.env);
  for (const k of ['CONSOLE_HOOK_URL', 'CONSOLE_PANE', 'CONSOLE_HOOK_SECRET', 'CONSOLE_MACHINE_FILE']) delete env[k];
  if (file) env.CONSOLE_MACHINE_FILE = file;
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'hook.js'), event], { env, input: '', encoding: 'utf8', windowsHide: true });
}

test('hook.js: SessionStart names the machine file in one additionalContext line; nothing else prints', () => {
  const d = tmpdir('cc-mread-');
  const file = path.join(d, 'machine', 'spec.json');
  scan.writeMachineJson(d, 'spec.json', scan.parseSpec(JSON.stringify(FULL), { now: () => Date.UTC(2026, 9, 25, 12) }));
  const r = hook('ready', file);
  assert.strictEqual(r.status, 0);
  const j = JSON.parse(r.stdout.trim());
  assert.strictEqual(j.hookSpecificOutput.hookEventName, 'SessionStart');
  const line = j.hookSpecificOutput.additionalContext;
  assert.ok(line.includes(file.replace(/\\/g, '/')), line);
  assert.match(line, /2026-10-25/);
  assert.match(line, /Read it only when the task depends on this machine's hardware or OS\.$/);
  assert.ok(line.length < 400 && !/\n/.test(line), 'one short line');
  assert.ok(!/Fakeco|FakeCPU/.test(line), 'the line names the file, not its contents');
  assert.strictEqual(hook('busy', file).stdout, '', 'UserPromptSubmit prints nothing');
  assert.strictEqual(hook('ready', path.join(d, 'nope.json')).stdout, '', 'no file, no line');
  assert.strictEqual(hook('ready', null).stdout, '');
});

// R3-14: one place for the machine: Settings has a line and a button, the advisor the rest.
test('R3-14: Read machine lives in the advisor, first; Settings keeps one line and one button', () => {
  const pub = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
  const box = /<fieldset[^>]*id="set-machine">[\s\S]*?<\/fieldset>/.exec(html)[0];
  assert.match(box, /id="mach-line"/);
  assert.match(box, />Open machine advisor\.\.\.<\/button>/);
  assert.strictEqual((box.match(/<button/g) || []).length, 1);
  assert.doesNotMatch(html, /btn-mach-read|mach-file|mach-help/);
  const prof = fs.readFileSync(path.join(pub, 'profile.js'), 'utf8');
  assert.doesNotMatch(prof, /Look at this machine|nothing leaves it/);
  assert.match(prof, /text: 'Suggest changes'/);
  assert.match(prof, /Claude panes can read that file, so Claude may see it\. Delete machine data removes it, to the Recycle Bin\./);
  assert.ok(prof.indexOf("text: 'Read machine'") < prof.indexOf("text: 'View machine data'"), 'Read machine comes first');
});
