'use strict';
// CON-013 L9: first-run machine spec ingest. Fakes only: the CIM runner is a stub that
// returns a fixture; nothing queries or writes the real machine.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir } = require('./helpers');
const scan = require('../installer/machine-scan');

const FIX = path.join(__dirname, 'fixtures', 'machine');
const RAW = fs.readFileSync(path.join(FIX, 'cim-spec.json'), 'utf8');

function fakeRunner(out, calls) {
  return async (file, args) => {
    if (calls) calls.push([path.basename(file).toLowerCase(), args.slice()]);
    return { code: 0, stdout: out, stderr: '' };
  };
}

test('parseSpec normalises the CIM fixture: GPU, VRAM, CPU, RAM, displays, disks', () => {
  const s = scan.parseSpec(RAW, { now: () => Date.UTC(2026, 9, 18, 12) });
  assert.strictEqual(s.schema, 1);
  assert.strictEqual(s.cpu.name, 'FakeCPU 8-Core Processor');
  assert.strictEqual(s.cpu.cores, 8);
  assert.strictEqual(s.cpu.threads, 16);
  assert.strictEqual(s.ram.total_gb, 32);
  assert.strictEqual(s.ram.rated_mts, 5600);
  assert.strictEqual(s.ram.configured_mts, 5200);
  assert.strictEqual(s.gpus.length, 1, 'virtual adapters are excluded');
  assert.strictEqual(s.gpus[0].name, 'FakeGPU RTX 9070');
  assert.strictEqual(s.gpus[0].vram_gb, 12);
  assert.strictEqual(s.gpu.vram_gb, 12, 'gpu = the largest real adapter');
  assert.strictEqual(s.displays[0].hz, 144);
  assert.strictEqual(s.displays[0].max_hz, 240);
  assert.strictEqual(s.primary_display.width, 2560);
  assert.strictEqual(s.disks.length, 2);
  assert.strictEqual(s.disks[0].free_pct, 15);
  assert.strictEqual(s.scanned, '2026-10-18T12:00:00Z');
});

test('parseSpec never keeps the host name or the user name', () => {
  const s = scan.parseSpec(RAW);
  const text = JSON.stringify(s);
  assert.ok(!/FAKEHOST/.test(text), 'host name dropped');
  assert.ok(!/fakeuser/.test(text), 'user name dropped');
  assert.ok(!('host' in s) && !('user' in s));
});

test('parseSpec degrades to an empty spec on garbage, never throws', () => {
  const s = scan.parseSpec('not json');
  assert.strictEqual(s.gpus.length, 0);
  assert.strictEqual(s.ram.total_gb, 0);
  assert.strictEqual(s.gpu, null);
});

test('scanSpec runs ONE read-only powershell CIM query through the injected runner', async () => {
  const calls = [];
  const s = await scan.scanSpec({ runner: fakeRunner(RAW, calls) });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0][0], 'powershell.exe');
  const script = calls[0][1][calls[0][1].indexOf('-Command') + 1];
  assert.strictEqual(script, scan.PS_SPEC);
  assert.ok(!/Set-|New-Item|Remove-|Out-File|Add-Content/i.test(script), 'the query writes nothing');
  assert.strictEqual(s.gpu.name, 'FakeGPU RTX 9070');
});

test('firstRun ingests once into <dataDir>/machine/spec.json and nowhere else', async () => {
  const data = tmpdir('cc-mach-');
  const r1 = await scan.firstRun(data, { runner: fakeRunner(RAW) });
  assert.strictEqual(r1.ran, true);
  const file = path.join(data, 'machine', 'spec.json');
  assert.ok(fs.existsSync(file));
  const all = [];
  (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else all.push(path.relative(data, p)); } })(data);
  assert.deepStrictEqual(all, [path.join('machine', 'spec.json')]);
  const r2 = await scan.firstRun(data, { runner: async () => { throw new Error('must not rescan'); } });
  assert.strictEqual(r2.ran, false);
  assert.strictEqual(r2.spec.gpu.name, 'FakeGPU RTX 9070');
  const buf = fs.readFileSync(file);
  assert.ok(!buf.includes(13), 'LF only');
  assert.ok([...buf].every((b) => b < 128), 'ASCII only');
});

test('deleteMachineData sends the machine folder to the injected recycle, never unlinks', async () => {
  const data = tmpdir('cc-mach-');
  await scan.firstRun(data, { runner: fakeRunner(RAW) });
  const seen = [];
  const r = await scan.deleteMachineData(data, { recycle: async (p) => { seen.push(p); } });
  assert.strictEqual(r.recycled, true);
  assert.deepStrictEqual(seen, [path.join(data, 'machine')]);
  assert.ok(fs.existsSync(path.join(data, 'machine', 'spec.json')), 'the fake recycle moved nothing; no direct unlink happened');
  const none = await scan.deleteMachineData(tmpdir('cc-mach-'), { recycle: async () => { throw new Error('nothing to recycle'); } });
  assert.strictEqual(none.recycled, false);
});

test('PS_SPEC parses under Windows PowerShell 5.1 (parse only, nothing runs)', { skip: process.platform !== 'win32' }, () => {
  const d = tmpdir('cc-mach-');
  const f = path.join(d, 'spec.ps1');
  fs.writeFileSync(f, scan.PS_SPEC);
  const cmd = "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + f.replace(/'/g, "''") + "', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }; 'parsed'";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8' });
  assert.match(out, /parsed/);
});
