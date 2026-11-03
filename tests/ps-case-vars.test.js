'use strict';
// PowerShell variable names ignore case: $l in a foreach overwrites an ArrayList $L in the same
// scope. That killed recover.ps1 -Prompt (stage run13 G4). This lists any variable spelled in
// two letter cases within one scope, with the 5.1 parser only: no checked script runs.
// $script:W and $w are different variables, so a scope qualifier keeps them apart; the script
// scope is one bucket for unqualified top-level names and $script: names from anywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir } = require('./helpers');

const CONSOLE = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'run', 'drops']);

const SCANNER = String.raw`param([string]$ListFile)
$FnType = [System.Management.Automation.Language.FunctionDefinitionAst]
$VarType = [System.Management.Automation.Language.VariableExpressionAst]
foreach ($p in [IO.File]::ReadAllLines($ListFile)) {
  $errs = $null; $toks = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$toks, [ref]$errs)
  if ($errs.Count) { Write-Output ('PARSE ' + $p + ': ' + $errs[0].Message); continue }
  $buckets = @{}
  foreach ($v in $ast.FindAll({ param($n) $n -is $VarType }, $true)) {
    $name = $v.VariablePath.UserPath
    $prefix = ''
    $colon = $name.IndexOf(':')
    if ($colon -ge 0) { $prefix = $name.Substring(0, $colon + 1).ToLowerInvariant(); $name = $name.Substring($colon + 1) }
    if (-not $name) { continue }
    $o = $v.Parent; $fn = $null
    while ($o) { if ($o -is $FnType) { $fn = $o; break }; $o = $o.Parent }
    if ($prefix) { $scope = $prefix }
    elseif ($fn) { $scope = 'function ' + $fn.Name + ' at ' + $fn.Extent.StartLineNumber }
    else { $scope = 'script:' }
    $key = $scope + '|' + $name.ToLowerInvariant()
    if (-not $buckets.ContainsKey($key)) {
      $buckets[$key] = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    }
    [void]$buckets[$key].Add($name)
  }
  foreach ($key in $buckets.Keys) {
    if ($buckets[$key].Count -gt 1) { Write-Output ('CASE ' + $p + ': ' + $key.Split('|')[0] + ': ' + (@($buckets[$key]) -join ' ')) }
  }
}
`;

function scan(root, files) {
  const script = path.join(root, 'scanner.ps1');
  const list = path.join(root, 'files.txt');
  fs.writeFileSync(script, SCANNER);
  fs.writeFileSync(list, files.join('\n') + '\n');
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, list], { windowsHide: true, encoding: 'utf8', env });
  return out.split(/\r?\n/).filter((l) => /^(CASE|PARSE) /.test(l));
}

function ps1Under(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) ps1Under(path.join(dir, e.name), out); } else if (/\.ps1$/i.test(e.name)) out.push(path.join(dir, e.name));
  }
  return out;
}

const win = { skip: process.platform !== 'win32' };

test('ps case check: it catches $L and $l in one scope, and lets scoped or separate names be', win, () => {
  const root = tmpdir('cc-pscase-');
  const fix = (name, body) => { const f = path.join(root, name); fs.writeFileSync(f, body); return f; };
  const bad = fix('bad.ps1', 'function A { $L = 1; foreach ($l in 1..2) { $l } }\n');
  const badTop = fix('bad-top.ps1', '$Foo = 1\nfunction B { $script:foo = 2 }\n');
  const good = fix('good.ps1', 'function A { $L = 1; $script:l = 2 }\nfunction B { $l = 3 }\n');
  const hits = scan(root, [bad, badTop, good]);
  assert.strictEqual(hits.length, 2, hits.join('\n'));
  assert.ok(hits.some((h) => h.includes('bad.ps1') && h.includes('function A')), hits.join('\n'));
  assert.ok(hits.some((h) => h.includes('bad-top.ps1') && h.includes('script:')), hits.join('\n'));
});

test('no PowerShell script in the console or its sandbox checks reuses a variable in another case', win, () => {
  const files = ps1Under(CONSOLE);
  const vmtest = path.join(CONSOLE, '..', 'tools', 'vmtest');
  if (fs.existsSync(vmtest)) files.push(...ps1Under(vmtest));
  assert.ok(files.some((f) => f.endsWith('recover.ps1')), 'the walk found recover.ps1');
  assert.deepStrictEqual(scan(tmpdir('cc-pscase-'), files), []);
});
