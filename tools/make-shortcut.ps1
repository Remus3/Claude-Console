# Creates (or refreshes) the Desktop shortcut "Claude Console" -> wscript launch.vbs.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$desk = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desk 'Claude Console.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$s.Arguments = '"' + (Join-Path $root 'launch.vbs') + '"'
$s.WorkingDirectory = $root
$s.Description = 'Claude Console - GUI for Claude Code sessions'
$ico = Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe'
if (Test-Path $ico) { $s.IconLocation = $ico + ',0' } else { $s.IconLocation = 'C:\Program Files\nodejs\node.exe,0' }
$s.Save()
Write-Output ('shortcut: ' + $lnk)
