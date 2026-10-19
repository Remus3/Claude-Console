# Temp-Hygiene.ps1 - keeps the user's Temp folder from regrowing.
#
# Why: the number of files in Temp drives logon time (the profile service walks it;
# about 0.2 ms per file was measured), so a Temp folder of several hundred thousand
# files adds minutes to every boot. This removes only stale scratch: entries older
# than -CutoffHours, never anything locked, never the live Claude session folder.
# A directory is renamed before it is removed, so one with an open handle is
# refused instead of half-deleted.

param(
  [int]$CutoffHours = 48,
  [string[]]$ScratchPrefixes = @('pytest-of-*', 'tmp*'),
  [switch]$DryRun,
  [string]$LogPath = (Join-Path $PSScriptRoot 'temp-hygiene.log')
)

$ErrorActionPreference = 'SilentlyContinue'
$temp = [System.IO.Path]::GetTempPath().TrimEnd('\')
if ($temp -notmatch '(?i)\\Temp$') { exit 1 }

function Write-Log([string]$m) {
  ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) | Out-File -FilePath $LogPath -Append -Encoding ascii
}

$cut = (Get-Date).AddHours(-$CutoffHours)
$removed = 0
$refused = 0
foreach ($prefix in $ScratchPrefixes) {
  foreach ($d in @(Get-ChildItem -LiteralPath $temp -Directory -Filter $prefix)) {
    if ($d.Name -ieq 'claude') { continue }
    if (($d.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    $newest = Get-ChildItem -LiteralPath $d.FullName -Recurse -Force | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    $stamp = if ($newest) { $newest.LastWriteTime } else { $d.LastWriteTime }
    if ($stamp -gt $cut) { continue }
    if ($DryRun) { Write-Log ('would remove ' + $d.Name); continue }
    $aside = $d.FullName + '.reap'
    try {
      [System.IO.Directory]::Move($d.FullName, $aside)
      [System.IO.Directory]::Delete($aside, $true)
      $removed++
    } catch {
      $refused++
    }
  }
}
$count = @(Get-ChildItem -LiteralPath $temp -Recurse -Force -File).Count
Write-Log ('removed ' + $removed + ' dirs, refused ' + $refused + ', Temp files now ' + $count)
exit 0
