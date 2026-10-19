# Claude Console installer for Windows 10 / 11.
#
#   irm https://github.com/Remus3/claude-console/releases/latest/download/install.ps1 | iex
#
# What it does, in order (a re-run upgrades or repairs; nothing else on the box changes):
#   1. Node.js LTS: kept when Node 24+ is on PATH, else installed with winget
#      (OpenJS.NodeJS.LTS), falling back to the official nodejs.org MSI (SHA-256 checked).
#   2. Git: kept when present, else installed with winget (Git.Git), falling back to the
#      official Git for Windows release (silent), SHA-256 checked against the hash its
#      GitHub release publishes.
#   3. Downloads the latest release zip and checks it against the release's SHA256SUMS.txt
#      (https://github.com/<repo>/releases/latest/download/SHA256SUMS.txt names the zip).
# Every download is checked against a SHA-256 its publisher posts; when no hash can be
# got, nothing is installed and one line names the manual download page.
# If Node.js or Git is missing and winget is unavailable, Windows will ask for permission
# once to install it.
#   4. Installs to %LOCALAPPDATA%\Programs\claude-console (npm ci --omit=dev, a self-test,
#      Start-menu + Desktop shortcuts, an Apps & features entry, `claude-console` on your
#      user PATH, updates from Remus3/claude-console).
#   5. Starts the console.
# A missing Claude Code CLI never stops the install; it prints the one command to get it.
#
# Do not want to run a remote script? Download install.ps1, the release zip and
# SHA256SUMS.txt into one folder, read the script, then run it locally:  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Zip .\claude-console-<version>.zip
param(
  [string]$Repo = 'Remus3/claude-console',
  [string]$Zip = '',
  [string]$Sums = '',
  [string]$InstallDir = '',
  [switch]$NoLaunch,
  [switch]$NoShortcuts
)

function Install-ClaudeConsole {
  param([string]$Repo, [string]$Zip, [string]$Sums, [string]$InstallDir, [bool]$NoLaunch, [bool]$NoShortcuts)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\claude-console' }
  $work = Join-Path $env:TEMP ('claude-console-install-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $work | Out-Null

  function Say([string]$m) { Write-Host ('[claude-console] ' + $m) }
  function RefreshPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
  function IsAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  function HasWinget { return [bool](Get-Command winget.exe -ErrorAction SilentlyContinue) }
  function Get-File([string]$url, [string]$out) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -Headers @{ 'User-Agent' = 'claude-console-installer' }
  }
  function Sha([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
  function Run-Elevated([string]$file, [string]$argLine) {
    if (IsAdmin) { $p = Start-Process -FilePath $file -ArgumentList $argLine -Wait -PassThru }
    else { $p = Start-Process -FilePath $file -ArgumentList $argLine -Wait -PassThru -Verb RunAs }
    return $p.ExitCode
  }
  function Find-Node {
    $c = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $f = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $f) { return $f }
    return $null
  }
  function Node-Major([string]$node) {
    try { $v = (& $node --version) 2>$null; if ($v -match '^v(\d+)\.') { return [int]$Matches[1] } } catch { }
    return 0
  }

  # ---- 1. Node.js LTS
  $node = Find-Node
  if (-not $node -or (Node-Major $node) -lt 24) {
    if ($node) { Say ('Node.js ' + ((& $node --version) 2>$null) + ' is too old (24+ needed): installing the LTS.') }
    else { Say 'Node.js not found: installing the LTS.' }
    $done = $false
    if (HasWinget) {
      Say 'winget install OpenJS.NodeJS.LTS'
      & winget.exe install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
      RefreshPath
      $node = Find-Node
      $done = [bool]($node -and (Node-Major $node) -ge 24)
    }
    if (-not $done) {
      $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
      $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
      $lts = $index | Where-Object { $_.lts -and ([int]($_.version -replace '^v(\d+)\..*$', '$1')) -ge 24 } | Select-Object -First 1
      if (-not $lts) { throw 'no Node.js LTS release found at nodejs.org' }
      $ver = $lts.version
      $msiName = 'node-' + $ver + '-' + $arch + '.msi'
      Say ('nodejs.org MSI ' + $msiName)
      $msi = Join-Path $work $msiName
      Get-File ('https://nodejs.org/dist/' + $ver + '/' + $msiName) $msi
      $shaTxt = Join-Path $work 'SHASUMS256.txt'
      Get-File ('https://nodejs.org/dist/' + $ver + '/SHASUMS256.txt') $shaTxt
      $want = $null
      foreach ($l in (Get-Content -LiteralPath $shaTxt)) { if ($l -match ('^([0-9a-f]{64})\s+' + [regex]::Escape($msiName) + '$')) { $want = $Matches[1] } }
      if (-not $want) { Say ('no SHA-256 for ' + $msiName + ' in its SHASUMS256.txt; not installed. Install Node.js 24+ LTS from https://nodejs.org and run this again.'); return }
      if ((Sha $msi) -ne $want) { throw ('Node.js MSI checksum mismatch: ' + $msiName) }
      $code = Run-Elevated 'msiexec.exe' ('/i "' + $msi + '" /qn /norestart')
      if ($code -ne 0 -and $code -ne 3010) { throw ('Node.js MSI failed, msiexec exit ' + $code) }
      RefreshPath
      $node = Find-Node
    }
    if (-not $node -or (Node-Major $node) -lt 24) { throw 'Node.js 24+ is still not available. Install the LTS from https://nodejs.org and run this again.' }
  }
  Say ('Node.js ' + ((& $node --version) 2>$null) + ' at ' + $node)

  # ---- 2. Git
  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Say 'Git not found: installing Git for Windows.'
    if (HasWinget) {
      Say 'winget install Git.Git'
      & winget.exe install --id Git.Git -e --silent --accept-source-agreements --accept-package-agreements | Out-Host
      RefreshPath
    }
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
      $rel = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'claude-console-installer' }
      $pat = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { '^Git-[\d.]+-arm64\.exe$' } else { '^Git-[\d.]+-64-bit\.exe$' }
      $asset = $rel.assets | Where-Object { $_.name -match $pat } | Select-Object -First 1
      if (-not $asset) { throw 'no Git for Windows installer found in its latest release' }
      Say ('Git for Windows ' + $asset.name)
      # The SHA-256 its release publishes: the release notes' hash table, else a .sha256 asset.
      $gitSha = $null
      if ([string]$rel.body -match ([regex]::Escape($asset.name) + '\s*\|\s*([0-9a-fA-F]{64})')) { $gitSha = $Matches[1].ToLowerInvariant() }
      if (-not $gitSha) {
        $shaAsset = $rel.assets | Where-Object { $_.name -eq ($asset.name + '.sha256') } | Select-Object -First 1
        if ($shaAsset) {
          $shaFile = Join-Path $work ($asset.name + '.sha256')
          Get-File $shaAsset.browser_download_url $shaFile
          if ((Get-Content -LiteralPath $shaFile -Raw) -match '\b([0-9a-fA-F]{64})\b') { $gitSha = $Matches[1].ToLowerInvariant() }
        }
      }
      if (-not $gitSha) { Say ('no published SHA-256 for ' + $asset.name + '; not installed. Install Git from https://git-scm.com/download/win and run this again.'); return }
      $exe = Join-Path $work $asset.name
      Get-File $asset.browser_download_url $exe
      if ((Sha $exe) -ne $gitSha) { throw ('Git installer checksum mismatch: ' + $asset.name) }
      $code = Run-Elevated $exe '/VERYSILENT /NORESTART /NOCANCEL /SP- /SUPPRESSMSGBOXES'
      if ($code -ne 0) { throw ('Git installer failed, exit ' + $code) }
      RefreshPath
    }
    if (Get-Command git.exe -ErrorAction SilentlyContinue) { Say ((& git.exe --version) 2>$null) }
    else { Say 'Git is still not available; installing anyway (projects show without git status).' }
  }

  # ---- 3. The release zip, checked against SHA256SUMS.txt
  $base = 'https://github.com/' + $Repo + '/releases/latest/download/'
  if ($Zip) {
    $zipFile = (Resolve-Path -LiteralPath $Zip).Path
    if (-not $Sums) { $near = Join-Path (Split-Path -Parent $zipFile) 'SHA256SUMS.txt'; if (Test-Path -LiteralPath $near) { $Sums = $near } }
  } else {
    $Sums = Join-Path $work 'SHA256SUMS.txt'
    Say ('download ' + $base + 'SHA256SUMS.txt')
    Get-File ($base + 'SHA256SUMS.txt') $Sums
    $zipName = $null
    foreach ($l in (Get-Content -LiteralPath $Sums)) { if ($l -match '^[0-9a-f]{64}\s+\*?(claude-console-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.zip)\s*$') { $zipName = $Matches[1] } }
    if (-not $zipName) { throw 'SHA256SUMS.txt names no claude-console zip' }
    $zipFile = Join-Path $work $zipName
    Say ('download ' + $zipName)
    Get-File ($base + $zipName) $zipFile
  }
  $zipLeaf = Split-Path -Leaf $zipFile
  $relPage = 'https://github.com/' + $Repo + '/releases/latest'
  if (-not $Sums) { Say ('no SHA256SUMS.txt next to ' + $zipLeaf + '; not installed. Download it with the zip from https://github.com/' + $Repo + '/releases/latest and run this again.'); return }
  $want = $null
  foreach ($l in (Get-Content -LiteralPath $Sums)) { if ($l -match ('^([0-9a-f]{64})\s+\*?' + [regex]::Escape($zipLeaf) + '\s*$')) { $want = $Matches[1] } }
  if (-not $want) { Say ('SHA256SUMS.txt has no line for ' + $zipLeaf + '; not installed. Download both from ' + $relPage + ' and run this again.'); return }
  if ((Sha $zipFile) -ne $want) { throw ('checksum mismatch for ' + $zipLeaf + ': the download is damaged or not the release') }
  Say ('SHA-256 ok: ' + $zipLeaf)
  $unz = Join-Path $work 'unzip'
  Expand-Archive -LiteralPath $zipFile -DestinationPath $unz -Force
  $src = Get-ChildItem -LiteralPath $unz -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'bin\claude-console.js') } | Select-Object -First 1
  if ($src) { $src = $src.FullName } elseif (Test-Path -LiteralPath (Join-Path $unz 'bin\claude-console.js')) { $src = $unz } else { throw 'the zip holds no claude-console release' }

  # ---- 4. Install (or upgrade / repair) with the release's own installer
  $cliArgs = @((Join-Path $src 'bin\claude-console.js'), 'install', '--source', $src, '--home', $InstallDir, '--repo', $Repo, '--ignore-prereqs')
  if ($NoShortcuts) { $cliArgs += '--no-shortcuts' }
  Say ('install to ' + $InstallDir + ' (npm ci --omit=dev and a self-test; about a minute)')
  & $node @cliArgs | Out-Host
  if ($LASTEXITCODE -ne 0) { throw ('install failed (exit ' + $LASTEXITCODE + '); see the lines above and ' + (Join-Path $InstallDir 'reports')) }
  RefreshPath
  $cmd = Join-Path $InstallDir 'claude-console.cmd'
  Say ('command: claude-console (new terminals), or ' + $cmd)

  # ---- 5. Claude Code CLI check, then start
  $claude = Get-Command claude.exe -ErrorAction SilentlyContinue
  if (-not $claude -and -not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.local\bin\claude.exe'))) {
    Say 'Claude Code CLI not found - install it with: irm https://claude.ai/install.ps1 | iex'
  }
  if (-not $NoLaunch) {
    Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $InstallDir 'launch.vbs') + '"')
    Say 'started: the console opens in its own window (Start menu / Desktop: Claude Console)'
  }
  try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } catch { }
}

try {
  Install-ClaudeConsole -Repo $Repo -Zip $Zip -Sums $Sums -InstallDir $InstallDir -NoLaunch ([bool]$NoLaunch) -NoShortcuts ([bool]$NoShortcuts)
} catch {
  Write-Host ('[claude-console] install stopped: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host '[claude-console] Fix the cause and run the same command again; a re-run picks up where it stopped.'
}
