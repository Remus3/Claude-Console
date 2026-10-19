# Claude Console - Recover (CON-013 addendum e.3). Standalone: Windows PowerShell 5.1,
# no Node, no console server, no network. It reads the profile's lock, journal and
# stop-all files directly.
#
#   recover.ps1 -WhatIf -Stop -DisableHooks -PauseTasks   show what would happen, change nothing
#   recover.ps1 -Stop            stop console-spawned process trees (recorded pid + image +
#                                start time; taskkill /T by pid, never by image name) and
#                                unset the headless kill-switch variable
#   recover.ps1 -DisableHooks    HOOKS_OFF marker + "hooks" -> "hooks.profile-disabled" in
#                                every settings.json the profile put hooks into
#   recover.ps1 -PauseTasks      disable (never delete) the profile's scheduled tasks,
#                                XML exported first
#   recover.ps1 -Resume          undo every open stop record (this script's or the console's),
#                                newest first, so the first pre-stop snapshot is what remains;
#                                a second -Stop never replaces that snapshot
#   recover.ps1 -Revert last     undo the last profile transaction from its journal
#                                (pre-images restored; files the profile created go to the
#                                Recycle Bin; an edited file is kept and flagged)
#   recover.ps1 -Prompt          write a scrubbed recovery prompt, copy it, open claude.ai/new
#
# Every action is safe to repeat. A missing data folder means there is nothing to undo.
# Manual steps for when even this script cannot run: docs/recovery.md.
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$Stop,
  [switch]$DisableHooks,
  [switch]$PauseTasks,
  [switch]$Resume,
  [string]$Revert = '',
  [switch]$Prompt,
  [string]$InstallDir = '',
  [string]$DataDir = '',
  [string]$ConfigDir = '',
  [string]$KillSwitchVar = 'CLAUDE_HEADLESS_BASE_URL'
)

$ErrorActionPreference = 'Stop'
$script:Problems = New-Object System.Collections.ArrayList
$script:Dry = [bool]$WhatIfPreference

function Say([string]$Line) { Write-Output $Line }
function Note-Problem([string]$Line) { [void]$script:Problems.Add($Line); Write-Output ('problem: ' + $Line) }

# The one seam for the user environment (HKCU\Environment); tests replace these two.
function Get-UserVar([string]$Name) {
  return [Environment]::GetEnvironmentVariable($Name, 'User')
}
function Set-UserVar([string]$Name, $Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, 'User')
}

if (-not $InstallDir) {
  if ($env:CLAUDE_CONSOLE_HOME) { $InstallDir = $env:CLAUDE_CONSOLE_HOME } else { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\claude-console' }
}
if (-not $DataDir) { $DataDir = Join-Path $InstallDir 'data' }
if (-not $ConfigDir) {
  if ($env:CLAUDE_CONFIG_DIR) { $ConfigDir = $env:CLAUDE_CONFIG_DIR } else { $ConfigDir = Join-Path $env:USERPROFILE '.claude' }
}
$RunDir = Join-Path $InstallDir 'run'
$ProfileDir = Join-Path $DataDir 'profile'
$StopRoot = Join-Path $ProfileDir 'stop-all'
$Marker = Join-Path $ProfileDir 'HOOKS_OFF'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return ([IO.File]::ReadAllText($Path, $Utf8) | ConvertFrom-Json) } catch { return $null }
}

# (PowerShell turns a $null string argument into "", which File.Replace rejects as "The
# path is not of a legal form": [NullString]::Value passes a real null - no backup file.)
function Write-TextAtomic([string]$Path, [string]$Text) {
  $tmp = $Path + '.' + $PID + '.tmp'
  [IO.File]::WriteAllText($tmp, $Text, $Utf8)
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
}

function Write-BytesAtomic([string]$Path, [byte[]]$Bytes) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  $tmp = $Path + '.' + $PID + '.tmp'
  [IO.File]::WriteAllBytes($tmp, $Bytes)
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
}

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $bytes = $sha.ComputeHash($Utf8.GetBytes($Text))
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Send-ToRecycleBin([string]$Path) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($Path, 'OnlyErrorDialogs', 'SendToRecycleBin')
}

function New-Stamp {
  $hex = -join ((1..4) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
  return ((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss') + '-' + $hex)
}

function Get-Targets {
  $t = Read-JsonFile (Join-Path $ProfileDir 'targets.json')
  if ($t -and $t.repos) { return @($t.repos) }
  return @()
}

# Settings files the profile put hooks into (repo locks + the user lock).
function Get-ManagedSettings {
  $out = New-Object System.Collections.ArrayList
  $pairs = @()
  foreach ($r in Get-Targets) { $pairs += ,@($r, (Read-JsonFile (Join-Path $r '.claude\profile.lock.json'))) }
  $pairs += ,@($ConfigDir, (Read-JsonFile (Join-Path $ProfileDir 'locks\user.json')))
  foreach ($p in $pairs) {
    $root = $p[0]; $lock = $p[1]
    if (-not $lock -or -not $lock.files) { continue }
    foreach ($prop in $lock.files.PSObject.Properties) {
      if ($prop.Name -match 'settings(\.local)?\.json$' -and $prop.Value.hooks) {
        [void]$out.Add((Join-Path $root ($prop.Name -replace '/', '\')))
      }
    }
  }
  return @($out | Select-Object -Unique)
}

# Byte-exact rename of the top-level "hooks" key (strings and nesting are skipped over,
# so a nested "hooks" is never touched). Returns $null when there is no top-level key.
function Rename-TopKey([string]$Text, [string]$From, [string]$To) {
  $depth = 0; $i = 0; $n = $Text.Length
  while ($i -lt $n) {
    $c = $Text[$i]
    if ($c -eq '"') {
      $j = $i + 1
      while ($j -lt $n -and $Text[$j] -ne '"') { if ($Text[$j] -eq '\') { $j++ }; $j++ }
      $tok = $Text.Substring($i + 1, $j - $i - 1)
      if ($depth -eq 1 -and $tok -eq $From) {
        $k = $j + 1
        while ($k -lt $n -and [char]::IsWhiteSpace($Text[$k])) { $k++ }
        if ($k -lt $n -and $Text[$k] -eq ':') { return $Text.Substring(0, $i + 1) + $To + $Text.Substring($j) }
      }
      $i = $j + 1; continue
    }
    if ($c -eq '{' -or $c -eq '[') { $depth++ } elseif ($c -eq '}' -or $c -eq ']') { $depth-- }
    $i++
  }
  return $null
}

function Has-TopKey([string]$Text, [string]$Key) { return ($null -ne (Rename-TopKey $Text $Key ($Key + '.probe'))) }

# ------------------------------------------------------------------ stop

function New-StopRecord {
  return [ordered]@{ schema = 1; id = ''; at = (Get-Date).ToUniversalTime().ToString('o'); by = 'recover.ps1'; processes = @(); tasks = @(); hooks = [ordered]@{ marker = $false; files = @() }; killSwitch = $null; resumed = $null }
}
$Record = New-StopRecord
$SideDir = $null
function Ensure-SideDir {
  if (-not $script:SideDir) {
    $Record.id = New-Stamp
    $script:SideDir = Join-Path $StopRoot $Record.id
    [void](New-Item -ItemType Directory -Path $script:SideDir -Force)
  }
  return $script:SideDir
}

function Invoke-StopProcesses {
  $dir = Join-Path $RunDir 'spawned'
  if (-not (Test-Path -LiteralPath $dir)) { Say 'processes: none recorded'; return }
  foreach ($f in Get-ChildItem -LiteralPath $dir -Filter '*.json') {
    $rec = Read-JsonFile $f.FullName
    if (-not $rec -or -not $rec.pid) { continue }
    $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$rec.pid)
    if (-not $p) { $Record.processes += ,([ordered]@{ pid = $rec.pid; kind = $rec.kind; result = 'not running' }); continue }
    $nameOk = (-not $rec.name) -or ($p.Name -ieq [string]$rec.name)
    $startOk = $true
    if ($rec.startMs) {
      $startMs = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()
      $startOk = [Math]::Abs($startMs - [double]$rec.startMs) -lt 2000
    }
    if (-not ($nameOk -and $startOk)) { $Record.processes += ,([ordered]@{ pid = $rec.pid; kind = $rec.kind; result = 'skipped: pid now belongs to another process' }); continue }
    if ($script:Dry) { Say ('would stop the process tree of pid ' + $rec.pid + ' (' + $rec.kind + ')'); continue }
    & taskkill.exe /PID ([int]$rec.pid) /T /F | Out-Null
    Start-Sleep -Milliseconds 300
    $gone = -not (Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$rec.pid))
    $res = 'still running'
    if ($gone) { $res = 'stopped' } else { Note-Problem ('pid ' + $rec.pid + ' still running') }
    $Record.processes += ,([ordered]@{ pid = $rec.pid; kind = $rec.kind; result = $res })
  }
  Say ('processes: ' + @($Record.processes | Where-Object { $_.result -eq 'stopped' }).Count + ' stopped')
}

function Invoke-KillSwitchOff {
  $v = Get-UserVar $KillSwitchVar
  if (-not $v) { Say ($KillSwitchVar + ': not set'); return }
  if ($script:Dry) { Say ('would unset the user variable ' + $KillSwitchVar + ' (its value kept DPAPI-protected for -Resume)'); return }
  $side = Ensure-SideDir
  $enc = ConvertTo-SecureString -String $v -AsPlainText -Force | ConvertFrom-SecureString
  [IO.File]::WriteAllText((Join-Path $side 'killswitch.dpapi'), $enc, $Utf8)
  Set-UserVar $KillSwitchVar $null
  $unset = -not (Get-UserVar $KillSwitchVar)
  if (-not $unset) { Note-Problem ($KillSwitchVar + ' still set') }
  $Record.killSwitch = [ordered]@{ name = $KillSwitchVar; snap = 'killswitch.dpapi'; format = 'dpapi'; unset = $unset }
  Say ($KillSwitchVar + ': unset')
}

function Invoke-PauseTasks {
  $lock = Read-JsonFile (Join-Path $ProfileDir 'locks\user.json')
  if (-not $lock -or -not $lock.tasks) { Say 'tasks: none recorded'; return }
  foreach ($prop in $lock.tasks.PSObject.Properties) {
    $name = $prop.Name
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $t -or $t.State -eq 'Disabled') { continue }
    if ($script:Dry) { Say ('would disable the task ' + $name + ' (XML exported first)'); continue }
    $side = Ensure-SideDir
    $backup = 'task-' + $name + '.xml'
    [IO.File]::WriteAllText((Join-Path $side $backup), (Export-ScheduledTask -TaskName $name -TaskPath $t.TaskPath), $Utf8)
    [void](Disable-ScheduledTask -TaskName $name -TaskPath $t.TaskPath)
    $ok = ((Get-ScheduledTask -TaskName $name -TaskPath $t.TaskPath).State -eq 'Disabled')
    if (-not $ok) { Note-Problem ('task ' + $name + ' not disabled') }
    $Record.tasks += ,([ordered]@{ name = $name; backup = $backup; disabled = $ok })
  }
  Say ('tasks: ' + @($Record.tasks).Count + ' disabled')
}

function Invoke-DisableHooks {
  if ($script:Dry) {
    Say ('would write the hooks-off marker and rename "hooks" in ' + @(Get-ManagedSettings).Count + ' settings file(s)')
    return
  }
  if (-not (Test-Path -LiteralPath $Marker)) {
    [void](New-Item -ItemType Directory -Path $ProfileDir -Force)
    [IO.File]::WriteAllText($Marker, "Profile hooks are off (recover.ps1). Resume removes this file.`n", $Utf8)
    $Record.hooks.marker = $true
  }
  $n = 0
  foreach ($file in Get-ManagedSettings) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    $text = [IO.File]::ReadAllText($file, $Utf8)
    try { [void]($text | ConvertFrom-Json) } catch { Note-Problem ((Split-Path -Leaf $file) + ' unreadable; the marker still holds its hooks off'); continue }
    if (Has-TopKey $text 'hooks.profile-disabled') { continue }
    $after = Rename-TopKey $text 'hooks' 'hooks.profile-disabled'
    if ($null -eq $after) { continue }
    $side = Ensure-SideDir
    $pre = 'settings-' + $n + '.json'; $n++
    [IO.File]::Copy($file, (Join-Path $side $pre), $true)
    Write-TextAtomic $file $after
    $Record.hooks.files += ,([ordered]@{ file = $file; pre = $pre; applied_sha = (Get-Sha256 $file) })
  }
  Say ('hooks: off (' + @($Record.hooks.files).Count + ' settings file(s) renamed)')
}

function Save-StopRecord {
  if ($script:Dry) { return }
  [void](Ensure-SideDir)
  $json = ($Record | ConvertTo-Json -Depth 8) -replace "`r`n", "`n"
  [IO.File]::WriteAllText((Join-Path $StopRoot ($Record.id + '.json')), $json + "`n", $Utf8)
  Say ('stop record: ' + $Record.id)
}

# A record that holds something to undo (a stopped process, a task, hooks or the kill
# switch). A record of only "not running" / "skipped" processes is not one.
function Test-RealRecord($R) {
  if (-not $R) { return $false }
  if ($R.killSwitch -or @($R.tasks).Count -or $R.hooks.marker -or @($R.hooks.files).Count) { return $true }
  return [bool](@($R.processes | Where-Object { $_.result -eq 'stopped' }).Count)
}

function Get-RecordTicks($R) {
  try { return ([DateTimeOffset]::Parse([string]$R.at, [Globalization.CultureInfo]::InvariantCulture)).UtcTicks } catch { return [long]0 }
}

# Not-resumed real stop records, oldest first: @(@(file, record), ...).
function Get-OpenRecords {
  $out = New-Object System.Collections.ArrayList
  if (-not (Test-Path -LiteralPath $StopRoot)) { return @() }
  $files = @(Get-ChildItem -LiteralPath $StopRoot -Filter '*.json' | Where-Object { $_.Name -match '^\d{8}-\d{6}-[0-9a-f]{4}\.json$' })
  foreach ($f in $files) {
    $r = Read-JsonFile $f.FullName
    if ($r -and -not $r.resumed -and (Test-RealRecord $r)) { [void]$out.Add([pscustomobject]@{ file = $f; rec = $r; ticks = (Get-RecordTicks $r); name = $f.Name }) }
  }
  return @($out | Sort-Object ticks, name)
}

# CON-0.1.3: a second -Stop never replaces the pre-stop snapshot. It saves a record only
# when it undid something new (append); when it found everything already stopped it is
# a no-op, so -Resume still sees the original record with the kill-switch value.
function Complete-Stop {
  if (Test-RealRecord $Record) { Save-StopRecord; return }
  $open = @(Get-OpenRecords)
  if ($open.Count) { Say ('already stopped: nothing new to record (stop record ' + $open[0].rec.id + ' is kept for -Resume)') }
  else { Say 'nothing to stop' }
}

# ------------------------------------------------------------------ resume

# Replays every not-resumed real stop record, newest first, so the EARLIEST snapshot is
# applied last (CON-0.1.3: the kill-switch value saved before the first -Stop wins).
function Invoke-Resume {
  $open = @(Get-OpenRecords)
  if (-not $open.Count) { Say 'nothing to resume'; return }
  [array]::Reverse($open)
  if ($script:Dry) {
    foreach ($o in $open) { Say ('would resume ' + $o.rec.id + ': ' + @($o.rec.tasks).Count + ' task(s), hooks, kill switch') }
    return
  }
  foreach ($o in $open) { Resume-Record $o.file $o.rec }
}

function Resume-Record($F, $R) {
  $before = $script:Problems.Count
  $side = Join-Path $StopRoot $R.id
  if ($R.killSwitch -and $R.killSwitch.format -eq 'dpapi') {
    $enc = [IO.File]::ReadAllText((Join-Path $side $R.killSwitch.snap), $Utf8)
    $sec = ConvertTo-SecureString -String $enc
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    Set-UserVar $R.killSwitch.name $plain
    if ((Get-UserVar $R.killSwitch.name) -ne $plain) { Note-Problem ($R.killSwitch.name + ' not restored') }
  } elseif ($R.killSwitch) {
    Note-Problem ($R.killSwitch.name + ' was stopped by the console; resume it there (claude-console resume --yes)')
  }
  foreach ($h in @($R.hooks.files)) {
    if (-not $h) { continue }
    if (-not (Test-Path -LiteralPath $h.file)) { Note-Problem ((Split-Path -Leaf $h.file) + ' missing'); continue }
    if ((Get-Sha256 $h.file) -eq $h.applied_sha) { Write-BytesAtomic $h.file ([IO.File]::ReadAllBytes((Join-Path $side $h.pre))); continue }
    $text = [IO.File]::ReadAllText($h.file, $Utf8)
    if ((Has-TopKey $text 'hooks.profile-disabled') -and -not (Has-TopKey $text 'hooks')) { Write-TextAtomic $h.file (Rename-TopKey $text 'hooks.profile-disabled' 'hooks') }
  }
  if ($R.hooks.marker -and (Test-Path -LiteralPath $Marker)) { [IO.File]::Delete($Marker) }
  foreach ($t in @($R.tasks)) {
    if (-not $t -or -not $t.disabled) { continue }
    $st = Get-ScheduledTask -TaskName $t.name -ErrorAction SilentlyContinue
    if ($st) { [void](Enable-ScheduledTask -TaskName $t.name -TaskPath $st.TaskPath) } else { Note-Problem ('task ' + $t.name + ' missing') }
  }
  $resumed = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); ok = ($script:Problems.Count -eq $before); by = 'recover.ps1' }
  $R | Add-Member -NotePropertyName resumed -NotePropertyValue $resumed -Force
  $json = ($R | ConvertTo-Json -Depth 8) -replace "`r`n", "`n"
  [IO.File]::WriteAllText($F.FullName, $json + "`n", $Utf8)
  Say ('resumed ' + $R.id + ' (stopped processes are not restarted; open the panes again)')
}

# ------------------------------------------------------------------ revert

function Invoke-Revert([string]$Tx) {
  $txRoot = Join-Path $ProfileDir 'tx'
  if (-not (Test-Path -LiteralPath $txRoot)) { Say 'nothing to undo'; return }
  if ($Tx -eq 'last') {
    $Tx = $null
    foreach ($d in (Get-ChildItem -LiteralPath $txRoot -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}-\d{3}$' } | Sort-Object Name)) {
      $rep = Read-JsonFile (Join-Path $d.FullName 'report.json')
      if ($rep -and $rep.ok -and -not (Test-Path -LiteralPath (Join-Path $d.FullName 'revert.json'))) { $Tx = $d.Name }
    }
    if (-not $Tx) { Say 'nothing to undo'; return }
  }
  if ($Tx -notmatch '^\d{8}-\d{6}-\d{3}$') { Note-Problem 'bad transaction id'; return }
  $dir = Join-Path $txRoot $Tx
  if (Test-Path -LiteralPath (Join-Path $dir 'revert.json')) { Note-Problem ('transaction ' + $Tx + ' is already reverted'); return }
  $journal = Join-Path $dir 'journal.jsonl'
  if (-not (Test-Path -LiteralPath $journal)) { Note-Problem ('no journal for ' + $Tx); return }
  $entries = @{}
  foreach ($line in [IO.File]::ReadAllLines($journal, $Utf8)) {
    if (-not $line.Trim()) { continue }
    try { $e = $line | ConvertFrom-Json } catch { continue }
    if ($e.done -and -not $e.op) { if ($entries.ContainsKey([int]$e.seq)) { $entries[[int]$e.seq] | Add-Member -NotePropertyName done -NotePropertyValue $true -Force }; continue }
    $entries[[int]$e.seq] = $e
  }
  $undone = 0; $flagged = New-Object System.Collections.ArrayList
  foreach ($seq in ($entries.Keys | Sort-Object -Descending)) {
    $e = $entries[$seq]
    $pre = $null
    if ($e.pre) { $pre = Join-Path $dir ('pre\' + $e.pre) }
    if ($e.op -eq 'write' -or $e.op -eq 'delete') {
      $cur = Get-Sha256 $e.abs
      $applied = ($e.op -eq 'delete' -and $null -eq $cur) -or ($e.op -eq 'write' -and $cur -eq $e.applied_sha)
      if (-not $e.done -and -not $applied) { continue }
      if (-not $applied) {
        [void]$flagged.Add($e.display + ': edited since the profile wrote it; kept')
        if ($pre -and -not $script:Dry) { [IO.File]::Copy($pre, ($e.abs + '.profile-removed'), $true) }
        continue
      }
      if ($script:Dry) { Say ('would restore ' + $e.display); continue }
      if ($pre) { Write-BytesAtomic $e.abs ([IO.File]::ReadAllBytes($pre)) }
      elseif ($null -ne $cur) { Send-ToRecycleBin $e.abs }
      foreach ($d in @($e.dirs)) { if ($d -and (Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { [IO.Directory]::Delete($d) } }
      $undone++
    } elseif ($e.op -eq 'rmdir') {
      if (-not $script:Dry) { [void](New-Item -ItemType Directory -Path $e.abs -Force) }
      $undone++
    } elseif ($e.op -eq 'git') {
      if ($script:Dry) { Say ('would restore git config ' + $e.key); continue }
      if ($e.prior -eq 'absent') { & git.exe -C $e.repo config --local --unset $e.key }
      else { $v = ([IO.File]::ReadAllText((Join-Path $dir ('pre\' + $e.prior)), $Utf8) | ConvertFrom-Json).v; & git.exe -C $e.repo config --local $e.key $v }
      $undone++
    } elseif ($e.op -eq 'task') {
      if ($script:Dry) { Say ('would restore the task ' + $e.name); continue }
      $t = Get-ScheduledTask -TaskName $e.name -ErrorAction SilentlyContinue
      if ($e.prior -eq 'absent') {
        if ($t) {
          [IO.File]::WriteAllText((Join-Path $dir ('pre\removed-' + $e.name + '.xml')), (Export-ScheduledTask -TaskName $e.name -TaskPath $t.TaskPath), $Utf8)
          Unregister-ScheduledTask -TaskName $e.name -TaskPath $t.TaskPath -Confirm:$false
        }
      } else {
        $xml = [IO.File]::ReadAllText((Join-Path $dir ('pre\' + $e.prior)), $Utf8)
        [void](Register-ScheduledTask -TaskName $e.name -Xml $xml -Force)
      }
      $undone++
    } elseif ($e.op -eq 'env') {
      [void]$flagged.Add('env ' + $e.name + ': restore it with: claude-console profile revert --tx ' + $Tx + ' --apply --yes (or set or delete it by hand under the user environment variables)')
    }
  }
  if (-not $script:Dry) {
    $rv = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); ok = ($flagged.Count -eq 0); flagged = @($flagged); by = 'recover.ps1' }
    [IO.File]::WriteAllText((Join-Path $dir 'revert.json'), ((($rv | ConvertTo-Json -Depth 4) -replace "`r`n", "`n") + "`n"), $Utf8)
  }
  Say ('reverted ' + $Tx + ': ' + $undone + ' change(s) undone, ' + $flagged.Count + ' kept and flagged')
  foreach ($f in $flagged) { Say ('kept: ' + $f) }
}

# ------------------------------------------------------------------ prompt

function Protect-Text([string]$Text) {
  $s = $Text
  foreach ($lit in @($DataDir, $InstallDir, $ConfigDir, $env:USERPROFILE) | Where-Object { $_ } | Sort-Object Length -Descending) {
    $s = $s.Replace($lit, '<PATH>').Replace($lit.Replace('\', '/'), '<PATH>')
  }
  $s = [regex]::Replace($s, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '<EMAIL>')
  $s = [regex]::Replace($s, '\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})', '<TOKEN>')
  $s = [regex]::Replace($s, '\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}', '<TOKEN>')
  $s = [regex]::Replace($s, '\b[0-9a-fA-F]{32,}\b', '<HEX>')
  $s = [regex]::Replace($s, '[A-Za-z]:\\Users\\[^\\\s"''<>]+', '<PATH>')
  foreach ($pair in @(@($env:USERNAME, '<USER>'), @($env:COMPUTERNAME, '<HOST>'))) {
    if ($pair[0] -and $pair[0].Length -ge 3) { $s = [regex]::Replace($s, '(?<![A-Za-z0-9])' + [regex]::Escape($pair[0]) + '(?![A-Za-z0-9])', $pair[1], 'IgnoreCase') }
  }
  return $s
}

function Invoke-Prompt {
  $L = New-Object System.Collections.ArrayList
  [void]$L.Add('I need help recovering my Claude Code setup. Claude Console (a local GUI for the Claude Code CLI) and its optional setup profile are installed, and the console itself does not start. Read everything below, tell me the most likely cause and give me the exact steps. Change nothing until I agree.')
  [void]$L.Add('')
  [void]$L.Add('## What is wrong')
  $logs = @()
  if (Test-Path -LiteralPath $RunDir) { foreach ($f in Get-ChildItem -LiteralPath $RunDir -Filter '*.log' | Sort-Object LastWriteTime) { $logs += @(Get-Content -LiteralPath $f.FullName -Tail 400 | Where-Object { $_ -match 'error|fail|exception|refused|denied' }) } }
  if ($logs.Count) { foreach ($l in ($logs | Select-Object -Last 20)) { [void]$L.Add('- log: ' + $l) } } else { [void]$L.Add('- (no error lines in the console logs; describe what you see)') }
  [void]$L.Add('')
  [void]$L.Add('## Environment')
  [void]$L.Add('- Windows ' + [Environment]::OSVersion.Version.ToString() + ', PowerShell ' + $PSVersionTable.PSVersion.ToString())
  [void]$L.Add('')
  [void]$L.Add('## Relevant config (key names and hooks only; values masked)')
  $files = @(@('user settings', (Join-Path $ConfigDir 'settings.json')))
  foreach ($r in Get-Targets) { $files += ,@(('repo ' + (Split-Path -Leaf $r)), (Join-Path $r '.claude\settings.json')) }
  foreach ($pair in $files) {
    $j = Read-JsonFile $pair[1]
    if (-not $j) { [void]$L.Add('- ' + $pair[0] + ': none or unreadable'); continue }
    [void]$L.Add('- ' + $pair[0] + ': keys ' + (($j.PSObject.Properties | ForEach-Object { $_.Name }) -join ', '))
    $h = $j.hooks
    if (-not $h) { $h = $j.'hooks.profile-disabled' }
    if ($h) { foreach ($ev in $h.PSObject.Properties) { foreach ($g in @($ev.Value)) { foreach ($x in @($g.hooks)) { if ($x.command) { [void]$L.Add('  - hook ' + $ev.Name + ': ' + (Split-Path -Leaf (($x.command -split '\s+')[0] -replace '"', ''))) } } } } }
  }
  if (Test-Path -LiteralPath $Marker) { [void]$L.Add('- the hooks-off marker is present: profile hooks exit silently') }
  [void]$L.Add('')
  [void]$L.Add('## Profile transactions (newest last)')
  $txRoot = Join-Path $ProfileDir 'tx'
  $txs = @()
  if (Test-Path -LiteralPath $txRoot) { $txs = @(Get-ChildItem -LiteralPath $txRoot -Directory | Where-Object { $_.Name -match '^\d{8}-\d{6}-\d{3}$' } | Sort-Object Name | Select-Object -Last 5) }
  foreach ($d in $txs) {
    $rep = Read-JsonFile (Join-Path $d.FullName 'report.json')
    $state = 'no report'
    if ($rep) { if ($rep.ok) { $state = 'applied, ' + @($rep.written).Count + ' write(s)' } else { $state = 'failed and rolled back' } }
    if (Test-Path -LiteralPath (Join-Path $d.FullName 'revert.json')) { $state += ', reverted' }
    [void]$L.Add('- ' + $d.Name + ': ' + $state)
  }
  if (-not $txs.Count) { [void]$L.Add('- none') }
  [void]$L.Add('')
  [void]$L.Add('## Undo steps (in this order; each is safe to repeat)')
  [void]$L.Add('1. recover.ps1 -Stop -DisableHooks -PauseTasks')
  [void]$L.Add('2. recover.ps1 -Revert last')
  [void]$L.Add('3. By hand, if both fail: in the console data folder, profile\tx\<newest>\pre\ holds the previous copy of every file the profile changed (journal.jsonl names each one).')
  [void]$L.Add('4. Later: recover.ps1 -Resume turns hooks and tasks back on.')
  $text = Protect-Text (($L -join "`n") + "`n")
  if ($script:Dry) { Say ('would write the recovery prompt (' + $text.Length + ' chars), copy it and open claude.ai/new'); return }
  [void](New-Item -ItemType Directory -Path $ProfileDir -Force)
  $file = Join-Path $ProfileDir ('recover-prompt-' + (New-Stamp) + '.txt')
  [IO.File]::WriteAllText($file, $text, $Utf8)
  Set-Clipboard -Value $text
  Start-Process 'https://claude.ai/new'
  Say ('recovery prompt copied (' + (Split-Path -Leaf $file) + ' in the profile folder); paste it into the new chat at claude.ai')
}

# ------------------------------------------------------------------ main

if (-not ($Stop -or $DisableHooks -or $PauseTasks -or $Resume -or $Revert -or $Prompt)) {
  Say 'Claude Console - Recover. Pick one or more: -Stop -DisableHooks -PauseTasks -Resume -Revert last -Prompt (add -WhatIf to look first).'
  exit 0
}
if (-not (Test-Path -LiteralPath $DataDir) -and -not $Stop -and -not $Prompt) { Say 'nothing to undo (no console data folder)'; exit 0 }
try {
  if ($Stop) { Invoke-StopProcesses; Invoke-KillSwitchOff }
  if ($PauseTasks) { Invoke-PauseTasks }
  if ($DisableHooks) { Invoke-DisableHooks }
  if ($Stop -or $PauseTasks -or $DisableHooks) { if (-not $script:Dry) { Complete-Stop } }
  if ($Resume) { Invoke-Resume }
  if ($Revert) { Invoke-Revert $Revert }
  if ($Prompt) { Invoke-Prompt }
} catch {
  Note-Problem ($_.Exception.Message)
}
if ($script:Problems.Count) { exit 1 }
exit 0
