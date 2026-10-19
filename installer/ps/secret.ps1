# Claude Console setup profile: DPAPI secret store writer and checker.
# Called by installer/profile-secrets.js through an injected runner; tests never
# run this file. DPAPI scope: the current Windows user (ConvertFrom-SecureString).
#
#   CC_SECRET_OP    put | check
#   CC_SECRET_FILE  <dataDir>/profile/secrets/<name>.dpapi
# put: the value arrives on STDIN only and is written atomically (temp + rename).
# check: decrypts the file in memory to prove it reads back.
# Output is ONE JSON line holding ok, length and sha256 - never the value.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Write-Result($o) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
}

function Get-Sha([string]$s) {
    $h = [System.Security.Cryptography.SHA256]::Create()
    $bytes = $h.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($s))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

$file = [string]$env:CC_SECRET_FILE
if (-not $file -or -not [System.IO.Path]::IsPathRooted($file) -or -not $file.EndsWith('.dpapi')) {
    Write-Result @{ error = 'bad secret file' }; exit 2
}

switch ([string]$env:CC_SECRET_OP) {
    'put' {
        $reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding $false))
        $v = $reader.ReadToEnd()
        if ($v.Length -eq 0) { Write-Result @{ error = 'empty value' }; exit 2 }
        $dir = [System.IO.Path]::GetDirectoryName($file)
        if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
        $ss = ConvertTo-SecureString -String $v -AsPlainText -Force
        $tmp = $file + '.tmp'
        [System.IO.File]::WriteAllText($tmp, (ConvertFrom-SecureString -SecureString $ss), [System.Text.Encoding]::ASCII)
        Move-Item -LiteralPath $tmp -Destination $file -Force
        Write-Result @{ ok = $true; length = $v.Length; sha256 = (Get-Sha $v) }
    }
    'check' {
        if (-not (Test-Path -LiteralPath $file)) { Write-Result @{ ok = $false }; exit 0 }
        $ss = ConvertTo-SecureString -String (([System.IO.File]::ReadAllText($file)).Trim())
        $b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
        try {
            $v = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)
            Write-Result @{ ok = $true; length = $v.Length; sha256 = (Get-Sha $v) }
        } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    }
    default { Write-Result @{ error = 'bad op' }; exit 2 }
}
