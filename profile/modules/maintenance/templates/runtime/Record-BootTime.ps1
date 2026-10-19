# Record-BootTime.ps1 - one row per boot in boot-times.csv.
#
# Why: the Windows boot-duration event is not recorded on every machine (its
# diagnostic log has a size cap), so this reads the logon and Group Policy timings
# that are, plus the Temp file and folder counts that drive logon time.

param([string]$CsvPath = (Join-Path $PSScriptRoot 'boot-times.csv'))

$ErrorActionPreference = 'SilentlyContinue'
$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$logon = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Winlogon/Operational'; Id = 811, 812; StartTime = $boot } |
  Sort-Object TimeCreated | Select-Object -First 2
$gp = Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-GroupPolicy/Operational'; Id = 8001; StartTime = $boot } |
  Select-Object -First 1
$temp = [System.IO.Path]::GetTempPath()
$files = @(Get-ChildItem -LiteralPath $temp -Recurse -Force -File).Count
$dirs = @(Get-ChildItem -LiteralPath $temp -Recurse -Force -Directory).Count
$logonSecs = ''
if ($logon.Count -eq 2) { $logonSecs = [int]($logon[1].TimeCreated - $logon[0].TimeCreated).TotalSeconds }
$gpSecs = ''
if ($gp) { $gpSecs = [int]($gp.TimeCreated - $boot).TotalSeconds }
if (-not (Test-Path -LiteralPath $CsvPath)) {
  'boot,logon_s,group_policy_s,temp_files,temp_dirs' | Out-File -FilePath $CsvPath -Encoding ascii
}
('{0},{1},{2},{3},{4}' -f $boot.ToString('s'), $logonSecs, $gpSecs, $files, $dirs) | Out-File -FilePath $CsvPath -Append -Encoding ascii
exit 0
