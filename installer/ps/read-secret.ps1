# Claude Console setup profile: secret reference reader.
# A consumer's {"command": [...]} secret reference runs this file; it prints the
# secret on STDOUT with no newline and nothing else, so the caller's reference
# resolver (kit secrets) receives the value at use time. Errors name the
# reference, never the value. DPAPI scope: the current Windows user.
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Dir
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

if ($Name -cnotmatch '^[a-z][a-z0-9_-]{0,63}$') { [Console]::Error.WriteLine('secret reference: bad name'); exit 2 }
$file = Join-Path $Dir ($Name + '.dpapi')
if (-not (Test-Path -LiteralPath $file)) { [Console]::Error.WriteLine('secret reference ' + $Name + ': not set'); exit 1 }
try {
    $ss = ConvertTo-SecureString -String (([System.IO.File]::ReadAllText($file)).Trim())
} catch {
    [Console]::Error.WriteLine('secret reference ' + $Name + ': unreadable for this user'); exit 1
}
$b = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
try {
    $out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding $false))
    $out.Write([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))
    $out.Flush()
} finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
