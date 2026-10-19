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

// CON-0.1.3: the Apps & features version values. Install writes them with the key;
// update and rollback rewrite them (the entry showed the first installed version
// forever). VersionMajor / VersionMinor are the DWORDs Windows also reads.
function arpVersionLines(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version));
  return [
    'Set-ItemProperty -Path $k -Name DisplayVersion -Value ' + psQ(version),
    'Set-ItemProperty -Path $k -Name VersionMajor -Value ' + (m ? +m[1] : 0) + ' -Type DWord',
    'Set-ItemProperty -Path $k -Name VersionMinor -Value ' + (m ? +m[2] : 0) + ' -Type DWord',
  ];
}

// Refresh only: an install made with --no-shortcuts has no entry, and an update never
// creates one. The last line is the read-back: ARP=absent or ARP=<DisplayVersion>.
function arpVersionScript(version) {
  return [
    "$ErrorActionPreference = 'Stop'",
    '$k = ' + psQ(ARP_KEY),
    "if (-not (Test-Path $k)) { Write-Output 'ARP=absent'; exit 0 }",
    ...arpVersionLines(version),
    "Write-Output ('ARP=' + (Get-ItemProperty -Path $k -Name DisplayVersion).DisplayVersion)",
    '',
  ].join('\n');
}

// lines: the script's output. -> {present, version}
function parseArpReadBack(lines) {
  const l = (lines || []).map(String).reverse().find((x) => x.startsWith('ARP='));
  if (!l) return { present: null, version: null };
  const v = l.slice(4).trim();
  return v === 'absent' ? { present: false, version: null } : { present: true, version: v };
}

// -> {present, version, ok}; ok = absent, or the read-back equals the version.
async function writeArpWindows(home, version) {
  if (process.platform !== 'win32') return { present: null, version: null, ok: true, skipped: 'not Windows' };
  const rb = parseArpReadBack(await runPs(home, 'arp', arpVersionScript(version)));
  return Object.assign(rb, { ok: rb.present === false || rb.version === version });
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
      ...arpVersionLines(info.version),
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

// CON-0.1.3 (sandbox phase B): an update run by an OLDER CLI (0.1.2 had no Apps &
// features refresh) leaves the entry on the old version. The installed server calls this
// once at start: only when it runs from <home>/app/<v> and <home>/install.json names this
// version does it rewrite the version values (refresh only; an absent entry stays absent).
// write is injectable for tests.
async function refreshArpForInstall(appRoot, version, write) {
  const app = path.resolve(appRoot);
  if (path.basename(path.dirname(app)).toLowerCase() !== 'app') return { skipped: 'not an install' };
  const home = path.dirname(path.dirname(app));
  let m = null;
  try { m = JSON.parse(fs.readFileSync(path.join(home, 'install.json'), 'utf8')); } catch (e) { return { skipped: 'no install marker' }; }
  if (!m || m.version !== version) return { skipped: 'the marker names another version' };
  if (m.path && path.resolve(m.path).toLowerCase() !== app.toLowerCase()) return { skipped: 'the marker names another app folder' };
  return (write || writeArpWindows)(home, version);
}

module.exports = { launcherFiles, writeLaunchers, shortcutScript, unshellScript, makeShortcutsWindows, removeShellWindows, pathWith, pathWithout, ARP_KEY, arpVersionLines, arpVersionScript, parseArpReadBack, writeArpWindows, refreshArpForInstall };
