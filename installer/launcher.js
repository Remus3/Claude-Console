'use strict';
// Launcher files the installer writes into the install home (CON-PUBLIC B):
//   launch.vbs          hidden start of the current version (the shortcuts point here)
//   claude-console.cmd  the CLI for a terminal (`claude-console start|stop|update|...`)
// Both name the version, so install and every update rewrite them. ASCII and LF.
// Shortcuts (Desktop + Start menu) are made by a PowerShell WScript.Shell call that the
// real CLI runs; tests inject makeShortcuts.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { layout } = require('./paths');

const vbsQ = (s) => String(s).replace(/"/g, '""');

function launcherFiles(home, version, nodePath) {
  const L = layout(home);
  const bin = path.join(L.app(version), 'bin', 'claude-console.js');
  const vbs = [
    "' Claude Console launcher (written by the installer; rewritten on every update).",
    "' Starts the installed version hidden and opens its app window.",
    'Option Explicit',
    'Dim sh',
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run """' + vbsQ(nodePath) + '"" ""' + vbsQ(bin) + '"" start --open --home ""' + vbsQ(L.home) + '""", 0, False',
    '',
  ].join('\n');
  const cmd = [
    '@echo off',
    'rem Claude Console CLI (written by the installer; rewritten on every update).',
    // Exit on the same line: `uninstall` deletes this file (once cmd has exited) and an
    // update rewrites it, so cmd must not read another line from it afterwards.
    // CON-0.1.1: a bare `exit /b` returned 0 to PowerShell after a failed command (a
    // failed uninstall looked fine). CON-0.1.2: `call` expands %errorlevel% at run time,
    // so node's own exit code reaches the caller; nothing after node names this folder.
    '"' + nodePath + '" "' + bin + '" %* --home "' + L.home + '" & call exit /b %%errorlevel%%',
    '',
  ].join('\n');
  // CON-SHIP-SETUP: a stable status-line path for ~/.claude*/settings.json; it follows
  // the installed version, so an update never leaves the settings line stale.
  const shim = [
    "'use strict';",
    '// Claude Console status line shim (written by the installer; rewritten on every update).',
    'require(' + JSON.stringify(path.join(L.app(version), 'statusline', 'statusline.js')) + ');',
    '',
  ].join('\n');
  // CON-AUTOUPDATE: the scheduled task runs this hidden (version-free task action).
  const auto = [
    "' Claude Console auto-update tick (written by the installer; rewritten on every update).",
    'Option Explicit',
    'Dim sh',
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run """' + vbsQ(nodePath) + '"" ""' + vbsQ(bin) + '"" autoupdate --home ""' + vbsQ(L.home) + '""", 0, True',
    '',
  ].join('\n');
  return { vbs, cmd, shim, auto, vbsPath: L.launcherVbs, cmdPath: path.join(L.home, 'claude-console.cmd'), shimPath: path.join(L.home, 'statusline.js'), autoPath: path.join(L.home, 'autoupdate.vbs') };
}

function writeLaunchers(home, version, nodePath) {
  const f = launcherFiles(home, version, nodePath);
  fs.mkdirSync(path.dirname(f.vbsPath), { recursive: true });
  fs.writeFileSync(f.vbsPath, f.vbs);
  fs.writeFileSync(f.cmdPath, f.cmd);
  fs.writeFileSync(f.shimPath, f.shim);
  fs.writeFileSync(f.autoPath, f.auto);
  return f;
}

const psQ = (s) => "'" + String(s).replace(/'/g, "''") + "'";

const ARP_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ClaudeConsole';
const LNK = 'Claude Console.lnk';

// User PATH edits (pure, mirrored by the PowerShell below): add / remove one dir,
// case-insensitive, a trailing backslash ignored.
const pathKey = (p) => String(p).trim().replace(/[\\/]+$/, '').toLowerCase();
function pathWith(cur, dir) {
  const parts = String(cur || '').split(';').filter((x) => x.trim());
  if (parts.some((x) => pathKey(x) === pathKey(dir))) return parts.join(';');
  return parts.concat([dir]).join(';');
}
function pathWithout(cur, dir) {
  return String(cur || '').split(';').filter((x) => x.trim() && pathKey(x) !== pathKey(dir)).join(';');
}

// PowerShell that edits HKCU\Environment Path (value kind kept, %vars% unexpanded)
// and broadcasts the change so new terminals see it.
function userPathPs(dir, add) {
  return [
    "$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
    "$cur = [string]$envKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    '$dir = ' + psQ(dir),
    "$key = { param($p) $p.Trim().TrimEnd('\\', '/').ToLowerInvariant() }",
    "$parts = @($cur -split ';' | Where-Object { $_.Trim() })",
    add
      ? "if (-not ($parts | Where-Object { (& $key $_) -eq (& $key $dir) })) { $parts += $dir }"
      : "$parts = @($parts | Where-Object { (& $key $_) -ne (& $key $dir) })",
    "$envKey.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)",
    '$envKey.Close()',
    "[Environment]::SetEnvironmentVariable('CLAUDE_CONSOLE_PATH_PING', '1', 'User')",
    "[Environment]::SetEnvironmentVariable('CLAUDE_CONSOLE_PATH_PING', $null, 'User')",
    "Write-Output ('user PATH: ' + $(if (" + (add ? '$true' : '$false') + ") { 'added ' } else { 'removed ' }) + $dir)",
  ];
}

// Shell integration (VMFIX): Desktop + Start-menu shortcuts, the Apps & features entry
// (HKCU Uninstall key) and claude-console on the user PATH. info: {home, version, repo}.
function shortcutScript(vbsPath, iconPath, info) {
  info = info || {};
  const home = info.home || path.dirname(vbsPath);
  const cmdPath = path.join(home, 'claude-console.cmd');
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$sh = New-Object -ComObject WScript.Shell',
    "$targets = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))",
    'foreach ($dir in $targets) {',
    '  $lnk = $sh.CreateShortcut((Join-Path $dir ' + psQ(LNK) + '))',
    "  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\\wscript.exe'",
    "  $lnk.Arguments = '\"' + " + psQ(vbsPath) + " + '\"'",
    '  $lnk.WorkingDirectory = Split-Path -Parent ' + psQ(vbsPath),
    "  $lnk.Description = 'Claude Console - GUI for Claude Code sessions'",
    iconPath ? '  $lnk.IconLocation = ' + psQ(iconPath + ',0') : '',
    '  $lnk.Save()',
    '  Write-Output (\'shortcut: \' + $dir)',
    '}',
  ];
  if (info.version) {
    lines.push(
      '$k = ' + psQ(ARP_KEY),
      'New-Item -Path $k -Force | Out-Null',
      "Set-ItemProperty -Path $k -Name DisplayName -Value 'Claude Console'",
      'Set-ItemProperty -Path $k -Name DisplayVersion -Value ' + psQ(info.version),
      'Set-ItemProperty -Path $k -Name Publisher -Value ' + psQ(info.repo ? info.repo.split('/')[0] : 'Claude Console'),
      'Set-ItemProperty -Path $k -Name InstallLocation -Value ' + psQ(home),
      'Set-ItemProperty -Path $k -Name UninstallString -Value ' + psQ('"' + cmdPath + '" uninstall'),
      'Set-ItemProperty -Path $k -Name QuietUninstallString -Value ' + psQ('"' + cmdPath + '" uninstall'),
      info.repo ? 'Set-ItemProperty -Path $k -Name URLInfoAbout -Value ' + psQ('https://github.com/' + info.repo) : '',
      'Set-ItemProperty -Path $k -Name NoModify -Value 1 -Type DWord',
      'Set-ItemProperty -Path $k -Name NoRepair -Value 1 -Type DWord',
      "Write-Output 'Apps & features: Claude Console'",
      ...userPathPs(home, true));
  }
  return lines.filter((l) => l !== '').join('\n') + '\n';
}

// Undoes shortcutScript, and drops the auto-update task when one was registered.
function unshellScript(home) {
  return [
    "$ErrorActionPreference = 'Continue'",
    "foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {",
    '  $f = Join-Path $dir ' + psQ(LNK),
    "  if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force; Write-Output ('removed shortcut: ' + $f) }",
    '}',
    'if (Test-Path ' + psQ(ARP_KEY) + ') { Remove-Item -Path ' + psQ(ARP_KEY) + " -Recurse -Force; Write-Output 'removed Apps & features entry' }",
    "Unregister-ScheduledTask -TaskName 'ClaudeConsole-AutoUpdate' -Confirm:$false -ErrorAction SilentlyContinue",
    ...userPathPs(home, false),
    '',
  ].join('\n');
}

function runPs(home, name, script) {
  return new Promise((resolve, reject) => {
    const file = path.join(require('os').tmpdir(), 'claude-console-' + name + '-' + process.pid + '.ps1');
    fs.writeFileSync(file, script);
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, timeout: 60000 }, (err, out) => {
      try { fs.unlinkSync(file); } catch (e) { /* temp script */ }
      if (err) return reject(new Error(name + ' failed: ' + err.message));
      resolve(String(out).trim().split(/\r?\n/));
    });
  });
}

// Real shell integration: only the CLI `install` / `uninstall` call these (never a test).
function makeShortcutsWindows(home, vbsPath, info) {
  return runPs(home, 'shortcuts', shortcutScript(vbsPath, null, Object.assign({ home: layout(home).home }, info || {})));
}
function removeShellWindows(home) {
  return runPs(home, 'unshell', unshellScript(layout(home).home));
}

module.exports = { launcherFiles, writeLaunchers, shortcutScript, unshellScript, makeShortcutsWindows, removeShellWindows, pathWith, pathWithout, ARP_KEY };
