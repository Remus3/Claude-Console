# CON-RES: resource sampler for the top-bar readout (server/resources.js).
# READ ONLY: it reads performance counters and writes one JSON line per sample to
# stdout; it changes nothing on the machine. One long-lived process (no spawn per
# poll); it exits when its parent (the console server) is gone or stdout closes.
# Output carries numbers and drive letters only: never a machine, adapter or GPU
# name, never a process id.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  '\Processor Information(_Total)\% Processor Utility',
  '\GPU Engine(*)\Utilization Percentage',
  '\PhysicalDisk(*)\% Idle Time',
  '\Network Interface(*)\Bytes Received/sec',
  '\Network Interface(*)\Bytes Sent/sec',
  '\Network Interface(*)\Current Bandwidth'
)
$inv = [System.Globalization.CultureInfo]::InvariantCulture
function Num($v) { if ($null -eq $v) { return 'null' } return ([double]$v).ToString('0.##', $inv) }
while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  $s = Get-Counter -Counter $paths -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
  $cpu = $null
  $eng = @{}
  $disks = New-Object System.Collections.ArrayList
  $nic = @{}
  if ($s) {
    foreach ($c in $s.CounterSamples) {
      $p = $c.Path.ToLowerInvariant()
      $inst = $c.InstanceName
      $v = $c.CookedValue
      if ($p.EndsWith('\% processor utility')) { $cpu = $v }
      elseif ($p.EndsWith('\utilization percentage')) {
        # Task Manager: per GPU, the busiest engine; an engine's load is the sum
        # over the processes using it (instance pid_N_luid_X_Y_phys_P_eng_E_engtype_T).
        $k = $inst -replace '^pid_\d+_', ''
        if ($eng.ContainsKey($k)) { $eng[$k] += $v } else { $eng[$k] = $v }
      }
      elseif ($p.EndsWith('\% idle time')) {
        if ($inst -ne '_total') {
          $letters = ([regex]::Matches($inst, '([a-z]):') | ForEach-Object { $_.Groups[1].Value.ToUpperInvariant() }) -join ''
          if ($letters) { [void]$disks.Add('{"l":"' + $letters + '","a":' + (Num (100 - $v)) + '}') }
        }
      }
      elseif ($p.Contains('\network interface(')) {
        if (-not $nic.ContainsKey($inst)) { $nic[$inst] = @{ rx = 0.0; tx = 0.0; bw = 0.0 } }
        if ($p.EndsWith('\bytes received/sec')) { $nic[$inst].rx = $v }
        elseif ($p.EndsWith('\bytes sent/sec')) { $nic[$inst].tx = $v }
        elseif ($p.EndsWith('\current bandwidth')) { $nic[$inst].bw = $v }
      }
    }
  }
  $gpu = $null
  if ($s) {
    $gpu = 0.0
    foreach ($x in $eng.Values) { if ($x -gt $gpu) { $gpu = $x } }
  }
  $net = 'null'
  $best = -1.0
  foreach ($n in $nic.Values) {
    if ($n.bw -le 0) { continue }
    $pct = ($n.rx + $n.tx) * 8 * 100 / $n.bw
    if ($pct -gt $best) {
      $best = $pct
      $net = '{"pct":' + (Num $pct) + ',"rx":' + (Num $n.rx) + ',"tx":' + (Num $n.tx) + ',"bw":' + (Num $n.bw) + '}'
    }
  }
  $line = '{"cpu":' + (Num $cpu) + ',"gpu":' + (Num $gpu) + ',"disks":[' + ($disks -join ',') + '],"net":' + $net + '}'
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() } catch { break }
  if (-not $s) { Start-Sleep -Seconds 2 }
}
