'use strict';
// CON-0.1.3 BUGFIX: recover.ps1 -Stop twice, then -Resume. The script itself is never
// run here (the floor). This harness loads only recover.ps1's FUNCTION definitions (by
// the 5.1 parser's AST), points every path at a scratch dir and replaces the one user
// environment seam (Get-UserVar / Set-UserVar) with a fake in-memory registry, so no
// real variable, task, process or settings file is touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir } = require('./helpers');

const PS1 = path.join(__dirname, '..', 'installer', 'recover.ps1');
const src = fs.readFileSync(PS1, 'utf8');
const psQ = (s) => "'" + String(s).replace(/'/g, "''") + "'";

test('recover.ps1: every user environment write goes through the Set-UserVar seam', () => {
  const body = src.replace(/^#.*$/gm, '');
  const sets = body.split('SetEnvironmentVariable').length - 1;
  assert.strictEqual(sets, 1, 'one SetEnvironmentVariable call');
  const fn = /function Set-UserVar[\s\S]*?\n}\n/.exec(body);
  assert.ok(fn && fn[0].includes('SetEnvironmentVariable'), 'inside Set-UserVar');
  const gets = body.split('GetEnvironmentVariable').length - 1;
  const gfn = /function Get-UserVar[\s\S]*?\n}\n/.exec(body);
  assert.ok(gfn && gfn[0].includes('GetEnvironmentVariable'));
  assert.strictEqual(gets, 1, 'one GetEnvironmentVariable call, inside Get-UserVar');
});

// steps: a PowerShell snippet run after the functions load, with the fake env in $FakeEnv.
function harness(root, steps) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile(' + psQ(PS1) + ', [ref]$null, [ref]$null)',
    '$fns = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)',
    'foreach ($f in $fns) { . ([scriptblock]::Create($f.Extent.Text)) }',
    // The fake registry: replaces the two seams AFTER the real ones load.
    '$script:FakeEnv = @{}',
    'function Get-UserVar([string]$Name) { if ($script:FakeEnv.ContainsKey($Name)) { return $script:FakeEnv[$Name] }; return $null }',
    'function Set-UserVar([string]$Name, $Value) { if ($null -eq $Value) { [void]$script:FakeEnv.Remove($Name) } else { $script:FakeEnv[$Name] = [string]$Value } }',
    '$InstallDir = ' + psQ(root),
    "$DataDir = Join-Path $InstallDir 'data'",
    "$ConfigDir = Join-Path $InstallDir 'config'",
    "$RunDir = Join-Path $InstallDir 'run'",
    "$ProfileDir = Join-Path $DataDir 'profile'",
    "$StopRoot = Join-Path $ProfileDir 'stop-all'",
    "$Marker = Join-Path $ProfileDir 'HOOKS_OFF'",
    '$Utf8 = New-Object System.Text.UTF8Encoding($false)',
    "$KillSwitchVar = 'CC_FAKE_KILLSWITCH_TEST'",
    '$script:Problems = New-Object System.Collections.ArrayList',
    '$script:Dry = $false',
    'function Run-Stop { $script:Record = New-StopRecord; $script:SideDir = $null; Invoke-StopProcesses; Invoke-KillSwitchOff; Complete-Stop }',
    steps,
    "$recs = @(Get-ChildItem -LiteralPath $StopRoot -Filter '*.json' | Sort-Object Name | ForEach-Object { [IO.File]::ReadAllText($_.FullName) | ConvertFrom-Json })",
    "Write-Output ('RESULT ' + (ConvertTo-Json -Compress -Depth 6 @{ env = $script:FakeEnv[$KillSwitchVar]; problems = @($script:Problems); records = @($recs | ForEach-Object { @{ id = $_.id; ks = [bool]$_.killSwitch; resumed = [bool]$_.resumed } }) }))",
  ];
  const f = path.join(root, 'harness.ps1');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  // A PSModulePath inherited from pwsh 7 (npm test from a pwsh shell) stops 5.1 from
  // loading its own Security module (ConvertTo-SecureString); 5.1 rebuilds the default.
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { windowsHide: true, encoding: 'utf8', env });
  const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  assert.ok(line, out);
  return { out, r: JSON.parse(line.slice(7)) };
}

const win = { skip: process.platform !== 'win32' };

test('recover.ps1 fake env: a second -Stop keeps the original snapshot and -Resume restores the kill switch', win, () => {
  const root = tmpdir('cc-rps1-');
  const { out, r } = harness(root, [
    "$script:FakeEnv[$KillSwitchVar] = 'proxy-value-1'",
    'Run-Stop',
    "if (Get-UserVar $KillSwitchVar) { throw 'first stop left the var set' }",
    'Run-Stop',
    'Invoke-Resume',
  ].join('\n'));
  assert.strictEqual(r.env, 'proxy-value-1', 'kill switch restored from the pre-stop snapshot\n' + out);
  assert.strictEqual(r.records.length, 1, 'the second -Stop wrote no new record\n' + out);
  assert.deepStrictEqual([r.records[0].ks, r.records[0].resumed], [true, true]);
  assert.match(out, /already stopped/);
  assert.deepStrictEqual(r.problems, []);
});

test('recover.ps1 fake env: an old empty record (pre-fix bug) newer than the real one is skipped by -Resume', win, () => {
  const root = tmpdir('cc-rps1-');
  const { out, r } = harness(root, [
    "$script:FakeEnv[$KillSwitchVar] = 'proxy-value-1'",
    'Run-Stop',
    // What the old script wrote on a second -Stop: a later, empty record.
    "$e = [ordered]@{ schema = 1; id = '29991231-235959-ffff'; at = '2999-12-31T23:59:59.0000000Z'; by = 'recover.ps1'; processes = @(@{ pid = 5; kind = 'pane'; result = 'not running' }); tasks = @(); hooks = @{ marker = $false; files = @() }; killSwitch = $null; resumed = $null }",
    "[IO.File]::WriteAllText((Join-Path $StopRoot '29991231-235959-ffff.json'), (ConvertTo-Json -Depth 6 $e), $Utf8)",
    'Invoke-Resume',
  ].join('\n'));
  assert.strictEqual(r.env, 'proxy-value-1', out);
  const real = r.records.find((x) => x.ks);
  assert.ok(real && real.resumed, out);
});

test('recover.ps1 fake env: two real stops resume newest first, so the earliest snapshot wins', win, () => {
  const root = tmpdir('cc-rps1-');
  const { out, r } = harness(root, [
    "$script:FakeEnv[$KillSwitchVar] = 'proxy-value-1'",
    'Run-Stop',
    'Start-Sleep -Milliseconds 20',
    "$script:FakeEnv[$KillSwitchVar] = 'proxy-value-2'",
    'Run-Stop',
    'Invoke-Resume',
  ].join('\n'));
  assert.strictEqual(r.records.length, 2, out);
  assert.ok(r.records.every((x) => x.resumed), out);
  assert.strictEqual(r.env, 'proxy-value-1', out);
  assert.deepStrictEqual(r.problems, []);
});

test('recover.ps1 fake env: a -Resume with nothing stopped says so and changes nothing', win, () => {
  const root = tmpdir('cc-rps1-');
  fs.mkdirSync(path.join(root, 'data', 'profile', 'stop-all'), { recursive: true });
  const { out, r } = harness(root, "$script:FakeEnv[$KillSwitchVar] = 'v'\nInvoke-Resume");
  assert.match(out, /nothing to resume/);
  assert.strictEqual(r.env, 'v');
});

// 013-VERIFY sandbox G4: File.Replace(tmp, path, $null) failed on every real settings
// rewrite ("The path is not of a legal form": PowerShell passes "" for $null strings).
test('recover.ps1: atomic rewrites pass a real null backup name to File.Replace', () => {
  assert.ok(!/::Replace\([^)]*\$null\)/.test(src), 'no $null string argument to File.Replace');
  assert.strictEqual((src.match(/::Replace\(\$tmp, \$Path, \[NullString\]::Value\)/g) || []).length, 2);
});
