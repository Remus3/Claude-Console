# Clean-ClaudeTranscripts.ps1 - retention for Claude Code session transcripts.
#
# Why: the projects folder of a Claude config dir grows without bound. Two tiers,
# because the two kinds of transcript are not worth the same: nested sub-agent
# transcripts lose their value once the parent session ends; top-level sessions are
# the record someone may reopen. The days come from a measured age histogram, not
# from a round number. Only *.jsonl files are ever touched, never anything changed
# in the last -MinAgeHours, and each goes to the Recycle Bin.

param(
  [int]$TopKeepDays = {retention_days},
  [int]$NestedKeepDays = {retention_nested_days},
  [int]$MinAgeHours = 24,
  [string]$ProjectsDir = '{config_dir}\projects',
  [switch]$WhatIf,
  [string]$LogPath = (Join-Path $PSScriptRoot 'claude-retention.log')
)

$ErrorActionPreference = 'Stop'
if ($ProjectsDir -notmatch '(?i)\\projects$') { exit 1 }
Add-Type -AssemblyName Microsoft.VisualBasic

$now = Get-Date
$fresh = $now.AddHours(-$MinAgeHours)
$n = 0
foreach ($f in @(Get-ChildItem -LiteralPath $ProjectsDir -Recurse -File -Filter '*.jsonl')) {
  if ($f.LastWriteTime -gt $fresh) { continue }
  $depth = ($f.FullName.Substring($ProjectsDir.Length).Trim('\') -split '\\').Count
  $keep = if ($depth -gt 2) { $NestedKeepDays } else { $TopKeepDays }
  if ($f.LastWriteTime -gt $now.AddDays(-$keep)) { continue }
  if ($WhatIf) { $n++; continue }
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($f.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin')
  $n++
}
$verb = if ($WhatIf) { 'would recycle ' } else { 'recycled ' }
('{0}  {1}{2} transcripts' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $verb, $n) | Out-File -FilePath $LogPath -Append -Encoding ascii
exit 0
